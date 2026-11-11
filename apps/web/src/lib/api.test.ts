import { afterEach, describe, expect, it, vi } from 'vitest';
import { Me } from '@hqms/contracts';
import { ApiRequestError, apiFetch, createKeyHolder, parseApiError } from './api';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('parseApiError', () => {
  it('reads the ApiError envelope', async () => {
    const err = await parseApiError(
      json(409, { error: { code: 'CAPACITY_FULL', message: 'This session has no booked slots left.', correlationId: 'c-123' } }),
    );
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('CAPACITY_FULL');
    expect(err.message).toBe('This session has no booked slots left.');
    expect(err.correlationId).toBe('c-123');
  });

  it('falls back when the body is not an envelope', async () => {
    const err = await parseApiError(new Response('<html>oops</html>', { status: 500 }));
    expect(err.code).toBe('UNKNOWN');
    expect(err.message).toMatch(/unexpected response \(500\)/);
  });

  it('treats a gateway error as a network problem', async () => {
    const err = await parseApiError(new Response('', { status: 502 }));
    expect(err.code).toBe('NETWORK');
  });

  it('flags 401 as unauthenticated', async () => {
    const err = await parseApiError(json(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in first.' } }));
    expect(err.isUnauthenticated).toBe(true);
  });
});

describe('apiFetch', () => {
  it('sends cookies, JSON and the Idempotency-Key, under /api', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('/appointments', { method: 'POST', body: { a: 1 }, idempotencyKey: 'key-0001-abcd' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/appointments');
    expect(init.credentials).toBe('include');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe('key-0001-abcd');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('throws a typed error for non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(403, { error: { code: 'FORBIDDEN', message: 'Not allowed.' } })));
    await expect(apiFetch('/admin/staff')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('maps a failed fetch to NETWORK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(apiFetch('/me')).rejects.toMatchObject({ code: 'NETWORK', status: 0 });
  });

  it('validates the response with a contracts schema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { userId: 'nope' })));
    await expect(apiFetch('/me', { schema: Me })).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
});

describe('createKeyHolder', () => {
  it('reuses the key while the request is unchanged, and renews it after release or a change', () => {
    const h = createKeyHolder();
    const k1 = h.keyFor({ slot: 1 });
    expect(h.keyFor({ slot: 1 })).toBe(k1);
    expect(h.keyFor({ slot: 2 })).not.toBe(k1);
    const k3 = h.keyFor({ slot: 2 });
    h.release();
    expect(h.keyFor({ slot: 2 })).not.toBe(k3);
  });
});
