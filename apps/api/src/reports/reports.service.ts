import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Id, LocalDate, type Metric, type OperationsReport } from '@hqms/contracts';
import type { Pool } from '@hqms/db';
import type { Clock } from '../common/clock.js';
import type { AppConfig } from '../common/config.js';
import { validationFailed } from '../common/errors.js';
import { localDate } from '../common/http.js';
import { APP_CONFIG, CLOCK, DB_POOL } from '../common/tokens.js';

export const OperationsReportQuery = z.object({
  from: LocalDate.optional(),
  to: LocalDate.optional(),
  doctorId: Id.optional(),
});
export type OperationsReportQueryDto = z.infer<typeof OperationsReportQuery>;

const NOTE_TARGET = 'Phase 1 target, not measured here';

/**
 * Report targets (FR-15-b). These are the approved Phase 1 acceptance targets (NFR-01..05): they are listed so a
 * reader can set them against the measured rows, and are never computed from data. Do not edit a value here
 * without the report changing.
 */
const TARGETS: Array<Omit<Metric, 'kind' | 'sampleSize' | 'note'> & { ref: string }> = [
  { name: 'API latency p95, ordinary load (100 req/s for 30 min)', unit: 'ms', value: 500, ref: 'NFR-01' },
  { name: 'API latency p95, burst (200 req/s for 60 s)', unit: 'ms', value: 1000, ref: 'NFR-01' },
  { name: 'Queue-update freshness p95 (200 connected clients)', unit: 'ms', value: 5000, ref: 'NFR-02' },
  { name: 'Unexpected server errors (upper bound)', unit: '%', value: 1, ref: 'NFR-02' },
  { name: 'Capacity oversubscriptions, duplicate active entries, concurrent doctor allocations', unit: 'count', value: 0, ref: 'NFR-03' },
  { name: 'Availability during declared outpatient hours', unit: '%', value: 99.5, ref: 'NFR-04' },
  { name: 'Recovery point objective (RPO)', unit: 'min', value: 15, ref: 'NFR-05' },
  { name: 'Recovery time objective (RTO)', unit: 'min', value: 60, ref: 'NFR-05' },
];

const round1 = (n: number | null | undefined): number | null =>
  n === null || n === undefined || Number.isNaN(Number(n)) ? null : Math.round(Number(n) * 10) / 10;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** FR-15-b operations report: observed throughput / waits / decisions, and metrics tagged target or measured. */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async operations(q: OperationsReportQueryDto): Promise<OperationsReport> {
    const now = this.clock.now();
    const today = localDate(now, this.config.hospitalTz);
    const to = q.to ?? today;
    const from = q.from ?? addDays(to, -6);
    if (from > to) throw validationFailed('from must not be after to');
    if (addDays(from, 366) < to) throw validationFailed('The report covers at most 366 days');
    const doctorId = q.doctorId ?? null;
    // Sessions are bucketed by their hospital-local date, so "a day" means an IST day.
    const p = [from, to, doctorId];
    const inRange = `s.session_date BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR s.doctor_id = $3)`;

    const through = await this.pool.query(
      `SELECT (SELECT count(*)::int FROM sessions s WHERE ${inRange}) AS sessions,
              (SELECT count(*)::int FROM visits v JOIN sessions s ON s.id = v.session_id
                WHERE v.status = 'completed' AND ${inRange}) AS completed`,
      p,
    );

    // Wait = eligible_at -> the (latest) call decision for the entry. A = group A without clinical priority,
    // W = group W without clinical priority, P = any entry with a clinical priority class, all = every called entry.
    const waits = await this.pool.query(
      `WITH w AS (
         SELECT qe.queue_group AS grp, (qe.priority_class IS NOT NULL) AS pri,
                GREATEST(0, EXTRACT(EPOCH FROM (d.decided_at - qe.eligible_at)) / 60.0) AS wait_min
           FROM queue_entries qe
           JOIN sessions s ON s.id = qe.session_id
           JOIN LATERAL (SELECT max(qd.decided_at) AS decided_at FROM queue_decisions qd
                          WHERE qd.queue_entry_id = qe.id AND qd.reason <> 'NO_ALLOCATION') d ON d.decided_at IS NOT NULL
          WHERE ${inRange})
       SELECT g.grp,
              count(*) FILTER (WHERE g.test)::int AS n,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_min) FILTER (WHERE g.test) AS median,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY wait_min) FILTER (WHERE g.test) AS p95
         FROM (SELECT wait_min, x.grp, x.test
                 FROM w, LATERAL (VALUES ('A', w.grp = 'A' AND NOT w.pri), ('W', w.grp = 'W' AND NOT w.pri),
                                         ('P', w.pri), ('all', true)) AS x(grp, test)) g
        GROUP BY g.grp`,
      p,
    );
    const waitBy = new Map(waits.rows.map((r) => [r.grp as string, r]));
    const waitsByGroup = (['A', 'W', 'P', 'all'] as const).map((group) => {
      const r = waitBy.get(group);
      return { group, medianMinutes: round1(r?.median), p95Minutes: round1(r?.p95), n: (r?.n as number | undefined) ?? 0 };
    });

    const reasons = await this.pool.query(
      `SELECT qd.reason, count(*)::int AS n FROM queue_decisions qd JOIN sessions s ON s.id = qd.session_id
        WHERE ${inRange} GROUP BY qd.reason`,
      p,
    );
    const reasonCount = new Map(reasons.rows.map((r) => [r.reason as string, r.n as number]));
    const decisionsByReason = ['CLINICAL_PRIORITY', 'AGING', 'ROTATION', 'NO_ALLOCATION'].map((reason) => ({
      reason,
      count: reasonCount.get(reason) ?? 0,
    }));

    const metrics: Metric[] = [
      ...TARGETS.map(
        (t): Metric => ({
          name: t.name,
          unit: t.unit,
          kind: 'target',
          value: t.value,
          sampleSize: null,
          note: `${NOTE_TARGET} (${t.ref})`,
        }),
      ),
      ...(await this.measured(p, inRange, waitsByGroup, now)),
    ];

    return {
      from,
      to,
      generatedAt: now.toISOString(),
      throughput: { completedVisits: through.rows[0]?.completed ?? 0, sessions: through.rows[0]?.sessions ?? 0 },
      waitsByGroup,
      decisionsByReason,
      metrics,
    };
  }

  /** Rows computed from data in the window; each carries its sample size so a thin sample is visible. */
  private async measured(
    p: unknown[],
    inRange: string,
    waitsByGroup: OperationsReport['waitsByGroup'],
    now: Date,
  ): Promise<Metric[]> {
    const measured = (name: string, unit: string, value: number | null, sampleSize: number, note: string | null): Metric => ({
      name,
      unit,
      kind: 'measured',
      value,
      sampleSize,
      note,
    });
    const all = waitsByGroup.find((w) => w.group === 'all');
    const consult = await this.pool.query(
      `SELECT avg(EXTRACT(EPOCH FROM (v.completed_at - v.started_at)) / 60.0) AS mean_min, count(*)::int AS n
         FROM visits v JOIN sessions s ON s.id = v.session_id
        WHERE v.status = 'completed' AND v.started_at IS NOT NULL AND v.completed_at IS NOT NULL AND ${inRange}`,
      p,
    );
    const noShow = await this.pool.query(
      `SELECT count(*) FILTER (WHERE a.status = 'missed')::int AS missed, count(*)::int AS n
         FROM appointments a JOIN sessions s ON s.id = a.session_id
        WHERE a.status IN ('missed','checked_in','completed') AND ${inRange}`,
      p,
    );
    const follow = await this.pool.query(
      `SELECT count(*) FILTER (WHERE t.status = 'resolved' AND t.resolved_at <= t.due_at)::int AS on_time,
              count(*) FILTER (WHERE t.status = 'resolved')::int AS resolved,
              count(*) FILTER (WHERE t.status IN ('open','acknowledged') AND t.due_at < $3::timestamptz)::int AS overdue_open
         FROM follow_up_tasks t
        WHERE t.created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Kolkata')
          AND t.created_at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
          AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = t.patient_id AND a.doctor_id = $4)
                                OR EXISTS (SELECT 1 FROM visits v WHERE v.patient_id = t.patient_id AND v.doctor_id = $4))`,
      [p[0], p[1], now, p[2]],
    );
    const assistant = await this.pool.query(
      `SELECT count(*) FILTER (WHERE m.outcome = 'escalated')::int AS escalated, count(*)::int AS n
         FROM messages m
        WHERE m.role = 'assistant'
          AND m.created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Kolkata')
          AND m.created_at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`,
      [p[0], p[1]],
    );
    const docs = await this.pool.query(
      `SELECT count(*) FILTER (WHERE d.status = 'ocr_failed')::int AS failed, count(*)::int AS n
         FROM documents d
        WHERE d.created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Kolkata')
          AND d.created_at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`,
      [p[0], p[1]],
    );
    const rate = (num: number | undefined, n: number | undefined): number | null =>
      n && n > 0 ? round1(((num ?? 0) / n) * 100) : null;
    const c = consult.rows[0];
    const ns = noShow.rows[0];
    const f = follow.rows[0];
    const a = assistant.rows[0];
    const d = docs.rows[0];
    return [
      measured('Median wait, eligible to called (all groups)', 'min', all?.medianMinutes ?? null, all?.n ?? 0, null),
      measured('p95 wait, eligible to called (all groups)', 'min', all?.p95Minutes ?? null, all?.n ?? 0, null),
      measured('Mean consultation duration', 'min', round1(c?.mean_min), c?.n ?? 0, null),
      measured('No-show rate (missed / admitted or missed bookings)', '%', rate(ns?.missed, ns?.n), ns?.n ?? 0, null),
      measured('Follow-up tasks closed on time', '%', rate(f?.on_time, f?.resolved), f?.resolved ?? 0, 'Resolved tasks created in the window'),
      measured('Follow-up tasks open and overdue now', 'count', f?.overdue_open ?? 0, f?.overdue_open ?? 0, 'As of report time; never auto-closed'),
      measured('Assistant questions escalated to staff', '%', rate(a?.escalated, a?.n), a?.n ?? 0, null),
      measured('Documents whose OCR failed', '%', rate(d?.failed, d?.n), d?.n ?? 0, null),
    ];
  }
}
