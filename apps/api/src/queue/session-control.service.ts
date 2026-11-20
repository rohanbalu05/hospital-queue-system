import { Inject, Injectable } from '@nestjs/common';
import { deriveAvailability, type ReopenSessionRequest, type Session, type SessionStatus } from '@hqms/contracts';
import {
  bumpQueueVersion,
  getPolicyById,
  getSession,
  lockDoctor,
  lockSession,
  required,
  writeAudit,
  writeOutbox,
  type IdempotentResult,
  type Pool,
} from '@hqms/db';
import { CLOCK, DB_POOL } from '../common/tokens.js';
import type { Clock } from '../common/clock.js';
import { conflict, notFound, validationFailed } from '../common/errors.js';
import type { RequestCtx } from '../common/request-context.js';
import { AccessPolicy } from '../access/access-policy.service.js';
import { runCommand } from './command.js';
import type { MarkUnavailableRequestDto, PauseSessionRequestDto } from './dto.js';

type Command = 'open' | 'pause' | 'resume' | 'unavailable' | 'close' | 'reopen';

/** Session status machine (kept here: the domain package has no session lifecycle). */
const ALLOWED: Record<Command, { from: SessionStatus[]; to: SessionStatus }> = {
  open: { from: ['scheduled'], to: 'open' },
  // "Step away": also allowed while already away, to update the expected return (D-032).
  pause: { from: ['open', 'paused'], to: 'paused' },
  resume: { from: ['paused'], to: 'open' },
  unavailable: { from: ['scheduled', 'open', 'paused'], to: 'unavailable' },
  close: { from: ['scheduled', 'open', 'paused', 'unavailable'], to: 'closed' },
  // PR-30 (admin only): undo a mistaken "unavailable"; the route also refuses once the session has ended.
  reopen: { from: ['unavailable'], to: 'open' },
};

const VERB: Record<Command, string> = {
  open: 'opened',
  pause: 'paused',
  resume: 'resumed',
  unavailable: 'marked unavailable',
  close: 'closed',
  reopen: 'reopened',
};

const EVENT: Partial<Record<Command, 'SessionPaused' | 'SessionResumed' | 'SessionUnavailable'>> = {
  pause: 'SessionPaused',
  resume: 'SessionResumed',
  unavailable: 'SessionUnavailable',
  // A reopened session tells patients the doctor is available again (payload.reopened = true).
  reopen: 'SessionResumed',
};

@Injectable()
export class SessionControlService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AccessPolicy) private readonly access: AccessPolicy,
  ) {}

  open(ctx: RequestCtx, id: string, key: string | undefined) {
    return this.run(ctx, id, 'open', key, {});
  }

  /**
   * "Step away" (D-032). `until` omitted = unknown duration: the ETA is withheld rather than guessed (FR-10-a).
   * Allowed from open and, to update the expected return, from paused.
   */
  pause(ctx: RequestCtx, id: string, body: PauseSessionRequestDto, key: string | undefined) {
    return this.run(ctx, id, 'pause', key, body);
  }

  resume(ctx: RequestCtx, id: string, key: string | undefined) {
    return this.run(ctx, id, 'resume', key, {});
  }

  /** Waiting patients are NOT reassigned: they stay in the session for reception to arrange alternatives. */
  unavailable(ctx: RequestCtx, id: string, body: MarkUnavailableRequestDto, key: string | undefined) {
    return this.run(ctx, id, 'unavailable', key, body);
  }

  /**
   * PR-30: admin-only undo of "unavailable". Same command path and lock order as the other controls. Patients already
   * moved to other doctors stay moved; everyone still in the session is told the doctor is available again.
   */
  reopen(ctx: RequestCtx, id: string, body: ReopenSessionRequest, key: string | undefined) {
    return this.run(ctx, id, 'reopen', key, body);
  }

  /** Waiting entries stay visible after close; nothing is deleted. */
  close(ctx: RequestCtx, id: string, key: string | undefined) {
    return this.run(ctx, id, 'close', key, {});
  }

  private async run(
    ctx: RequestCtx,
    id: string,
    command: Command,
    key: string | undefined,
    body: { until?: string; reason?: string },
  ): Promise<IdempotentResult<Session>> {
    const { user } = ctx;
    const pre = await getSession(this.pool, id);
    if (!pre) throw notFound('Session');
    this.access.assertDoctorScope(user, pre.doctorId);

    return runCommand(this.pool, ctx, `session.${command}`, key, { id, body }, async (tx) => {
      await lockDoctor(tx, pre.doctorId);
      const session = await lockSession(tx, id);
      const rule = ALLOWED[command];
      if (!rule.from.includes(session.status)) {
        throw conflict('INVALID_TRANSITION', `A ${session.status} session cannot be ${VERB[command]}`, {
          machine: 'session',
          from: session.status,
          to: rule.to,
        });
      }
      const now = this.clock.now();
      if (command === 'reopen' && !(now.getTime() < new Date(session.endsAt).getTime())) {
        throw conflict('INVALID_TRANSITION', 'The session has already ended and cannot be reopened', {
          machine: 'session',
          from: session.status,
          to: rule.to,
          endsAt: new Date(session.endsAt).toISOString(),
        });
      }
      const isUpdate = command === 'pause' && session.status === 'paused';
      let pauseUntil: Date | null = null;
      if (command === 'pause' && body.until !== undefined) {
        pauseUntil = new Date(body.until);
        if (!(pauseUntil.getTime() > now.getTime())) throw validationFailed('`until` must be in the future');
        if (pauseUntil.getTime() > new Date(session.endsAt).getTime()) {
          throw validationFailed('The expected return is after the session ends. Mark the doctor unavailable instead.');
        }
      }
      if (command === 'pause') {
        // The called patient would be skipped by the 2-minute timeout while the doctor is away (the doctor lock is
        // held, so nobody can call between this check and the update). A patient already in service is fine.
        const called = await tx.query(`SELECT 1 FROM queue_entries WHERE doctor_id = $1 AND state = 'called' LIMIT 1`, [
          session.doctorId,
        ]);
        if ((called.rowCount ?? 0) > 0) {
          throw conflict('DOCTOR_OCCUPIED', 'A patient has been called and has not started yet. Start or skip the called patient first.');
        }
      }
      const policy = required(await getPolicyById(tx, session.policyId), 'policy');

      if (command === 'pause') {
        // An update keeps the original paused_at (when the doctor first stepped away) and, without a new reason, the old one.
        await tx.query(
          `UPDATE sessions SET status = $2, paused_at = COALESCE(paused_at, $3), pause_until = $4,
                  pause_reason = CASE WHEN $6::boolean THEN COALESCE($5, pause_reason) ELSE $5 END,
                  version = version + 1, updated_at = now() WHERE id = $1`,
          [id, rule.to, now, pauseUntil, body.reason ?? null, isUpdate],
        );
      } else if (command === 'unavailable') {
        await tx.query(
          `UPDATE sessions SET status = $2, paused_at = $3, pause_until = NULL, pause_reason = $4,
                  version = version + 1, updated_at = now() WHERE id = $1`,
          [id, rule.to, now, body.reason ?? null],
        );
      } else {
        await tx.query(
          `UPDATE sessions SET status = $2, paused_at = NULL, pause_until = NULL, pause_reason = NULL,
                  version = version + 1, updated_at = now() WHERE id = $1`,
          [id, rule.to],
        );
      }
      const queueVersion = await bumpQueueVersion(tx, id);
      await writeAudit(tx, {
        actorId: user.userId,
        actorRole: user.role,
        operation: `session.${command}`,
        entityType: 'session',
        entityId: id,
        previous: {
          status: session.status,
          pauseUntil: session.pauseUntil === null ? null : new Date(session.pauseUntil).toISOString(),
        },
        next: { status: rule.to, pauseUntil: pauseUntil?.toISOString() ?? null, queueVersion, update: isUpdate },
        reason: body.reason ?? null,
        policyVersion: policy.version,
        correlationId: ctx.correlationId,
      });
      const eventType = EVENT[command];
      if (eventType) {
        // Routing data only: never the free-text reason (it stays in the audit row). The worker builds notices from this.
        await writeOutbox(tx, {
          eventType,
          entityType: 'session',
          entityId: id,
          entityVersion: session.version + 1,
          sessionId: id,
          payload: {
            queueVersion,
            status: rule.to,
            pauseUntil: pauseUntil?.toISOString() ?? null,
            update: isUpdate,
            doctorId: session.doctorId,
            ...(command === 'reopen' ? { reopened: true } : {}),
          },
        });
      }
      const view = required(await getSession(tx, id), 'session');
      const row = required(
        (
          await tx.query<{ status: SessionStatus; ends_at: string; paused_at: string | null; pause_until: string | null; pause_reason: string | null }>(
            `SELECT status, ends_at, paused_at, pause_until, pause_reason FROM sessions WHERE id = $1`,
            [id],
          )
        ).rows[0],
        'session',
      );
      const availability = deriveAvailability(
        { status: row.status, endsAt: row.ends_at, pausedAt: row.paused_at, pauseUntil: row.pause_until, pauseReason: row.pause_reason },
        now,
        { includeReason: true }, // staff-only response
      );
      return { status: 200, body: { ...view, availability } };
    });
  }
}
