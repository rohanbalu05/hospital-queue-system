/**
 * T1 (report Table 5): many callers race for the last bookable place of a session.
 * Real HTTP, real PostgreSQL, 50 parallel requests per round, 20 rounds on fresh sessions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { percentile, type ApiClient, type ApiResponse } from '../support/client.js';
import { recordResult } from '../support/results.js';
import {
  capacityCounts,
  checkGlobalInvariants,
  closePool,
  loginAs,
  makeFutureSession,
  registerPatients,
  sqlRows,
  tally,
} from '../support/world.js';

const ROUNDS = 20;
const RACERS = 50;
const SELF_PATIENTS = 10; // patient@ .. patient10@ book for themselves; the rest are booked by reception

let admin: ApiClient;
let receptionClients: ApiClient[];
let selfClients: ApiClient[];
let freshPatients: string[];

interface RoundRecord {
  round: number;
  mode: string;
  bookedCapacity: number;
  preBooked: number;
  requests: number;
  created201: number;
  capacityFull409: number;
  otherStatuses: Record<string, number>;
  serverErrors: number;
  bookedReservedAfter: number;
  bookedAllocationsAfter: number;
  appointmentsInSession: number;
  latencyMs: { p50: number; p95: number; max: number };
}

const rounds: RoundRecord[] = [];
const allLatencies: number[] = [];

beforeAll(async () => {
  admin = await loginAs('admin@hqms.test');
  receptionClients = await Promise.all(Array.from({ length: 5 }, () => loginAs('reception@hqms.test')));
  selfClients = await Promise.all(
    Array.from({ length: SELF_PATIENTS }, (_, i) =>
      loginAs(i === 0 ? 'patient@hqms.test' : `patient${i + 1}@hqms.test`),
    ),
  );
  // 40 patients booked by reception in the race + 9 pre-booked fillers, all distinct (D-022).
  freshPatients = await registerPatients(receptionClients[0] as ApiClient, 49, 'T1 Racer');
}, 120_000);

afterAll(async () => {
  const invariants = await checkGlobalInvariants();
  recordResult('t1LastSlot', {
    rounds: rounds.length,
    perRound: rounds,
    aggregate: {
      requests: rounds.reduce((n, r) => n + r.requests, 0),
      created201: rounds.reduce((n, r) => n + r.created201, 0),
      capacityFull409: rounds.reduce((n, r) => n + r.capacityFull409, 0),
      serverErrors: rounds.reduce((n, r) => n + r.serverErrors, 0),
      latencyMs: {
        p50: round1(percentile(allLatencies, 50)),
        p95: round1(percentile(allLatencies, 95)),
        max: round1(Math.max(...allLatencies)),
      },
    },
    globalInvariantViolations: invariants.violations,
  });
  await closePool();
});

const round1 = (n: number): number => Math.round(n * 10) / 10;

describe('T1 last-slot race', () => {
  it(`${RACERS} parallel bookings for one remaining place, ${ROUNDS} rounds: exactly one winner each time`, async () => {
    for (let r = 0; r < ROUNDS; r += 1) {
      // Even rounds: a session whose capacity is 1. Odd rounds: capacity 10, nine already booked, one place left.
      const preBook = r % 2 === 0 ? 0 : 9;
      const capacity = preBook === 0 ? 1 : 10;
      const session = await makeFutureSession(admin, { booked: capacity, walkin: 5 });
      if (preBook > 0) {
        const fillers = await Promise.all(
          freshPatients.slice(40, 40 + preBook).map((pid, i) =>
            (receptionClients[i % receptionClients.length] as ApiClient).post('/appointments', {
              sessionId: session.id,
              patientId: pid,
            }),
          ),
        );
        expect(fillers.map((f) => f.status)).toEqual(Array(preBook).fill(201));
      }

      const calls: Array<Promise<ApiResponse>> = [];
      for (let i = 0; i < SELF_PATIENTS; i += 1) {
        calls.push((selfClients[i] as ApiClient).post('/appointments', { sessionId: session.id }));
      }
      for (let i = 0; i < RACERS - SELF_PATIENTS; i += 1) {
        calls.push(
          (receptionClients[i % receptionClients.length] as ApiClient).post('/appointments', {
            sessionId: session.id,
            patientId: freshPatients[i],
          }),
        );
      }
      const results = await Promise.all(calls);
      const t = tally(results);
      const winners = results.filter((x) => x.status === 201);

      const counts = await capacityCounts(session.id);
      const inSession = await sqlRows<{ n: number }>(
        `SELECT count(*)::int AS n FROM appointments WHERE session_id = $1`,
        [session.id],
      );
      const latencies = results.map((x) => x.ms);
      allLatencies.push(...latencies);
      rounds.push({
        round: r + 1,
        mode: preBook === 0 ? 'capacity=1' : 'capacity=10, 9 pre-booked',
        bookedCapacity: capacity,
        preBooked: preBook,
        requests: results.length,
        created201: winners.length,
        capacityFull409: t.byCode['CAPACITY_FULL'] ?? 0,
        otherStatuses: Object.fromEntries(Object.entries(t.byStatus).filter(([s]) => s !== '201' && s !== '409')),
        serverErrors: t.serverErrors,
        bookedReservedAfter: counts.booked_reserved,
        bookedAllocationsAfter: counts.booked_allocations,
        appointmentsInSession: inSession[0]?.n ?? -1,
        latencyMs: {
          p50: round1(percentile(latencies, 50)),
          p95: round1(percentile(latencies, 95)),
          max: round1(Math.max(...latencies)),
        },
      });

      expect(t.serverErrors, `round ${r + 1}: 5xx responses`).toBe(0);
      expect(winners, `round ${r + 1}: successes`).toHaveLength(1);
      expect(t.byStatus['409'], `round ${r + 1}: conflicts`).toBe(RACERS - 1);
      expect(t.byCode['CAPACITY_FULL'], `round ${r + 1}: CAPACITY_FULL`).toBe(RACERS - 1);
      expect(counts.booked_reserved).toBe(capacity);
      expect(counts.booked_reserved).toBe(counts.booked_allocations);
      expect(counts.booked_reserved).toBeLessThanOrEqual(counts.booked_capacity);
      expect(inSession[0]?.n).toBe(preBook + 1);
      expect(counts.active_appointments).toBe(preBook + 1);
      const row = await sqlRows(`SELECT id FROM appointments WHERE id = $1 AND session_id = $2`, [
        winners[0]?.body.id,
        session.id,
      ]);
      expect(row).toHaveLength(1);
    }
  }, 300_000);
});
