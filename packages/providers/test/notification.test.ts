import { describe, expect, it } from 'vitest';
import {
  EmailNotificationProvider,
  FakeNotificationProvider,
  NotConfiguredError,
  SmsNotificationProvider,
  TransientProviderError,
  createNotificationProvider,
  isTransient,
} from '../src/index.js';

const msg = (over: Partial<Parameters<FakeNotificationProvider['send']>[0]> = {}) => ({
  channel: 'sms' as const,
  to: '+91 98765 43210',
  body: 'Dr Rao is back and seeing patients again.',
  idempotencyKey: 'delivery-1',
  ...over,
});

describe('FakeNotificationProvider', () => {
  it('returns a deterministic message id and records the send in memory', async () => {
    const p = new FakeNotificationProvider();
    const a = await p.send(msg());
    expect(a.providerMessageId).toMatch(/^fake-[0-9a-f]{16}$/);
    expect(await new FakeNotificationProvider().send(msg())).toEqual(a); // same key -> same id, across instances
    expect((await p.send(msg({ idempotencyKey: 'delivery-2' }))).providerMessageId).not.toBe(a.providerMessageId);
    expect(p.sent.map((s) => s.idempotencyKey)).toEqual(['delivery-1', 'delivery-2']);
    expect(p.sent[0]).toMatchObject({ channel: 'sms', to: '+91 98765 43210', body: 'Dr Rao is back and seeing patients again.' });
  });

  it('the same idempotency key is delivered once (a retry after a lost response does not double-send)', async () => {
    const p = new FakeNotificationProvider();
    await p.send(msg());
    await p.send(msg());
    expect(p.sent).toHaveLength(1);
    expect(p.calls).toBe(2);
  });

  it('can be told to fail: always, or for the next n calls, with a transient or a permanent error', async () => {
    const p = new FakeNotificationProvider();
    p.failNext(2);
    await expect(p.send(msg())).rejects.toBeInstanceOf(TransientProviderError);
    await expect(p.send(msg())).rejects.toBeInstanceOf(TransientProviderError);
    expect(p.sent).toHaveLength(0);
    await expect(p.send(msg())).resolves.toMatchObject({ providerMessageId: expect.stringMatching(/^fake-/) as string });
    p.failAlways(new NotConfiguredError('fake', 'switched off'));
    const err = await p.send(msg({ idempotencyKey: 'x' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotConfiguredError);
    expect(isTransient(err)).toBe(false);
    p.reset();
    expect(p.sent).toHaveLength(0);
    await expect(p.send(msg({ idempotencyKey: 'y' }))).resolves.toBeTruthy();
  });

  it('an onSend hook sees the call before it is recorded (tests use it to prove no transaction is open)', async () => {
    const seen: string[] = [];
    const p = new FakeNotificationProvider({ onSend: (m) => void seen.push(m.idempotencyKey) });
    await p.send(msg());
    expect(seen).toEqual(['delivery-1']);
  });

  it('refuses a message with an empty address or body', async () => {
    const p = new FakeNotificationProvider();
    await expect(p.send(msg({ to: '' }))).rejects.toThrow(/address/);
    await expect(p.send(msg({ body: '  ' }))).rejects.toThrow(/body/);
    expect(p.sent).toHaveLength(0);
  });
});

describe('real provider stubs and the factory', () => {
  it('the SMS and email adapters throw "not configured" and are not transient', async () => {
    for (const p of [new SmsNotificationProvider(), new EmailNotificationProvider()]) {
      const err = await p.send(msg({ channel: p.name === 'sms' ? 'sms' : 'email' })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotConfiguredError);
      expect((err as Error).message).toMatch(/not configured/);
      expect(isTransient(err)).toBe(false);
    }
  });

  it('NOTIFICATION_PROVIDER selects the adapter; fake is the default', () => {
    expect(createNotificationProvider({}).name).toBe('fake');
    expect(createNotificationProvider({ NOTIFICATION_PROVIDER: 'fake' }).name).toBe('fake');
    expect(createNotificationProvider({ NOTIFICATION_PROVIDER: 'real' }).name).toBe('real');
    expect(() => createNotificationProvider({ NOTIFICATION_PROVIDER: 'carrier-pigeon' })).toThrow(/NOTIFICATION_PROVIDER/);
  });

  it('the "real" selection routes by channel and reports not configured for each until credentials exist', async () => {
    const p = createNotificationProvider({ NOTIFICATION_PROVIDER: 'real' });
    await expect(p.send(msg({ channel: 'sms' }))).rejects.toBeInstanceOf(NotConfiguredError);
    await expect(p.send(msg({ channel: 'email', to: 'a@example.org' }))).rejects.toBeInstanceOf(NotConfiguredError);
  });
});
