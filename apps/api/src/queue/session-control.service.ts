import { Inject, Injectable } from '@nestjs/common';
import type { Session, SessionStatus } from '@hqms/contracts';
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

type Command = 'open' | 'pause' | 'resume' | 'unavailable' | 'close';

/** Session status machine (kept here: the domain package has no session lifecycle). */
const ALLOWED: Record<Command, { from: SessionStatus[]; to: SessionStatus }> = {
  open: { from: ['scheduled'], to: 'open' },
  pause: { from: ['open'], to: 'paused' },
  resume: { from: ['paused'], to: 'open' },
  unavailable: { from: ['scheduled', 'open', 'paused'], to: 'unavailable' },
  close: { from: ['scheduled', 'open', 'paused', 'unavailable'], to: 'closed' },
};

const VERB: Record<Command, string> = {
  open: 'opened',
  pause: 'paused',
  resume: 'resumed',
  unavailable: 'marked unavailable',
  close: 'closed',
};

const EVENT: Partial<Record<Command, 'SessionPaused' | 'SessionResumed' | 'SessionUnavailable'>> = {
  pause: 'SessionPaused',
  resume: 'SessionResumed',
  unavailable: 'SessionUnavailable',
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

  /** `until` omitted = unknown duration: the ETA is withheld rather than guessed (FR-10-a). */
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
      let pauseUntil: Date | null = null;
      if (command === 'pause' && body.until !== undefined) {
        pauseUntil = new Date(body.until);
        if (!(pauseUntil.getTime() > now.getTime())) throw validationFailed('`until` must be in the future');
      }
      const policy = required(await getPolicyById(tx, session.policyId), 'policy');

      if (command === 'pause' || command === 'unavailable') {
        await tx.query(
          `UPDATE sessions SET status = $2, paused_at = $3, pause_until = $4, pause_reason = $5,
                  version = version + 1, updated_at = now() WHERE id = $1`,
          [id, rule.to, now, pauseUntil, body.reason ?? null],
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
        previous: { status: session.status, pauseUntil: session.pauseUntil },
        next: { status: rule.to, pauseUntil: pauseUntil?.toISOString() ?? null, queueVersion },
        reason: body.reason ?? null,
        policyVersion: policy.version,
        correlationId: ctx.correlationId,
      });
      const eventType = EVENT[command];
      if (eventType) {
        await writeOutbox(tx, {
          eventType,
          entityType: 'session',
          entityId: id,
          entityVersion: session.version + 1,
          sessionId: id,
          payload: { queueVersion, status: rule.to, pauseUntil: pauseUntil?.toISOString() ?? null },
        });
      }
      return { status: 200, body: required(await getSession(tx, id), 'session') };
    });
  }
}
