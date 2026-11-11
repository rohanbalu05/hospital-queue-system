import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const PASSWORD = 'demo1234';

// Response bodies are JSON of known shapes that each test narrows; `any` keeps the assertions readable.
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
  /** Wall-clock milliseconds from sending the request until the body was read. */
  ms: number;
}

export interface RequestOptions {
  body?: unknown;
  /** Idempotency-Key; `undefined` generates a fresh one for POST, `null` sends none. */
  key?: string | null;
  headers?: Record<string, string>;
}

/** Real HTTP client holding the cookie of one login. Each instance is an independent caller. */
export class ApiClient {
  constructor(
    readonly baseUrl: string,
    readonly cookie?: string,
    readonly email?: string,
  ) {}

  async request<T = any>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...opts.headers };
    if (this.cookie) headers['Cookie'] = this.cookie;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const key = opts.key === undefined ? (method === 'POST' ? randomUUID() : null) : opts.key;
    if (key !== null) headers['Idempotency-Key'] = key;
    const t0 = performance.now();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
    const text = await res.text();
    const ms = performance.now() - t0;
    let body: unknown = text;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      /* keep the raw text */
    }
    return { status: res.status, body: body as T, headers: res.headers, ms };
  }

  get<T = any>(path: string, opts: RequestOptions = {}) {
    return this.request<T>('GET', path, opts);
  }
  /** `key`: undefined = fresh Idempotency-Key, null = none, string = that key. */
  post<T = any>(path: string, body: unknown = {}, key?: string | null) {
    return this.request<T>('POST', path, { body, ...(key === undefined ? {} : { key }) });
  }
  patch<T = any>(path: string, body: unknown = {}) {
    return this.request<T>('PATCH', path, { body });
  }
}

export const anonymous = (baseUrl: string): ApiClient => new ApiClient(baseUrl);

export async function login(baseUrl: string, email: string, password = PASSWORD): Promise<ApiClient> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login as ${email} failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('hqms_session='));
  if (!cookie) throw new Error(`no session cookie for ${email}`);
  return new ApiClient(baseUrl, cookie.split(';')[0], email);
}

export const newKey = (): string => randomUUID();

/** Nearest-rank percentile (p in 0..100) of a numeric sample. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}
