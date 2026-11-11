import type { Page, Route } from '@playwright/test';

export type DemoRole = 'patient' | 'reception' | 'doctor' | 'followup' | 'admin';

/** Valid UUIDs: the web app parses /me with the contracts zod schema. */
const USERS: Record<DemoRole, Record<string, unknown>> = {
  admin: {
    userId: '00000000-0000-4000-8000-000000000001',
    email: 'admin@hqms.test',
    displayName: 'Vikram Shetty',
    role: 'admin',
    patientId: null,
    doctorId: null,
    assignedDoctorIds: [],
  },
  reception: {
    userId: '00000000-0000-4000-8000-000000000002',
    email: 'reception@hqms.test',
    displayName: 'Deepa Nair',
    role: 'reception',
    patientId: null,
    doctorId: null,
    assignedDoctorIds: ['00000000-0000-4000-8000-0000000000d1'],
  },
  doctor: {
    userId: '00000000-0000-4000-8000-000000000003',
    email: 'doctor@hqms.test',
    displayName: 'Dr. Meenakshi Rao',
    role: 'doctor',
    patientId: null,
    doctorId: '00000000-0000-4000-8000-0000000000d1',
    assignedDoctorIds: ['00000000-0000-4000-8000-0000000000d1'],
  },
  followup: {
    userId: '00000000-0000-4000-8000-000000000004',
    email: 'followup@hqms.test',
    displayName: 'Sunita Hegde',
    role: 'followup',
    patientId: null,
    doctorId: null,
    assignedDoctorIds: [],
  },
  patient: {
    userId: '00000000-0000-4000-8000-000000000005',
    email: 'patient@hqms.test',
    displayName: 'Ananya Iyer',
    role: 'patient',
    patientId: '00000000-0000-4000-8000-0000000000a1',
    doctorId: null,
    assignedDoctorIds: [],
  },
};

const BY_EMAIL = new Map(Object.values(USERS).map((u) => [u.email as string, u]));

export function unauthenticated() {
  return { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } };
}

export interface ApiMock {
  /** Requests seen, as "METHOD /path". */
  calls: string[];
  /** Change who /me returns (null = signed out). */
  setUser(role: DemoRole | null): void;
}

/** Mock every /api/* call. Login with a demo email and password demo1234 signs that user in. */
export async function mockApi(page: Page, initial: DemoRole | null = null): Promise<ApiMock> {
  let current: Record<string, unknown> | null = initial ? USERS[initial] : null;
  const calls: string[] = [];
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname.replace(/^\/api/, '');
      calls.push(`${req.method()} ${path}`);
      if (req.method() === 'GET' && path === '/me') {
        return current ? json(route, 200, current) : json(route, 401, unauthenticated());
      }
      if (req.method() === 'POST' && path === '/auth/login') {
        const body = req.postDataJSON() as { email: string; password: string };
        const user = BY_EMAIL.get(body.email);
        if (user && body.password === 'demo1234') {
          current = user;
          return json(route, 200, user);
        }
        return json(route, 401, { error: { code: 'UNAUTHENTICATED', message: 'Invalid email or password.' } });
      }
      if (req.method() === 'POST' && path === '/auth/logout') {
        current = null;
        return route.fulfill({ status: 204 });
      }
      return json(route, 404, { error: { code: 'NOT_FOUND', message: 'Not mocked.' } });
    },
  );

  return {
    calls,
    setUser(role) {
      current = role ? USERS[role] : null;
    },
  };
}
export * from './scheduling-mocks';
