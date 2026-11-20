import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth';

/** A QueryClient that never retries and never garbage-collects mid-test. */
export function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 } } });
}

export function Providers({ qc, initial = ['/'], children }: { qc: QueryClient; initial?: string[]; children: ReactNode }) {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initial}>
        <AuthProvider>{children}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

export type Handler = (req: { method: string; path: string; search: URLSearchParams; body: unknown; headers: Headers }) =>
  | { status?: number; body?: unknown }
  | Promise<{ status?: number; body?: unknown }>
  | undefined;

/**
 * Replace fetch with a router over /api paths. The first handler that answers wins; anything unanswered is a 404
 * in the API's error envelope, so a screen under test degrades the way it would against a real server.
 */
export function stubApi(...handlers: Handler[]) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/api/, '');
    calls.push(`${method} ${path}${url.search}`);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    for (const h of handlers) {
      const out = await h({ method, path, search: url.searchParams, body, headers: new Headers(init?.headers) });
      if (out) {
        const status = out.status ?? 200;
        if (status === 204) return new Response(null, { status });
        return new Response(JSON.stringify(out.body ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not mocked.' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

export const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export const patientUser = (n: number, name: string) => ({
  userId: uuid(0x100 + n),
  email: `patient${n}@hqms.test`,
  displayName: name,
  role: 'patient',
  patientId: uuid(0xa000 + n),
  doctorId: null,
  assignedDoctorIds: [],
});

export const availableNow = { state: 'available', since: null, expectedBackAt: null, overdue: false, reason: null } as const;
