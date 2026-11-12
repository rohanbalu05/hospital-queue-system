/**
 * Runs scenarios (seed = baseSeed + trial index), aggregates metrics per policy arm and computes
 * paired differences. Pure: no I/O and no clock, so the output is a deterministic function of the
 * parameters, the trial count and the domain package.
 */
import { DEFAULT_POLICY, MINUTE_MS } from '@hqms/domain';
import type { Policy } from '@hqms/domain';
import { ARMS, runArm } from './engine.js';
import type { Arm, ArmRun } from './engine.js';
import { CONSULT_CAPACITY_MIN, DEFAULT_TRIALS, SCENARIOS, SESSION_MIN, generateSession } from './model.js';
import type { ScenarioParams, SimSession } from './model.js';
import { mean, pairedDiff, r3, summarize } from './stats.js';
import type { PairedDiff, Summary } from './stats.js';

export const SCHEMA_VERSION = 1;

export interface TrialMetrics {
  patients: number;
  medianWait: number;
  p95Wait: number;
  meanWait: number;
  maxWait: number;
  over45: number;
  completedBySessionEnd: number;
  completedTotal: number;
  overrunMin: number;
  utilization: number;
  agingCalls: number;
  priorityCalls: number;
  rotationCalls: number;
}

export type GroupKey = 'A' | 'W' | 'P';

const quantileOf = (xs: number[], q: number): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
};

/** Waits group: P = any patient with authorized priority; otherwise A = on-time appointment, W = walk-in or late admission. */
export function groupOf(c: { priorityClass: number | null; group: 'A' | 'W' }): GroupKey {
  return c.priorityClass !== null ? 'P' : c.group;
}

export function trialMetrics(run: ArmRun, session: SimSession, policy: Policy): TrialMetrics {
  const waits = run.calls.map((c) => c.waitMin);
  const sessionEnd = session.endMs;
  let busyMs = 0;
  for (const c of run.calls) {
    const s = Math.max(c.startMs, session.startMs);
    const e = Math.min(c.endMs, sessionEnd);
    if (e > s) busyMs += e - s;
  }
  const lastEnd = run.calls.reduce((m, c) => Math.max(m, c.endMs), session.startMs);
  return {
    patients: waits.length,
    medianWait: r3(quantileOf(waits, 0.5)),
    p95Wait: r3(quantileOf(waits, 0.95)),
    meanWait: r3(mean(waits)),
    maxWait: r3(waits.length === 0 ? 0 : Math.max(...waits)),
    over45: waits.filter((w) => w > policy.agingTriggerMin).length,
    completedBySessionEnd: run.calls.filter((c) => c.endMs <= sessionEnd).length,
    completedTotal: run.calls.length,
    overrunMin: r3(Math.max(0, lastEnd - sessionEnd) / MINUTE_MS),
    utilization: r3(busyMs / MINUTE_MS / CONSULT_CAPACITY_MIN),
    agingCalls: run.decisions['AGING'] ?? 0,
    priorityCalls: run.decisions['CLINICAL_PRIORITY'] ?? 0,
    rotationCalls: run.decisions['ROTATION'] ?? 0,
  };
}

export interface ArmAggregate {
  /** Pooled over every patient of every trial, minutes from eligible to called. */
  wait: Summary;
  waitByGroup: Record<GroupKey, Summary>;
  /** Called minus scheduled time for on-time appointments (negative = called before the booked time). */
  appointmentStartDelay: Summary & { shareLaterThan15Min: number };
  /** Share of all patients whose wait exceeded the 45-minute aging trigger. */
  shareWaitOver45: number;
  /** Share of trials in which at least one patient waited more than 45 minutes. */
  shareTrialsAnyOver45: number;
  /** Means over trials of the per-trial values. */
  perTrialMean: Record<keyof TrialMetrics, number>;
  /** Distribution over trials of the per-trial longest wait. */
  perTrialMaxWait: Summary;
}

export interface ScenarioResult {
  name: string;
  title: string;
  description: string;
  params: ScenarioParams;
  baseSeed: number;
  trials: number;
  firstSeed: number;
  lastSeed: number;
  workload: Record<string, number>;
  arms: Record<Arm, ArmAggregate>;
  /** Policy minus FCFS, per trial, paired on identical sessions. */
  pairedPolicyVsFcfs: Record<string, PairedDiff>;
  /** Policy minus FCFS-with-priority, per trial (isolates rotation and aging). */
  pairedPolicyVsFcfsPriority: Record<string, PairedDiff>;
}

export interface PerTrialRow {
  scenario: string;
  trial: number;
  seed: number;
  arm: Arm;
  metrics: TrialMetrics;
}

const PAIRED_KEYS: (keyof TrialMetrics)[] = [
  'medianWait',
  'p95Wait',
  'meanWait',
  'maxWait',
  'over45',
  'completedBySessionEnd',
  'overrunMin',
  'utilization',
];

const METRIC_KEYS: (keyof TrialMetrics)[] = [
  'patients',
  'medianWait',
  'p95Wait',
  'meanWait',
  'maxWait',
  'over45',
  'completedBySessionEnd',
  'completedTotal',
  'overrunMin',
  'utilization',
  'agingCalls',
  'priorityCalls',
  'rotationCalls',
];

export function runScenario(
  params: ScenarioParams,
  trials: number,
  policy: Policy = DEFAULT_POLICY,
): { result: ScenarioResult; perTrial: PerTrialRow[] } {
  const metricsByArm: Record<Arm, TrialMetrics[]> = { fcfs: [], policy: [], fcfs_priority: [] };
  const waits: Record<Arm, number[]> = { fcfs: [], policy: [], fcfs_priority: [] };
  const groupWaits: Record<Arm, Record<GroupKey, number[]>> = {
    fcfs: { A: [], W: [], P: [] },
    policy: { A: [], W: [], P: [] },
    fcfs_priority: { A: [], W: [], P: [] },
  };
  const delays: Record<Arm, number[]> = { fcfs: [], policy: [], fcfs_priority: [] };
  const perTrial: PerTrialRow[] = [];
  const workloadSums: Record<string, number> = {};

  for (let i = 0; i < trials; i += 1) {
    const seed = params.baseSeed + i;
    const session = generateSession(params, seed, policy);
    for (const [k, v] of Object.entries(session.counts)) workloadSums[k] = (workloadSums[k] ?? 0) + v;
    workloadSums['attending'] = (workloadSums['attending'] ?? 0) + session.patients.length;
    for (const arm of ARMS) {
      const run = runArm(arm, session, policy);
      const m = trialMetrics(run, session, policy);
      metricsByArm[arm].push(m);
      perTrial.push({ scenario: params.name, trial: i, seed, arm, metrics: m });
      for (const c of run.calls) {
        waits[arm].push(c.waitMin);
        groupWaits[arm][groupOf(c)].push(c.waitMin);
        if (c.startDelayMin !== null) delays[arm].push(c.startDelayMin);
      }
    }
  }

  const aggregate = (arm: Arm): ArmAggregate => {
    const ms = metricsByArm[arm];
    const perTrialMean = {} as Record<keyof TrialMetrics, number>;
    for (const key of METRIC_KEYS) perTrialMean[key] = r3(mean(ms.map((m) => m[key])));
    const d = delays[arm];
    const all = waits[arm];
    return {
      wait: summarize(all),
      waitByGroup: {
        A: summarize(groupWaits[arm].A),
        W: summarize(groupWaits[arm].W),
        P: summarize(groupWaits[arm].P),
      },
      appointmentStartDelay: {
        ...summarize(d),
        shareLaterThan15Min: r3(d.length === 0 ? 0 : d.filter((x) => x > 15).length / d.length),
      },
      shareWaitOver45: r3(all.length === 0 ? 0 : all.filter((w) => w > policy.agingTriggerMin).length / all.length),
      shareTrialsAnyOver45: r3(ms.length === 0 ? 0 : ms.filter((m) => m.over45 > 0).length / ms.length),
      perTrialMean,
      perTrialMaxWait: summarize(ms.map((m) => m.maxWait)),
    };
  };

  const paired = (base: Arm): Record<string, PairedDiff> => {
    const out: Record<string, PairedDiff> = {};
    for (const key of PAIRED_KEYS) {
      out[key] = pairedDiff(
        metricsByArm.policy.map((m) => m[key]),
        metricsByArm[base].map((m) => m[key]),
      );
    }
    return out;
  };

  const workload: Record<string, number> = {};
  for (const [k, v] of Object.entries(workloadSums)) workload[k] = r3(v / trials);

  return {
    result: {
      name: params.name,
      title: params.title,
      description: params.description,
      params,
      baseSeed: params.baseSeed,
      trials,
      firstSeed: params.baseSeed,
      lastSeed: params.baseSeed + trials - 1,
      workload,
      arms: { fcfs: aggregate('fcfs'), policy: aggregate('policy'), fcfs_priority: aggregate('fcfs_priority') },
      pairedPolicyVsFcfs: paired('fcfs'),
      pairedPolicyVsFcfsPriority: paired('fcfs_priority'),
    },
    perTrial,
  };
}

export interface SimulationOutput {
  schemaVersion: number;
  notes: string;
  policy: Policy;
  model: {
    sessionMinutes: number;
    consultationCapacityMinutes: number;
    trialsPerScenario: number;
  };
  scenarios: ScenarioResult[];
}

export function runAll(
  trials: number = DEFAULT_TRIALS,
  scenarios: readonly ScenarioParams[] = SCENARIOS,
  policy: Policy = DEFAULT_POLICY,
): { output: SimulationOutput; perTrial: PerTrialRow[] } {
  const results: ScenarioResult[] = [];
  const perTrial: PerTrialRow[] = [];
  for (const params of scenarios) {
    const r = runScenario(params, trials, policy);
    results.push(r.result);
    perTrial.push(...r.perTrial);
  }
  return {
    output: {
      schemaVersion: SCHEMA_VERSION,
      notes:
        'Measured in simulation on synthetic, seeded sessions. Not a hospital measurement and not clinical validation. Wait = eligible to called, minutes.',
      policy,
      model: {
        sessionMinutes: SESSION_MIN,
        consultationCapacityMinutes: CONSULT_CAPACITY_MIN,
        trialsPerScenario: trials,
      },
      scenarios: results,
    },
    perTrial,
  };
}

export function toJson(output: SimulationOutput): string {
  return `${JSON.stringify(output, null, 2)}\n`;
}

const SUMMARY_COLUMNS = [
  'scenario',
  'arm',
  'trials',
  'patients_pooled',
  'wait_median_min',
  'wait_p95_min',
  'wait_max_min',
  'wait_mean_min',
  'share_wait_over_45',
  'share_trials_any_over_45',
  'A_n',
  'A_median',
  'A_p95',
  'A_max',
  'W_n',
  'W_median',
  'W_p95',
  'W_max',
  'P_n',
  'P_median',
  'P_p95',
  'P_max',
  'appt_start_delay_median_min',
  'appt_start_delay_p95_min',
  'appt_share_later_than_15_min',
  'mean_completed_by_1300',
  'mean_overrun_min',
  'mean_utilization',
  'mean_aging_calls',
  'mean_priority_calls',
  'mean_rotation_calls',
] as const;

export function summaryCsv(output: SimulationOutput): string {
  const lines: string[] = [SUMMARY_COLUMNS.join(',')];
  for (const s of output.scenarios) {
    for (const arm of ARMS) {
      const a = s.arms[arm];
      lines.push(
        [
          s.name,
          arm,
          s.trials,
          a.wait.n,
          a.wait.median,
          a.wait.p95,
          a.wait.max,
          a.wait.mean,
          a.shareWaitOver45,
          a.shareTrialsAnyOver45,
          a.waitByGroup.A.n,
          a.waitByGroup.A.median,
          a.waitByGroup.A.p95,
          a.waitByGroup.A.max,
          a.waitByGroup.W.n,
          a.waitByGroup.W.median,
          a.waitByGroup.W.p95,
          a.waitByGroup.W.max,
          a.waitByGroup.P.n,
          a.waitByGroup.P.median,
          a.waitByGroup.P.p95,
          a.waitByGroup.P.max,
          a.appointmentStartDelay.median,
          a.appointmentStartDelay.p95,
          a.appointmentStartDelay.shareLaterThan15Min,
          a.perTrialMean.completedBySessionEnd,
          a.perTrialMean.overrunMin,
          a.perTrialMean.utilization,
          a.perTrialMean.agingCalls,
          a.perTrialMean.priorityCalls,
          a.perTrialMean.rotationCalls,
        ].join(','),
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export function perTrialCsv(rows: readonly PerTrialRow[]): string {
  const header = ['scenario', 'trial', 'seed', 'arm', ...METRIC_KEYS];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([row.scenario, row.trial, row.seed, row.arm, ...METRIC_KEYS.map((k) => row.metrics[k])].join(','));
  }
  return `${lines.join('\n')}\n`;
}
