import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AskAssistantRequest, AssistantAnswer, ConversationMessage } from '@hqms/contracts';
import { withTransaction, writeAudit, writeOutbox, type Pool, type Tx } from '@hqms/db';
import type { Clock } from '../common/clock.js';
import type { AppConfig } from '../common/config.js';
import { notFound } from '../common/errors.js';
import type { RequestCtx } from '../common/request-context.js';
import { APP_CONFIG, CLOCK, DB_POOL, LLM_PROVIDER } from '../common/tokens.js';
import { currentContextOf } from '../documents/documents.repo.js';
import type { LlmAnswer, LlmContextItem, LlmProvider } from '../providers/ports.js';

/** The patient hears back within this long when a question is escalated (FR-14). */
export const ESCALATION_DUE_HOURS = 24;

const ESCALATION_TEXT = (dueAt: string) =>
  `I can't answer this from your verified instructions. A member of the care team will follow up with you by ${dueAt}.`;

/**
 * FR-14 bounded assistant. Deliberately imports nothing from scheduling, arrivals or queue: it has no code path to
 * bookings, treatment or priority. Its whole effect is rows in conversations / messages and, when it cannot
 * answer, ONE owned follow-up task for staff.
 *
 *  1. context = the patient's CURRENT verified instruction versions (patient id from the session, never the body;
 *     never OCR drafts, never superseded versions);
 *  2. the provider is called OUTSIDE any transaction, with a timeout;
 *  3. an answer must cite versions that were in the provided context, else it is treated as unsupported;
 *  4. one short transaction records the messages (+ task, outbox, audit when escalating).
 */
@Injectable()
export class AssistantService {
  private readonly log = new Logger('AssistantService');

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  async ask(ctx: RequestCtx, body: AskAssistantRequest): Promise<AssistantAnswer> {
    const { user } = ctx;
    const patientId = user.patientId;
    if (!patientId) throw notFound('Patient');
    if (body.conversationId) await this.assertOwnConversation(patientId, body.conversationId);

    const context = await currentContextOf(this.pool, patientId);
    const result = await this.callProvider(body.question, context);
    const known = new Map(context.map((c) => [c.instructionVersionId, c]));
    let supported: { text: string; cited: LlmContextItem[] } | null = null;
    let unsupportedReason = 'unsupported';
    if (result.kind === 'answer') {
      const ids = [...new Set(result.citedVersionIds)];
      const cited = ids.map((id) => known.get(id));
      if (result.text.trim().length > 0 && ids.length > 0 && cited.every((c) => c !== undefined)) {
        supported = { text: result.text.trim(), cited: cited as LlmContextItem[] };
      } else {
        unsupportedReason = 'answer did not cite a current verified instruction';
      }
    } else {
      unsupportedReason = result.code ?? result.reason;
    }

    return withTransaction(this.pool, async (tx) => {
      const now = this.clock.now();
      const conversationId = body.conversationId ?? (await this.newConversation(tx, patientId));
      const asked = await tx.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, patient_id, role, body) VALUES ($1, $2, 'patient', $3) RETURNING id`,
        [conversationId, patientId, body.question.trim()],
      );
      const askedId = asked.rows[0]?.id as string;

      if (supported) {
        const reply = await tx.query<{ id: string; created_at: string }>(
          `INSERT INTO messages (conversation_id, patient_id, role, body, outcome, source_version_ids, provider)
           VALUES ($1, $2, 'assistant', $3, 'answered', $4::uuid[], $5) RETURNING id, created_at`,
          [conversationId, patientId, supported.text, supported.cited.map((c) => c.instructionVersionId), this.llm.name],
        );
        const r = reply.rows[0] as { id: string; created_at: string };
        await writeAudit(tx, {
          actorId: user.userId,
          actorRole: user.role,
          operation: 'assistant.answer',
          entityType: 'message',
          entityId: r.id,
          next: { outcome: 'answered', citedVersionIds: supported.cited.map((c) => c.instructionVersionId) },
          correlationId: ctx.correlationId,
        });
        return {
          conversationId,
          messageId: r.id,
          outcome: 'answered' as const,
          answer: supported.text,
          citations: supported.cited.map((c) => ({
            instructionVersionId: c.instructionVersionId,
            title: c.title,
            version: c.version,
          })),
          escalation: null,
          createdAt: r.created_at,
        };
      }

      // Unsupported, no context, provider error or timeout: an owned staff task, never a guess.
      const dueAt = new Date(now.getTime() + ESCALATION_DUE_HOURS * 3_600_000).toISOString();
      const ownerId = await this.pickOwner(tx, patientId);
      const task = await tx.query<{ id: string }>(
        `INSERT INTO follow_up_tasks (patient_id, source_message_id, kind, title, detail, owner_id, due_at, created_by)
         VALUES ($1, $2, 'assistant_escalation', 'Patient question the assistant could not answer', $3, $4, $5, NULL)
         RETURNING id`,
        [patientId, askedId, body.question.trim(), ownerId, dueAt],
      );
      const taskId = task.rows[0]?.id as string;
      const text = ESCALATION_TEXT(dueAt);
      const reply = await tx.query<{ id: string; created_at: string }>(
        `INSERT INTO messages (conversation_id, patient_id, role, body, outcome, escalation_task_id, provider)
         VALUES ($1, $2, 'assistant', $3, 'escalated', $4, $5) RETURNING id, created_at`,
        [conversationId, patientId, text, taskId, this.llm.name],
      );
      const r = reply.rows[0] as { id: string; created_at: string };
      await writeAudit(tx, {
        actorId: user.userId,
        actorRole: user.role,
        operation: 'assistant.escalate',
        entityType: 'follow_up_task',
        entityId: taskId,
        next: { status: 'open', ownerId, dueAt, messageId: r.id },
        reason: unsupportedReason.slice(0, 200),
        correlationId: ctx.correlationId,
      });
      await writeOutbox(tx, {
        eventType: 'FollowUpOpened',
        entityType: 'follow_up_task',
        entityId: taskId,
        entityVersion: 1,
        patientId,
        payload: { kind: 'assistant_escalation', ownerId },
      });
      return {
        conversationId,
        messageId: r.id,
        outcome: 'escalated' as const,
        answer: text,
        citations: [],
        escalation: { taskId, dueAt },
        createdAt: r.created_at,
      };
    });
  }

  async conversations(ctx: RequestCtx): Promise<Array<{ id: string; createdAt: string; lastMessageAt: string | null }>> {
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
              COALESCE((SELECT json_agg(json_build_object('instructionVersionId', iv.id, 'title', COALESCE(iv.title, i.title), 'version', iv.version)
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

  /**
   * Owner of an escalation: a follow-up user assigned to one of the patient's doctors (fewest open tasks, then id, so
   * the choice is deterministic); none -> unassigned (visible to follow-up staff through the doctor scope).
   */
  private async pickOwner(tx: Tx, patientId: string): Promise<string | null> {
    const res = await tx.query<{ id: string }>(
      `SELECT u.id
         FROM users u JOIN staff_assignments sa ON sa.user_id = u.id
        WHERE u.role = 'followup' AND u.active
          AND sa.doctor_id IN (SELECT doctor_id FROM appointments WHERE patient_id = $1
                               UNION SELECT doctor_id FROM visits WHERE patient_id = $1)
        GROUP BY u.id
        ORDER BY (SELECT count(*) FROM follow_up_tasks t WHERE t.owner_id = u.id AND t.status IN ('open','acknowledged')), u.id
        LIMIT 1`,
      [patientId],
    );
    return res.rows[0]?.id ?? null;
  }

  /** Provider call with a timeout; any failure is "unsupported", never an error to the patient. */
  private async callProvider(question: string, context: LlmContextItem[]): Promise<LlmAnswer> {
    if (context.length === 0) return { kind: 'unsupported', reason: 'No verified instruction is available.', code: 'no_context' };
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
