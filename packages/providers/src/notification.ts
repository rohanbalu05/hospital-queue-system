import { createHash } from 'node:crypto';
import { NotConfiguredError, PermanentProviderError, TransientProviderError } from './errors.js';
import type { ProviderEnv } from './storage.js';

/** Outbound channels behind the adapter. In-app notices never go through a provider. */
export type OutboundChannel = 'sms' | 'email';

export interface OutboundMessage {
  channel: OutboundChannel;
  /** Phone number (sms) or email address (email). */
  to: string;
  /** Plain text built from routing data only (names, times, tokens, rooms); never clinical text. */
  body: string;
  /**
   * Stable per delivery (the delivery row id). A provider that supports idempotency keys uses it so a retry after a
   * lost response does not send twice.
   */
  idempotencyKey: string;
}

export interface SendResult {
  providerMessageId: string;
}

/**
 * SMS / email delivery (D-034). Called by the worker only, and never inside a database transaction.
 *
 * A real provider MUST de-duplicate on `idempotencyKey`: the worker may send again with the same key after a crash
 * between the provider accepting the message and the worker recording that in the database (at-least-once delivery;
 * the key is the delivery row id, stable across retries). A provider that cannot honour a key must not be used
 * without its own de-duplication in front of it, or patients can receive the same notice twice.
 */
export interface NotificationProvider {
  readonly name: string;
  send(message: OutboundMessage): Promise<SendResult>;
}

export interface FakeNotificationOptions {
  /** Runs at the start of every send, before it is recorded or failed (test hook; may throw). */
  onSend?: (message: OutboundMessage) => void | Promise<void>;
}

/**
 * Offline default. Returns a deterministic message id (a hash of the idempotency key), records what it "sent" in
 * memory and can be told to fail, so the worker's retry and failure paths are testable without a network.
 * A repeated idempotency key is recorded once, like a real provider that honours the key.
 */
export class FakeNotificationProvider implements NotificationProvider {
  readonly name = 'fake';
  /** Messages accepted, one per idempotency key, in order. */
  readonly sent: OutboundMessage[] = [];
  /** Every call, accepted or not. */
  calls = 0;
  private failures = 0;
  private failure: Error | null = null;
  private readonly onSend: FakeNotificationOptions['onSend'];

  constructor(opts: FakeNotificationOptions = {}) {
    this.onSend = opts.onSend;
  }

  /** The next `n` sends fail with a transient error. */
  failNext(n: number, error: Error = new TransientProviderError('fake notification provider unavailable')): void {
    this.failures = n;
    this.failure = error;
  }

  /** Every send fails until reset(). */
  failAlways(error: Error = new TransientProviderError('fake notification provider unavailable')): void {
    this.failures = Number.POSITIVE_INFINITY;
    this.failure = error;
  }

  reset(): void {
    this.sent.length = 0;
    this.calls = 0;
    this.failures = 0;
    this.failure = null;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    this.calls += 1;
    await this.onSend?.(message);
    if (message.to.trim() === '') throw new PermanentProviderError('notification address is empty');
    if (message.body.trim() === '') throw new PermanentProviderError('notification body is empty');
    if (this.failures > 0 && this.failure) {
      this.failures -= 1;
      throw this.failure;
    }
    if (!this.sent.some((m) => m.idempotencyKey === message.idempotencyKey)) this.sent.push({ ...message });
    return { providerMessageId: `fake-${createHash('sha256').update(message.idempotencyKey).digest('hex').slice(0, 16)}` };
  }
}

/** SMS gateway adapter: later. Never called by default. */
export class SmsNotificationProvider implements NotificationProvider {
  readonly name = 'sms';
  constructor(readonly opts: { apiKey?: string } = {}) {}

  send(_message: OutboundMessage): Promise<SendResult> {
    return Promise.reject(new NotConfiguredError('sms', 'SMS provider not configured in this build'));
  }
}

/** Email adapter: later. Never called by default. */
export class EmailNotificationProvider implements NotificationProvider {
  readonly name = 'email';
  constructor(readonly opts: { apiKey?: string } = {}) {}

  send(_message: OutboundMessage): Promise<SendResult> {
    return Promise.reject(new NotConfiguredError('email', 'email provider not configured in this build'));
  }
}

/** `NOTIFICATION_PROVIDER=real`: routes each message to the SMS or the email adapter by channel. */
export class RoutingNotificationProvider implements NotificationProvider {
  readonly name = 'real';
  constructor(
    private readonly sms: NotificationProvider = new SmsNotificationProvider(),
    private readonly email: NotificationProvider = new EmailNotificationProvider(),
  ) {}

  send(message: OutboundMessage): Promise<SendResult> {
    return (message.channel === 'sms' ? this.sms : this.email).send(message);
  }
}

/** NOTIFICATION_PROVIDER: fake (default) | real. */
export function createNotificationProvider(env: ProviderEnv = process.env): NotificationProvider {
  const kind = env['NOTIFICATION_PROVIDER'] || 'fake';
  switch (kind) {
    case 'fake':
      return new FakeNotificationProvider();
    case 'real':
      return new RoutingNotificationProvider(
        new SmsNotificationProvider({ apiKey: env['SMS_API_KEY'] }),
        new EmailNotificationProvider({ apiKey: env['EMAIL_API_KEY'] }),
      );
    default:
      throw new Error(`NOTIFICATION_PROVIDER must be fake or real (got "${kind}")`);
  }
}
