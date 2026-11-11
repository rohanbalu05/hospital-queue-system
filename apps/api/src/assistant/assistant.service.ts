import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AskAssistantRequest, AssistantAnswer, AssistantConversation, ConversationMessage } from '@hqms/contracts';
import { findIdempotencyRecord, hashRequest, withTransaction, writeAudit, writeOutbox, type Pool, type Tx } from '@hqms/db';
import { deniedIntent } from '@hqms/providers';
import { PatientScope } from '../access/patient-scope.service.js';
import type { Clock } from '../common/clock.js';
import type { AppConfig } from '../common/config.js';
import { conflict, notFound, rateLimited } from '../common/errors.js';
import type { RequestCtx } from '../common/request-context.js';
import { APP_CONFIG, CLOCK, DB_POOL, LLM_PROVIDER } from '../common/tokens.js';
import { currentContextOf } from '../documents/documents.repo.js';
import { pickOwner } from '../followup/followup.repo.js';
import type { LlmAnswer, LlmContextItem, LlmProvider } from '../providers/ports.js';

/** The patient hears back within this long when a question is escalated (FR-14). */
export const ESCALATION_DUE_HOURS = 24;

/** "by 3:30 pm, 12 Nov" in hospital-local time (the patient never sees UTC). */
export function formatDue(at: Date, timeZone: string): string {
  const time = new Intl.DateTimeFormat('en-IN', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(at)
    .toLowerCase()
    .replace(/ /g, ' ');
  const day = new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' }).format(at);
  return `${time}, ${day}`;
}

const ESCALATION_TEXT = (due: string | null) =>
  due === null
    ? `I can't answer this from your verified instructions. A member of the care team will follow up with you soon.`
    : `I can't answer this from your verified instructions. A member of the care team will follow up with you by ${due}.`;

/**
 * FR-14 bounded assistant. Deliberately imports nothing from scheduling, arrivals or queue: it has no code path to
 * bookings, treatment or priority. Its whole effect is rows in conversations / messages and, when it cannot
 * answer, ONE owned follow-up task for staff (a patient with several open questions shares the latest task).
 *
 *  1. the provider-independent deny-list (diagnosis, dose change, stopping or starting a medicine, priority or
 *     urgency, booking or cancelling) runs FIRST: such a question never reaches a provider;
 *  2. context = the patient's CURRENT verified instruction versions (patient id from the session, never the body;
 *     never OCR drafts, never superseded versions);
 *  3. the provider is called OUTSIDE any transaction, with a timeout and a concurrency cap (beyond it: escalate);
 *  4. an answer must cite versions that were in the provided context AND are still current when the answer is
 *     written (re-checked, under a share lock, in the write transaction), else it is treated as unsupported;
 *  5. one short transaction records the messages (+ task, outbox, audit when escalating).
 *
 * Audit rows for the assistant carry ids, lengths and reason codes, never the question or the provider's text.
 */
@Injectable()
export class AssistantService {
  private readonly log = new Logger('AssistantService');
  private inFlight = 0;

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(PatientScope) private readonly scope: PatientScope,
  ) {}

  async ask(ctx: RequestCtx, body: AskAssistantRequest, key: string | undefined): Promise<{ status: number; body: AssistantAnswer; replayed: boolean }> {
    const { user } = ctx;
    const patientId = user.patientId;
    if (!patientId) throw notFound('Patient');
    if (body.conversationId) await this.assertOwnConversation(patientId, body.conversationId);

    // A retry of the same request returns the stored answer without asking the provider again.
    const idem = key ? { actorId: user.userId, operation: 'assistant.ask', key, requestHash: hashRequest(body) } : undefined;
    if (idem) {
      const stored = await findIdempotencyRecord(this.pool, idem);
      if (stored) {
        if (stored.requestHash !== idem.requestHash) {
          throw conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
        }
        return { status: stored.status, body: stored.body as AssistantAnswer, replayed: true };
      }
    }

    await this.assertWithinRateLimit(patientId);

    const decision = await this.decide(patientId, body.question);
    const finish = (tx: Tx) => this.record(tx, ctx, patientId, body, decision);
    if (idem) {
      const r = await withTransaction(this.pool, async (tx) => ({ status: 201, body: await finish(tx) }), { idempotency: idem });
      return r;
    }
    return { status: 201, body: await withTransaction(this.pool, finish), replayed: false };
  }

  /** Decide what to do with a question, outside any transaction: deny-list, then context, then the provider. */
  private async decide(patientId: string, question: string): Promise<Decision> {
    const denied = deniedIntent(question);
    if (denied) return { kind: 'escalate', code: 'denied_intent' };

    const full = await currentContextOf(this.pool, patientId);
    if (full.length === 0) return { kind: 'escalate', code: 'no_context' };
    // The provider sees the instruction text and ids only; verifiedAt is for the patient-facing citation.
    const context: LlmContextItem[] = full.map(({ instructionVersionId, title, version, body }) => ({ instructionVersionId, title, version, body }));

    if (this.inFlight >= this.config.assistantMaxConcurrency) return { kind: 'escalate', code: 'busy' };
    this.inFlight += 1;
    let result: LlmAnswer;
    try {
      result = await this.callProvider(question, context);
    } finally {
      this.inFlight -= 1;
    }

    if (result.kind !== 'answer') {
      const byReason = result.reason === 'timeout' ? 'timeout' : result.reason === 'provider error' ? 'provider_error' : 'unsupported';
      return { kind: 'escalate', code: result.code ?? byReason };
    }
    const known = new Map(full.map((c) => [c.instructionVersionId, c]));
    const ids = [...new Set(result.citedVersionIds)];
    const cited = ids.map((id) => known.get(id));
    if (result.text.trim().length === 0 || ids.length === 0 || !cited.every((c) => c !== undefined)) {
      return { kind: 'escalate', code: 'not_cited' };
    }
    return { kind: 'answer', text: result.text.trim(), cited: cited as CitedVersion[] };
  }

  /** The write transaction: messages, and for an escalation the task (new or joined), audit and outbox. */
  private async record(tx: Tx, ctx: RequestCtx, patientId: string, body: AskAssistantRequest, decision: Decision): Promise<AssistantAnswer> {
    const { user } = ctx;
    const now = this.clock.now();
    let escalate: { code: string } | null = decision.kind === 'escalate' ? { code: decision.code } : null;

    // The answer's citations must still be current now (a clinician may have superseded one while the provider
    // was thinking). FOR SHARE makes a concurrent verify wait until this transaction ends.
    if (decision.kind === 'answer') {
      const ids = decision.cited.map((c) => c.instructionVersionId);
      const cur = await tx.query(
        `SELECT id FROM instruction_versions WHERE id = ANY($1::uuid[]) AND patient_id = $2 AND status = 'current' FOR SHARE`,
        [ids, patientId],
      );
      if ((cur.rowCount ?? 0) !== ids.length) escalate = { code: 'stale_version' };
    }

    const conversationId = body.conversationId ?? (await this.newConversation(tx, patientId));
    const asked = await tx.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, patient_id, role, body, created_at)
       VALUES ($1, $2, 'patient', $3, clock_timestamp()) RETURNING id`,
      [conversationId, patientId, body.question.trim()],
    );
    const askedId = asked.rows[0]?.id as string;

    if (decision.kind === 'answer' && !escalate) {
      const citedIds = decision.cited.map((c) => c.instructionVersionId);
      const reply = await tx.query<{ id: string; created_at: string }>(
        `INSERT INTO messages (conversation_id, patient_id, role, body, outcome, source_version_ids, provider, created_at)
         VALUES ($1, $2, 'assistant', $3, 'answered', $4::uuid[], $5, clock_timestamp()) RETURNING id, created_at`,
        [conversationId, patientId, decision.text, citedIds, this.llm.name],
      );
      const r = reply.rows[0] as { id: string; created_at: string };
      await writeAudit(tx, {
        actorId: user.userId,
        actorRole: user.role,
        operation: 'assistant.answer',
        entityType: 'message',
        entityId: r.id,
        next: { outcome: 'answered', citedVersionIds: citedIds, questionLength: body.question.length, answerLength: decision.text.length },
        correlationId: ctx.correlationId,
      });
      return {
        conversationId,
        messageId: r.id,
        outcome: 'answered' as const,
        answer: decision.text,
        citations: decision.cited.map((c) => ({ instructionVersionId: c.instructionVersionId, title: c.title, version: c.version, verifiedAt: c.verifiedAt })),
        escalation: null,
        createdAt: r.created_at,
      };
    }

    // Unsupported, denied, no context, busy, provider error or timeout: an owned staff task, never a guess.
    const code = escalate?.code ?? 'unsupported';
    // One escalation at a time per patient: concurrent questions queue behind this lock, so the cap below is exact.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`assistant-escalation:${patientId}`]);
    const open = await tx.query<{ id: string; due_at: string; detail: string | null; owner_id: string | null }>(
      `SELECT id, due_at, detail, owner_id FROM follow_up_tasks
        WHERE patient_id = $1 AND kind = 'assistant_escalation' AND status IN ('open','acknowledged')
        ORDER BY created_at DESC, id DESC FOR NO KEY UPDATE`,
      [patientId],
    );
    let taskId: string;
    let dueAt: string;
    let ownerId: string | null;
    let joined = false;
    const latest = open.rows[0];
    if (latest && open.rows.length >= this.config.assistantMaxOpenEscalations) {
      // Too many open questions: this one joins the most recent open task instead of opening another.
      joined = true;
      taskId = latest.id;
      dueAt = new Date(latest.due_at).toISOString();
      ownerId = latest.owner_id;
      const addition = `\n---\n${body.question.trim()}`;
      await tx.query(
        `UPDATE follow_up_tasks SET detail = left(coalesce(detail, '') || $2, 4000), version = version + 1, updated_at = $3 WHERE id = $1`,
        [taskId, addition, now],
      );
    } else {
      dueAt = new Date(now.getTime() + ESCALATION_DUE_HOURS * 3_600_000).toISOString();
      ownerId = await pickOwner(tx, patientId, await this.scope.linkedDoctorIds(patientId, tx));
      const task = await tx.query<{ id: string }>(
        `INSERT INTO follow_up_tasks (patient_id, source_message_id, kind, title, detail, owner_id, due_at, created_by)
         VALUES ($1, $2, 'assistant_escalation', 'Patient question the assistant could not answer', $3, $4, $5, NULL)
         RETURNING id`,
        [patientId, askedId, body.question.trim(), ownerId, dueAt],
      );
      taskId = task.rows[0]?.id as string;
    }
    const dueDate = new Date(dueAt);
    const text = ESCALATION_TEXT(dueDate.getTime() > now.getTime() ? formatDue(dueDate, this.config.hospitalTz) : null);
    const reply = await tx.query<{ id: string; created_at: string }>(
      `INSERT INTO messages (conversation_id, patient_id, role, body, outcome, escalation_task_id, provider, created_at)
       VALUES ($1, $2, 'assistant', $3, 'escalated', $4, $5, clock_timestamp()) RETURNING id, created_at`,
      [conversationId, patientId, text, taskId, this.llm.name],
    );
    const r = reply.rows[0] as { id: string; created_at: string };
    await writeAudit(tx, {
      actorId: user.userId,
      actorRole: user.role,
      operation: 'assistant.escalate',
      entityType: 'follow_up_task',
      entityId: taskId,
      next: { status: 'open', ownerId, dueAt, messageId: r.id, questionLength: body.question.length, joinedExisting: joined },
      reason: code,
      correlationId: ctx.correlationId,
    });
    if (!joined) {
      await writeOutbox(tx, {
        eventType: 'FollowUpOpened',
        entityType: 'follow_up_task',
        entityId: taskId,
        entityVersion: 1,
        patientId,
        payload: { kind: 'assistant_escalation', ownerId },
      });
    }
    return {
      conversationId,
      messageId: r.id,
      outcome: 'escalated' as const,
      answer: text,
      citations: [],
      escalation: { taskId, dueAt },
      createdAt: r.created_at,
    };
  }

  /** Per-patient limit on questions in a window, counted from the messages table (works across instances). */
  private async assertWithinRateLimit(patientId: string): Promise<void> {
    const res = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages
        WHERE patient_id = $1 AND role = 'patient' AND created_at > clock_timestamp() - make_interval(secs => $2)`,
      [patientId, this.config.assistantRateLimitWindowSec],
    );
    if ((res.rows[0]?.n ?? 0) >= this.config.assistantRateLimitMax) throw rateLimited(this.config.assistantRateLimitWindowSec);
  }

  async conversations(ctx: RequestCtx): Promise<AssistantConversation[]> {
    if (!ctx.user.patientId) throw notFound('Patient');
    const res = await this.pool.query(
      `SELECT c.id, c.created_at, (SELECT max(m.created_at) FROM messages m WHERE m.conversation_id = c.id) AS last_message_at
         FROM conversations c WHERE c.patient_id = $1 ORDER BY c.created_at DESC, c.id`,
      [ctx.user.patientId],
    );
    return res.rows.map((r) => ({ id: r.id, createdAt: r.created_at, lastMessageAt: r.last_message_at }));
  }

  /** Owner only: anyone else (another patient, staff) gets 404. */
  async messages(ctx: RequestCtx, conversationId: string): Promise<ConversationMessage[]> {
    if (!ctx.user.patientId) throw notFound('Conversation');
    await this.assertOwnConversation(ctx.user.patientId, conversationId);
    const res = await this.pool.query(
      `SELECT m.id, m.role, m.body, m.outcome, m.escalation_task_id, m.created_at,
              (SELECT t.due_at FROM follow_up_tasks t WHERE t.id = m.escalation_task_id AND t.patient_id = m.patient_id) AS escalation_due_at,
              COALESCE((SELECT json_agg(json_build_object('instructionVersionId', iv.id, 'title', COALESCE(iv.title, i.title), 'version', iv.version, 'verifiedAt', iv.verified_at)
                                        ORDER BY iv.version, iv.id)
                          FROM instruction_versions iv JOIN instructions i ON i.id = iv.instruction_id
                         WHERE iv.id = ANY(m.source_version_ids) AND iv.patient_id = m.patient_id), '[]'::json) AS citations
         FROM messages m WHERE m.conversation_id = $1 AND m.patient_id = $2 ORDER BY m.created_at, m.id`,
      [conversationId, ctx.user.patientId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      role: r.role,
      body: r.body,
      outcome: r.outcome,
      citations: r.citations,
      escalationTaskId: r.escalation_task_id,
      escalationDueAt: r.escalation_due_at ? new Date(r.escalation_due_at).toISOString() : null,
      createdAt: r.created_at,
    }));
  }

  private async assertOwnConversation(patientId: string, conversationId: string): Promise<void> {
    const res = await this.pool.query(`SELECT 1 FROM conversations WHERE id = $1 AND patient_id = $2`, [conversationId, patientId]);
    if ((res.rowCount ?? 0) === 0) throw notFound('Conversation');
  }

  private async newConversation(tx: Tx, patientId: string): Promise<string> {
    const res = await tx.query<{ id: string }>(`INSERT INTO conversations (patient_id) VALUES ($1) RETURNING id`, [patientId]);
    return res.rows[0]?.id as string;
  }

  /** Provider call with a timeout; any failure is "unsupported", never an error to the patient. */
  private async callProvider(question: string, context: LlmContextItem[]): Promise<LlmAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.assistantTimeoutMs);
    try {
      return await Promise.race([
        this.llm.answer({ question, context }, { signal: controller.signal }),
        new Promise<LlmAnswer>((resolve) =>
          controller.signal.addEventListener('abort', () => resolve({ kind: 'unsupported', reason: 'timeout' }), {
            once: true,
          }),
        ),
      ]);
    } catch (err) {
      this.log.warn(`assistant provider failed: ${err instanceof Error ? err.name : 'error'}`);
      return { kind: 'unsupported', reason: 'provider error' };
    } finally {
      clearTimeout(timer);
    }
  }
}

type CitedVersion = LlmContextItem & { verifiedAt: string };

type Decision =
  | { kind: 'answer'; text: string; cited: CitedVersion[] }
  | { kind: 'escalate'; code: string };
