import { Controller, Get, Inject } from '@nestjs/common';
import type { SystemStatus } from '@hqms/contracts';
import type { Pool } from '@hqms/db';
import type { AppConfig } from '../common/config.js';
import { APP_CONFIG, DB_POOL } from '../common/tokens.js';
import { Roles } from '../identity/auth.decorators.js';

/** A pending/failed job this far past its run_at should already have run (PR-02). */
const OVERDUE_SEC = 60;

const OVERDUE = `state IN ('pending','failed') AND run_at < now() - make_interval(secs => $1::int)`;
const DEAD_24H = `state = 'dead' AND COALESCE(finished_at, updated_at) > now() - interval '24 hours'`;

/** Background-work health for the admin home panel (PR-02). Counts and ages only; no payloads, no patient data. */
@Controller('admin/system')
export class SystemController {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Roles('admin')
  @Get()
  async status(): Promise<SystemStatus> {
    const stale = this.config.workerStaleSec;
    const [workers, jobs, byType, outbox, deliveries, now] = await Promise.all([
      this.pool.query(
        `SELECT worker_id, job_types, dispatch_outbox, started_at, last_seen_at,
                last_seen_at > now() - make_interval(secs => $1::int) AS up
           FROM worker_heartbeats ORDER BY started_at, worker_id`,
        [stale],
      ),
      this.pool.query(
        `SELECT count(*) FILTER (WHERE ${OVERDUE})::int AS overdue,
                floor(extract(epoch FROM now() - min(run_at) FILTER (WHERE ${OVERDUE})))::int AS oldest,
                count(*) FILTER (WHERE state = 'running')::int AS running,
                count(*) FILTER (WHERE ${DEAD_24H})::int AS dead24h
           FROM jobs`,
        [OVERDUE_SEC],
      ),
      this.pool.query(
        `SELECT job_type,
                count(*) FILTER (WHERE ${OVERDUE})::int AS overdue,
                count(*) FILTER (WHERE ${DEAD_24H})::int AS dead24h
           FROM jobs
          GROUP BY job_type
         HAVING count(*) FILTER (WHERE ${OVERDUE}) > 0 OR count(*) FILTER (WHERE ${DEAD_24H}) > 0
          ORDER BY job_type`,
        [OVERDUE_SEC],
      ),
      this.pool.query(
        `SELECT count(*)::int AS undispatched,
                floor(extract(epoch FROM now() - min(occurred_at)))::int AS oldest
           FROM outbox_events WHERE dispatched_at IS NULL`,
      ),
      this.pool.query(
        `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
                count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '24 hours')::int AS failed24h
           FROM notification_deliveries`,
      ),
      this.pool.query<{ now: string }>(`SELECT now() AS now`),
    ]);
    const instances = workers.rows.map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg row
      (r: any) => ({
        workerId: r.worker_id as string,
        jobTypes: r.job_types as string[],
        dispatchOutbox: r.dispatch_outbox as boolean,
        startedAt: new Date(r.started_at).toISOString(),
        lastSeenAt: new Date(r.last_seen_at).toISOString(),
        up: r.up as boolean,
      }),
    );
    const lastSeen = instances.map((i) => i.lastSeenAt).sort().at(-1) ?? null;
    const j = jobs.rows[0];
    const o = outbox.rows[0];
    const d = deliveries.rows[0];
    return {
      checkedAt: new Date(now.rows[0]?.now ?? Date.now()).toISOString(),
      worker: { status: instances.some((i) => i.up) ? 'up' : 'down', lastSeenAt: lastSeen, instances },
      jobs: {
        overdue: j?.overdue ?? 0,
        oldestOverdueSeconds: j?.oldest ?? null,
        running: j?.running ?? 0,
        deadLast24h: j?.dead24h ?? 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg row
        byType: byType.rows.map((r: any) => ({
          jobType: r.job_type as string,
          overdue: r.overdue as number,
          dead24h: r.dead24h as number,
        })),
      },
      outbox: { undispatched: o?.undispatched ?? 0, oldestSeconds: o?.oldest ?? null },
      notifications: { queued: d?.queued ?? 0, failedLast24h: d?.failed24h ?? 0 },
    };
  }
}
