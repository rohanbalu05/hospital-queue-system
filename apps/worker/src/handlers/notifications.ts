import {
  TransientProviderError,
  createNotificationProvider,
  isTransient,
  type NotificationProvider,
  type OutboundChannel,
} from '@hqms/providers';
import { PermanentJobError, type HandlerResult, type JobContext, type JobHandler, type JobRow } from '../types.js';

/*
 * deliver_notification {deliveryId} (B2, D-034). The outbox dispatcher writes one queued notification_deliveries row
 * per recipient per outbound channel and enqueues this job in the SAME transaction (dedupe key
 * deliver_notification:<deliveryId>).
 *
 *   read   the delivery row (plain read, no lock)
 *   ----   NO transaction and NO lock from here: NotificationProvider.send, idempotencyKey = the delivery id, so a
 *          retry after a lost response or a crash between the send and the write cannot send twice
 *   write  one short single-statement UPDATE (atomic, no lock held across the send) guarded by status = 'queued':
 *            success -> sent (provider, provider_message_id, sent_at, attempts + 1)
 *            error   -> attempts + 1 and last_error (<= 200 chars, address and long numbers scrubbed); the runner
 *                       retries with backoff. A permanent error (provider not configured) or the last attempt marks
 *                       the delivery 'failed'. In both cases the job is thrown so it ends 'dead' and stays visible.
 */

export interface NotificationDeps {
  provider(): NotificationProvider;
  /** The provider call is abandoned after this long (must be shorter than the runner's handler timeout). */
  sendTimeoutMs: number;
}

/** The provider is resolved lazily from env (NOTIFICATION_PROVIDER, default fake) on the first delivery. */
export function notificationDeps(
  env: NodeJS.ProcessEnv = process.env,
  overrides: { provider?: NotificationProvider; sendTimeoutMs?: number } = {},
): NotificationDeps {
  let provider = overrides.provider;
  const timeout = Number(env['NOTIFICATION_TIMEOUT_SEC'] ?? 30) * 1000;
  return {
    provider: () => (provider ??= createNotificationProvider(env)),
    sendTimeoutMs: overrides.sendTimeoutMs ?? (Number.isFinite(timeout) && timeout > 0 ? timeout : 30_000),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ERROR = 200;

/** Short, human-readable, and free of the recipient's address or any long number (phone, token). */
export function scrubError(err: unknown, address: string): string {
  let text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (address) text = text.split(address).join('[address]');
  text = text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]')
    .replace(/\b(?:sk|pk|key|token|secret)[-_=:]?[A-Za-z0-9_-]{8,}/gi, '[secret]');
  return text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR - 1)}…` : text;
}

/** Race the provider call against the handler's abort signal and a timeout; its late result is ignored. */
function sendWithTimeout<T>(p: Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
  p.catch(() => undefined); // a late rejection after the abort must not be unhandled
  return new Promise<T>((resolve, reject) => {
    const fail = () => reject(new TransientProviderError('notification provider timed out or was cancelled'));
    if (signal.aborted) return fail();
    const timer = setTimeout(fail, ms);
    const onAbort = () => {
      clearTimeout(timer);
      fail();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

interface DeliveryRow {
  id: string;
  channel: string;
  address: string;
  body: string;
  status: string;
}

export function createDeliverNotificationHandler(deps: NotificationDeps): JobHandler {
  return async (job: JobRow, ctx: JobContext): Promise<HandlerResult> => {
    const deliveryId = job.payload['deliveryId'];
    if (typeof deliveryId !== 'string' || !UUID.test(deliveryId)) {
      throw new PermanentJobError('payload.deliveryId must be a uuid');
    }
    const row = (
      await ctx.pool.query<DeliveryRow>(
        `SELECT id, channel, address, body, status FROM notification_deliveries WHERE id = $1`,
        [deliveryId],
      )
    ).rows[0];
    if (!row) return { cancelled: true, reason: 'delivery row no longer exists' };
    if (row.status !== 'queued') return; // already sent or failed: a redelivered job does nothing
    if (row.channel !== 'sms' && row.channel !== 'email') {
      throw new PermanentJobError(`channel ${row.channel} is not delivered by a provider`);
    }
    const channel: OutboundChannel = row.channel;

    let providerName: string;
    let providerMessageId: string;
    try {
      const provider = deps.provider();
      providerName = provider.name;
      // The only external call of this job. No transaction is open and no row is locked.
      const res = await sendWithTimeout(
        provider.send({ channel, to: row.address, body: row.body, idempotencyKey: row.id }),
        ctx.signal,
        deps.sendTimeoutMs,
      );
      providerMessageId = res.providerMessageId;
    } catch (err) {
      const final = !isTransient(err) || job.attempts >= job.maxAttempts;
      await ctx.pool.query(
        `UPDATE notification_deliveries
            SET attempts = attempts + 1, last_error = $2, status = CASE WHEN $3::boolean THEN 'failed' ELSE status END
          WHERE id = $1 AND status = 'queued'`,
        [row.id, scrubError(err, row.address), final],
      );
      ctx.log.warn('notification.delivery_failed', { deliveryId: row.id, channel, final });
      if (!isTransient(err)) throw new PermanentJobError(scrubError(err, row.address));
      throw err; // the runner backs off and retries; after max attempts it ends the job 'dead'
    }

    await ctx.pool.query(
      `UPDATE notification_deliveries
          SET status = 'sent', provider = $2, provider_message_id = $3, sent_at = $4::timestamptz,
              attempts = attempts + 1, last_error = NULL
        WHERE id = $1 AND status = 'queued'`,
      [row.id, providerName, providerMessageId, ctx.now().toISOString()],
    );
    ctx.log.info('notification.delivered', { deliveryId: row.id, channel, provider: providerName });
  };
}
