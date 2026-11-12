import { useRef } from 'react';
import { useMutation, type UseMutationOptions } from '@tanstack/react-query';
import { ApiError, IDEMPOTENCY_HEADER, type ErrorCode } from '@hqms/contracts';
import type { ZodType } from 'zod';

/** D-013: the web app calls /api/*; the dev server and nginx strip the prefix. */
export const API_BASE = '/api';

export type ApiErrorKind = ErrorCode | 'NETWORK' | 'BAD_RESPONSE' | 'UNKNOWN';

/** Typed error for every failed API call. Message is safe to show to the user. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorKind;
  readonly details: unknown;
  readonly correlationId: string | undefined;

  constructor(init: {
    status: number;
    code: ApiErrorKind;
    message: string;
    details?: unknown;
    correlationId?: string | undefined;
  }) {
    super(init.message);
    this.name = 'ApiRequestError';
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.correlationId = init.correlationId;
  }

  get isUnauthenticated(): boolean {
    return this.status === 401 || this.code === 'UNAUTHENTICATED';
  }
}

/** Turn a non-2xx Response into an ApiRequestError, using the ApiError envelope when the body has one. */
export async function parseApiError(res: Response): Promise<ApiRequestError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const parsed = ApiError.safeParse(body);
  if (parsed.success) {
    const { code, message, details, correlationId } = parsed.data.error;
    return new ApiRequestError({ status: res.status, code, message, details, correlationId });
  }
  const gateway = res.status === 502 || res.status === 503 || res.status === 504;
  return new ApiRequestError({
    status: res.status,
    code: gateway ? 'NETWORK' : 'UNKNOWN',
    message: gateway
      ? 'The server is not reachable right now. Try again in a moment.'
      : `The server returned an unexpected response (${res.status}). Try again, and tell reception if it keeps happening.`,
  });
}

export interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Sent as the Idempotency-Key header. Reuse the same key when retrying the same mutation. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Validate the JSON response against a contracts schema. */
  schema?: ZodType<T>;
}

export async function apiFetch<T = unknown>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  // Multipart bodies set their own Content-Type (with the boundary).
  if (opts.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers[IDEMPOTENCY_HEADER] = opts.idempotencyKey;

  let res: Response;
  try {
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      credentials: 'include',
      headers,
    };
    if (opts.body !== undefined) init.body = isForm ? (opts.body as FormData) : JSON.stringify(opts.body);
    if (opts.signal) init.signal = opts.signal;
    res = await fetch(`${API_BASE}${path}`, init);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiRequestError({
      status: 0,
      code: 'NETWORK',
      message: 'Cannot reach the server. Check the connection and try again.',
    });
  }

  if (!res.ok) throw await parseApiError(res);
  if (res.status === 204) return undefined as T;

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiRequestError({ status: res.status, code: 'BAD_RESPONSE', message: 'The server sent a response this screen cannot read.' });
  }
  if (!opts.schema) return json as T;
  const checked = opts.schema.safeParse(json);
  if (!checked.success) {
    throw new ApiRequestError({
      status: res.status,
      code: 'BAD_RESPONSE',
      message: 'The server sent a response this screen cannot read.',
      details: checked.error.issues,
    });
  }
  return checked.data;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * Holds one Idempotency-Key per logical request. The same key is returned while the request
 * (compared by its JSON) is unchanged, so a retry after a timeout replays instead of duplicating.
 * Call `release()` after success so the next request gets a fresh key.
 */
export function createKeyHolder() {
  let key: string | null = null;
  let fingerprint: string | null = null;
  return {
    keyFor(request: unknown): string {
      const fp = JSON.stringify(request ?? null);
      if (key === null || fingerprint !== fp) {
        key = newIdempotencyKey();
        fingerprint = fp;
      }
      return key;
    },
    release() {
      key = null;
      fingerprint = null;
    },
  };
}

/**
 * useMutation for POSTs that need an Idempotency-Key (book, check-in, walk-in, call-next, return booking).
 * `mutationFn` receives the variables and the key to send.
 */
export function useIdempotentMutation<TData, TVars, TError = ApiRequestError>(
  mutationFn: (vars: TVars, idempotencyKey: string) => Promise<TData>,
  options: Omit<UseMutationOptions<TData, TError, TVars>, 'mutationFn'> = {},
) {
  const holder = useRef(createKeyHolder());
  return useMutation<TData, TError, TVars>({
    ...options,
    mutationFn: (vars) => mutationFn(vars, holder.current.keyFor(vars)),
    onSuccess: (...args) => {
      holder.current.release();
      return options.onSuccess?.(...args);
    },
  });
}
