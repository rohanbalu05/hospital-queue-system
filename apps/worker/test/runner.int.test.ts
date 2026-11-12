import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorSummary } from '../src/log.js';
import { JobRunner } from '../src/runner.js';
import { PermanentJobError, type HandlerRegistry, type JobHandler } from '../src/types.js';
import { fixedClock, getJob, insertJob, makePool, sleep, testLog } from './helpers.js';

let poolA: Pool;
let poolB: Pool;
let admin: Pool;

beforeAll(() => {
  poolA = makePool();
  poolB = makePool();
  admin = makePool(2);
});
afterAll(async () => {
  await Promise.all([poolA.end(), poolB.end(), admin.end()]);
});
beforeEach(async () => {
  await admin.query(`DELETE FROM jobs`);
});

const runner = (
  pool: Pool,
  workerId: string,
  handlers: HandlerRegistry,
  extra: Partial<ConstructorParameters<typeof JobRunner>[0]> = {},
) => new JobRunner({ pool, workerId, handlers, log: testLog, pollMs: 20, renewEveryMs: 0, ...extra });

describe('claiming (FOR UPDATE SKIP LOCKED)', () => {
  it('two runners on separate pools claim disjoint jobs and cover every ready job', async () => {
    const ids = await Promise.all(
      Array.from({ length: 20 }, (_, i) => insertJob(admin, { type: 'noop', dedupeKey: `claim-${i}` })),
    );
    const a = runner(poolA, 'worker-a', {});
    const b = runner(poolB, 'worker-b', {});
    const [ja, jb] = await Promise.all([a.claim(10), b.claim(10)]);
    const idsA = new Set(ja.map((j) => j.id));
    const idsB = new Set(jb.map((j) => j.id));
    // Disjoint: SKIP LOCKED never hands the same job to both. (A racing round may under-fill by a row; the next poll picks it up.)
    expect([...idsA].filter((id) => idsB.has(id))).toEqual([]);
    expect(idsA.size + idsB.size).toBeLessThanOrEqual(20);
    expect(idsA.size + idsB.size).toBeGreaterThan(0);
    const rest = await a.claim(20);
    const all = [...ja, ...jb, ...rest].map((j) => j.id);
    expect(all.sort()).toEqual([...ids].sort()); // every job claimed exactly once across the three rounds
    for (const j of [...ja, ...jb, ...rest]) {
      expect(j.attempts).toBe(1);
      expect(j.state).toBe('running');
    }
    expect(await b.claim(20)).toHaveLength(0); // nothing left, nothing re-claimed while leases are live
  });

  it('never runs a job twice, and never runs the same job concurrently, with two live runners', async () => {
    const total = 40;
    for (let i = 0; i < total; i++) await insertJob(admin, { type: 'work', dedupeKey: `run-${i}` });
    const started = new Map<string, string[]>();
    const active = new Set<string>();
    let overlaps = 0;
    const handler: JobHandler = async (job, ctx) => {
      if (active.has(job.id)) overlaps++;
      active.add(job.id);
      const by = started.get(job.id) ?? [];
      by.push(job.leaseOwner ?? '?');
      started.set(job.id, by);
      await sleep(15);
      active.delete(job.id);
      ctx.log.debug('done');
    };
    const a = runner(poolA, 'worker-a', { work: handler }, { concurrency: 4 });
    const b = runner(poolB, 'worker-b', { work: handler }, { concurrency: 4 });
    await Promise.all([a.drain(), b.drain()]);

    expect(started.size).toBe(total);
    for (const by of started.values()) expect(by).toHaveLength(1);
    expect(overlaps).toBe(0);
    const rows = (await admin.query(`SELECT state, attempts FROM jobs`)).rows;
    expect(rows).toHaveLength(total);
    expect(rows.every((r) => r.state === 'succeeded' && r.attempts === 1)).toBe(true);
  });

  it('does not claim jobs scheduled in the future, and honours the injected clock', async () => {
    const clock = fixedClock(new Date('2030-01-01T00:00:00Z'));
    const id = await insertJob(admin, { type: 'work', runAt: new Date('2030-01-01T00:05:00Z') });
    let ran = 0;
    const r = runner(poolA, 'worker-a', { work: async () => void ran++ }, { clock });
    expect(await r.drain()).toBe(0);
    clock.advance(5 * 60_000);
    expect(await r.drain()).toBe(1);
    expect(ran).toBe(1);
    expect((await getJob(admin, id)).state).toBe('succeeded');
  });

  it('restricts claims to configured job types', async () => {
    const a = await insertJob(admin, { type: 'type_a' });
    const b = await insertJob(admin, { type: 'type_b' });
    const seen: string[] = [];
    const r = runner(
      poolA,
      'worker-a',
      { type_a: async (j) => void seen.push(j.jobType), type_b: async (j) => void seen.push(j.jobType) },
      { jobTypes: ['type_a'] },
    );
    await r.drain();
    expect(seen).toEqual(['type_a']);
    expect((await getJob(admin, a)).state).toBe('succeeded');
    expect((await getJob(admin, b)).state).toBe('pending');
  });
});

describe('crash recovery and leases (NFR-07)', () => {
  it('reclaims a job whose worker crashed (running, lease expired) and completes it', async () => {
    const id = await insertJob(admin, {
      type: 'work',
      state: 'running',
      attempts: 1,
      leaseOwner: 'crashed-worker',
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });
    let ran = 0;
    const r = runner(poolA, 'worker-b', { work: async () => void ran++ });
    await r.drain();
    const row = await getJob(admin, id);
    expect(ran).toBe(1);
    expect(row.state).toBe('succeeded');
    expect(row.attempts).toBe(2); // the crashed attempt counts
    expect(row.lease_owner).toBeNull();
  });

  it('does not steal a job whose lease is still valid', async () => {
    const id = await insertJob(admin, {
      type: 'work',
      state: 'running',
      attempts: 1,
      leaseOwner: 'live-worker',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    let ran = 0;
    const r = runner(poolA, 'worker-b', { work: async () => void ran++ });
    expect(await r.drain()).toBe(0);
    expect(ran).toBe(0);
    expect((await getJob(admin, id)).lease_owner).toBe('live-worker');
  });

  it('buries a job whose final attempt crashed instead of running it again', async () => {
    const id = await insertJob(admin, {
      type: 'work',
      state: 'running',
      attempts: 3,
      maxAttempts: 3,
      leaseOwner: 'crashed-worker',
      leaseExpiresAt: new Date(Date.now() - 1000),
    });
    let ran = 0;
    const r = runner(poolA, 'worker-b', { work: async () => void ran++ });
    await r.drain();
    const row = await getJob(admin, id);
    expect(ran).toBe(0);
    expect(row.state).toBe('dead');
    expect(row.last_error).toMatch(/lease expired/);
    expect(row.finished_at).not.toBeNull();
  });

  it('claim() never re-claims a running job at max attempts, even with an expired lease; it is buried instead', async () => {
    const id = await insertJob(admin, {
      type: 'work',
      state: 'running',
      attempts: 3,
      maxAttempts: 3,
      leaseOwner: 'crashed-worker',
      leaseExpiresAt: new Date(Date.now() - 1000),
    });
    const r = runner(poolA, 'worker-b', { work: async () => {} });
    expect(await r.claim(10)).toHaveLength(0);
    const untouched = await getJob(admin, id);
    expect(untouched.state).toBe('running');
    expect(untouched.attempts).toBe(3);
    expect(untouched.lease_owner).toBe('crashed-worker');
    // and with attempts left the same expired lease is claimable
    const open = await insertJob(admin, {
      type: 'work',
      state: 'running',
      attempts: 2,
      maxAttempts: 3,
      leaseOwner: 'crashed-worker',
      leaseExpiresAt: new Date(Date.now() - 1000),
    });
    expect((await r.claim(10)).map((j) => j.id)).toEqual([open]);
    expect(await r.buryExhausted()).toBe(1);
    expect((await getJob(admin, id)).state).toBe('dead');
  });

  it('renews the lease of a long handler so another runner does not take the job', async () => {
    await insertJob(admin, { type: 'slow' });
    let runs = 0;
    const slow: JobHandler = async () => {
      runs++;
      await sleep(900);
    };
    const a = runner(poolA, 'worker-a', { slow }, { leaseMs: 300, renewEveryMs: 100 });
    const b = runner(poolB, 'worker-b', { slow }, { leaseMs: 300, renewEveryMs: 100 });
    const aRun = a.drain();
    await sleep(100);
    let stolen = 0;
    for (let i = 0; i < 6; i++) {
      stolen += await b.tick();
      await sleep(120);
    }
    await aRun;
    expect(stolen).toBe(0);
    expect(runs).toBe(1);
  });

  it('a worker that lost its lease cannot overwrite the new attempt outcome', async () => {
    const id = await insertJob(admin, { type: 'slow' });
    const slow: JobHandler = async () => {
      // Simulate: lease expired and someone else took over while this handler was still running.
      await admin.query(`UPDATE jobs SET lease_owner = 'thief', attempts = attempts + 1 WHERE id = $1`, [id]);
    };
    const a = runner(poolA, 'worker-a', { slow });
    await a.drain();
    const row = await getJob(admin, id);
    expect(row.state).toBe('running');
    expect(row.lease_owner).toBe('thief');
  });
});

describe('error summaries never carry raw database messages', () => {
  it('stores class, sqlstate and constraint for a pg error, not its message (which can echo data)', async () => {
    const bad: JobHandler = async (_job, ctx) => {
      await ctx.pool.query(`SELECT $1::uuid`, ['Ramesh-Kumar-BLR-000001']); // 22P02 echoes the value
    };
    const dup: JobHandler = async (_job, ctx) => {
      // unique violation on a named constraint
      await ctx.pool.query(`INSERT INTO hospitals (id, name) SELECT id, name FROM hospitals LIMIT 1`);
    };
    const id1 = await insertJob(admin, { type: 'bad', maxAttempts: 1 });
    const id2 = await insertJob(admin, { type: 'dup', maxAttempts: 1 });
    await admin.query(`INSERT INTO hospitals (name) VALUES ('Err Hospital')`);
    await runner(poolA, 'worker-a', { bad, dup }).drain();
    const r1 = await getJob(admin, id1);
    expect(r1.state).toBe('dead');
    expect(r1.last_error).toBe('DatabaseError sqlstate=22P02 constraint=-');
    expect(r1.last_error).not.toContain('Ramesh');
    const r2 = await getJob(admin, id2);
    expect(r2.last_error).toBe('DatabaseError sqlstate=23505 constraint=hospitals_pkey');
  });

  it('errorSummary: pg errors are reduced, our typed errors and plain errors keep their message', () => {
    const pgLike = Object.assign(new Error('invalid input syntax for type uuid: "Sunita Devi"'), {
      code: '22P02',
      severity: 'ERROR',
    });
    expect(errorSummary(pgLike)).toBe('DatabaseError sqlstate=22P02 constraint=-');
    expect(errorSummary(Object.assign(pgLike, { constraint: 'x_uq' }))).toBe('DatabaseError sqlstate=22P02 constraint=x_uq');
    expect(errorSummary(new PermanentJobError('payload.x must be a uuid'))).toBe(
      'PermanentJobError: payload.x must be a uuid',
    );
    expect(errorSummary(new Error('provider exploded'))).toBe('Error: provider exploded');
    // a non-pg error that merely has a `code` is not treated as a pg error
    expect(errorSummary(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(
      'Error: connect ECONNREFUSED',
    );
    expect(errorSummary('x'.repeat(600))).toHaveLength(500);
  });
});

describe('retries, backoff and dead jobs', () => {
  it('backs off exponentially, keeps last_error, then goes dead after max_attempts', async () => {
    const clock = fixedClock(new Date('2030-06-01T10:00:00Z'));
    const id = await insertJob(admin, { type: 'boom', maxAttempts: 3, runAt: new Date('2030-06-01T09:00:00Z') });
    let calls = 0;
    const r = runner(
      poolA,
      'worker-a',
      {
        boom: async () => {
          calls++;
          throw new Error(`provider exploded #${calls}`);
        },
      },
      { clock },
    );

    expect(await r.drain()).toBe(1);
    let row = await getJob(admin, id);
    expect(row.state).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('provider exploded #1');
    expect(new Date(row.run_at).toISOString()).toBe('2030-06-01T10:00:02.000Z'); // 2^1 s

    expect(await r.drain()).toBe(0); // backing off: not claimable yet
    clock.advance(2_000);
    expect(await r.drain()).toBe(1);
    row = await getJob(admin, id);
    expect(row.state).toBe('failed');
    expect(row.attempts).toBe(2);
    expect(new Date(row.run_at).toISOString()).toBe('2030-06-01T10:00:06.000Z'); // 2 + 2^2 s

    clock.advance(4_000);
    expect(await r.drain()).toBe(1);
    row = await getJob(admin, id);
    expect(row.state).toBe('dead');
    expect(row.attempts).toBe(3);
    expect(row.last_error).toContain('provider exploded #3');
    expect(row.finished_at).not.toBeNull();

    clock.advance(24 * 3_600_000);
    expect(await r.drain()).toBe(0); // dead stays dead and visible
    expect(calls).toBe(3);
    expect((await getJob(admin, id)).state).toBe('dead');
  });

  it('caps the backoff', async () => {
    const clock = fixedClock(new Date('2030-06-01T10:00:00Z'));
    const id = await insertJob(admin, {
      type: 'boom',
      maxAttempts: 20,
      attempts: 9,
      runAt: new Date('2030-06-01T09:00:00Z'),
    });
    const r = runner(
      poolA,
      'worker-a',
      {
        boom: async () => {
          throw new Error('x');
        },
      },
      { clock, backoffCapSec: 60 },
    );
    await r.drain();
    expect(new Date((await getJob(admin, id)).run_at).toISOString()).toBe('2030-06-01T10:01:00.000Z');
  });

  it('a permanent error is dead on the first attempt; an unknown job type too', async () => {
    const perm = await insertJob(admin, { type: 'bad_payload' });
    const unknown = await insertJob(admin, { type: 'nobody_handles_this' });
    const r = runner(poolA, 'worker-a', {
      bad_payload: async () => {
        throw new PermanentJobError('payload.x must be a uuid');
      },
    });
    await r.drain();
    const p = await getJob(admin, perm);
    expect(p.state).toBe('dead');
    expect(p.attempts).toBe(1);
    expect(p.last_error).toContain('payload.x must be a uuid');
    const u = await getJob(admin, unknown);
    expect(u.state).toBe('dead');
    expect(u.last_error).toContain('no handler registered');
  });

  it('{retryAt} defers without consuming an attempt; {cancelled} is terminal', async () => {
    const clock = fixedClock(new Date('2030-06-01T10:00:00Z'));
    const later = new Date('2030-06-01T11:00:00Z'); // 10:00 + 1h
    const deferred = await insertJob(admin, { type: 'defer', runAt: new Date('2030-06-01T09:00:00Z') });
    const cancelled = await insertJob(admin, { type: 'cancel', runAt: new Date('2030-06-01T09:00:00Z') });
    const r = runner(
      poolA,
      'worker-a',
      {
        defer: async (_job, ctx) => ({ retryAt: new Date(ctx.now().getTime() + 3_600_000) }),
        cancel: async () => ({ cancelled: true as const }),
      },
      { clock },
    );
    await r.drain();
    const d = await getJob(admin, deferred);
    expect(d.state).toBe('pending');
    expect(d.attempts).toBe(0);
    expect(new Date(d.run_at).toISOString()).toBe(later.toISOString());
    expect(d.lease_owner).toBeNull();
    const c = await getJob(admin, cancelled);
    expect(c.state).toBe('cancelled');
    expect(c.finished_at).not.toBeNull();
    clock.set(later);
    await r.drain();
    const d2 = await getJob(admin, deferred);
    expect(d2.state).toBe('pending'); // deferred again, never dead
    expect(d2.attempts).toBe(0);
    expect(new Date(d2.run_at).toISOString()).toBe('2030-06-01T12:00:00.000Z');
  });

  it('times out a hung handler: the job fails visibly and other jobs keep flowing', async () => {
    const hung = await insertJob(admin, { type: 'hang', maxAttempts: 1 });
    const ok = await insertJob(admin, { type: 'ok' });
    const r = runner(
      poolA,
      'worker-a',
      { hang: () => new Promise(() => {}), ok: async () => {} },
      { handlerTimeoutMs: 150, concurrency: 2 },
    );
    await r.drain();
    expect((await getJob(admin, hung)).state).toBe('dead');
    expect((await getJob(admin, hung)).last_error).toMatch(/timed out/);
    expect((await getJob(admin, ok)).state).toBe('succeeded');
  });
});

describe('loop lifecycle', () => {
  it('start() processes jobs and stop() finishes in-flight work before returning', async () => {
    const id = await insertJob(admin, { type: 'work' });
    let finished = false;
    const r = runner(poolA, 'worker-a', {
      work: async () => {
        await sleep(250);
        finished = true;
      },
    });
    r.start();
    for (let i = 0; i < 100 && r.inFlight === 0; i++) await sleep(10);
    expect(r.inFlight).toBe(1);
    const res = await r.stop(5_000);
    expect(finished).toBe(true);
    expect(res.abandoned).toBe(0);
    expect((await getJob(admin, id)).state).toBe('succeeded');

    // After stop nothing more is claimed.
    const later = await insertJob(admin, { type: 'work' });
    await sleep(100);
    expect((await getJob(admin, later)).state).toBe('pending');
  });

  it('the loop survives a database error during claiming', async () => {
    const flaky = {
      query: async () => {
        throw new Error('connection terminated');
      },
    } as unknown as Pool;
    const r = runner(flaky, 'worker-a', {});
    r.start();
    await sleep(100);
    await expect(r.stop(1000)).resolves.toEqual({ abandoned: 0 });
  });
});
