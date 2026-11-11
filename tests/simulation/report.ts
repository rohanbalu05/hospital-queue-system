/** Renders the generated tables into the hand-written report template. */
import type { ArmAggregate, ScenarioResult, SimulationOutput } from './simulate.js';
import type { PairedDiff } from './stats.js';

const f1 = (x: number): string => x.toFixed(1);
const f2 = (x: number): string => x.toFixed(2);
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const signed = (x: number, digits = 1): string => {
  const text = x.toFixed(digits);
  if (Number(text) === 0) return (0).toFixed(digits); // avoid "+0.0" and "-0.0"
  return x > 0 ? `+${text}` : text;
};

function row(cells: string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function table(header: string[], rows: string[][]): string {
  return [row(header), row(header.map(() => '---')), ...rows.map(row)].join('\n');
}

function ci(p: PairedDiff, digits = 2): string {
  return `${signed(p.meanDiff, digits)} [${signed(p.ci95Low, digits)}, ${signed(p.ci95High, digits)}]`;
}

function headline(s: ScenarioResult): string {
  const a = s.arms.fcfs;
  const b = s.arms.policy;
  const p = s.pairedPolicyVsFcfs;
  const rows: string[][] = [
    ['Median wait, pooled (min)', f1(a.wait.median), f1(b.wait.median), signed(b.wait.median - a.wait.median)],
    ['p95 wait, pooled (min)', f1(a.wait.p95), f1(b.wait.p95), signed(b.wait.p95 - a.wait.p95)],
    ['Mean wait, pooled (min)', f1(a.wait.mean), f1(b.wait.mean), signed(b.wait.mean - a.wait.mean)],
    ['Longest wait in any trial (min)', f1(a.wait.max), f1(b.wait.max), signed(b.wait.max - a.wait.max)],
    [
      'Longest wait per trial, mean (min)',
      f1(a.perTrialMaxWait.mean),
      f1(b.perTrialMaxWait.mean),
      `${ci(p['maxWait'] as PairedDiff, 2)}`,
    ],
    [
      'Longest wait per trial, p95 over trials (min)',
      f1(a.perTrialMaxWait.p95),
      f1(b.perTrialMaxWait.p95),
      signed(b.perTrialMaxWait.p95 - a.perTrialMaxWait.p95),
    ],
    [
      'Patients waiting more than 45 min',
      pct(a.shareWaitOver45),
      pct(b.shareWaitOver45),
      signed((b.shareWaitOver45 - a.shareWaitOver45) * 100) + ' pp',
    ],
    [
      'Trials with any wait over 45 min',
      pct(a.shareTrialsAnyOver45),
      pct(b.shareTrialsAnyOver45),
      signed((b.shareTrialsAnyOver45 - a.shareTrialsAnyOver45) * 100) + ' pp',
    ],
    [
      'Completed by 13:00 (mean per trial)',
      f2(a.perTrialMean.completedBySessionEnd),
      f2(b.perTrialMean.completedBySessionEnd),
      ci(p['completedBySessionEnd'] as PairedDiff),
    ],
    [
      'Overrun past 13:00 (mean min)',
      f2(a.perTrialMean.overrunMin),
      f2(b.perTrialMean.overrunMin),
      ci(p['overrunMin'] as PairedDiff),
    ],
    [
      'Doctor utilization (mean)',
      pct(a.perTrialMean.utilization),
      pct(b.perTrialMean.utilization),
      `${signed((b.perTrialMean.utilization - a.perTrialMean.utilization) * 100)} pp`,
    ],
    ['AGING overrides per trial (mean)', 'n/a', f2(b.perTrialMean.agingCalls), ''],
    ['CLINICAL_PRIORITY calls per trial (mean)', 'n/a', f2(b.perTrialMean.priorityCalls), ''],
  ];
  return table(['Metric (measured in simulation)', 'FCFS', 'HQMS policy', 'Policy minus FCFS'], rows);
}

function pairedTable(s: ScenarioResult): string {
  const labels: [string, string][] = [
    ['medianWait', 'Per-trial median wait (min)'],
    ['p95Wait', 'Per-trial p95 wait (min)'],
    ['maxWait', 'Per-trial longest wait (min)'],
    ['completedBySessionEnd', 'Completed by 13:00'],
    ['overrunMin', 'Overrun (min)'],
  ];
  return table(
    [
      'Paired metric (policy minus FCFS, same session)',
      'Mean difference [95% interval]',
      'Trials policy higher',
      'Trials policy lower',
      'Trials equal',
    ],
    labels.map(([key, label]) => {
      const p = s.pairedPolicyVsFcfs[key] as PairedDiff;
      return [label, ci(p), String(p.policyHigher), String(p.policyLower), String(p.equal)];
    }),
  );
}

function groupTable(s: ScenarioResult, withPriorityArm: boolean): string {
  const groups: ['A' | 'W' | 'P', string][] = [
    ['A', 'A: on-time appointments'],
    ['W', 'W: walk-ins and late admissions'],
    ['P', 'P: authorized priority'],
  ];
  const cell = (a: ArmAggregate, g: 'A' | 'W' | 'P'): string => {
    const x = a.waitByGroup[g];
    return x.n === 0 ? 'n/a' : `${f1(x.median)} / ${f1(x.p95)} / ${f1(x.max)}`;
  };
  const header = ['Group (wait, min: median / p95 / max)', 'Patients pooled', 'FCFS', 'HQMS policy'];
  if (withPriorityArm) header.push('FCFS + priority (reference)');
  return table(
    header,
    groups.map(([g, label]) => {
      const cells = [label, String(s.arms.policy.waitByGroup[g].n), cell(s.arms.fcfs, g), cell(s.arms.policy, g)];
      if (withPriorityArm) cells.push(cell(s.arms.fcfs_priority, g));
      return cells;
    }),
  );
}

function delayTable(s: ScenarioResult): string {
  const a = s.arms.fcfs.appointmentStartDelay;
  const b = s.arms.policy.appointmentStartDelay;
  return table(
    [
      'Appointment start delay, on-time appointments incl. priority (called minus booked time, min)',
      'FCFS',
      'HQMS policy',
    ],
    [
      ['Patients pooled', String(a.n), String(b.n)],
      ['Median', f1(a.median), f1(b.median)],
      ['p95', f1(a.p95), f1(b.p95)],
      ['Share called more than 15 min after the booked time', pct(a.shareLaterThan15Min), pct(b.shareLaterThan15Min)],
    ],
  );
}

function workloadLine(s: ScenarioResult): string {
  const w = s.workload;
  const g = (k: string): string => f2(w[k] ?? 0);
  return (
    `Generated workload per trial (mean): ${g('attending')} patients attend (${g('booked')} booked, ${g('noShows')} no-shows, ` +
    `${g('lateAdmitted')} late admissions, ${g('walkInAdmitted')} walk-ins admitted of ${g('walkInAttempts')} attempts, ` +
    `${g('priority')} with authorized priority); total consultation work ${g('totalWorkMin')} min against 210 nominal minutes.`
  );
}

export function renderScenario(s: ScenarioResult): string {
  return [
    `### ${s.title}`,
    '',
    `${s.description} Seeds ${s.firstSeed} to ${s.lastSeed} (${s.trials} trials).`,
    '',
    workloadLine(s),
    '',
    headline(s),
    '',
    'Paired comparison on identical sessions (normal-approximation 95% interval across trials):',
    '',
    pairedTable(s),
    '',
    groupTable(s, s.name === 'priority-heavy'),
    '',
    delayTable(s),
    '',
  ].join('\n');
}

export function renderTables(output: SimulationOutput): string {
  return output.scenarios.map(renderScenario).join('\n');
}

function expectedWalkInAttempts(s: ScenarioResult): number {
  return s.params.walkInIntensity.reduce((sum, p) => sum + (p.toMin - p.fromMin) * p.ratePerMin, 0);
}

export function renderParams(output: SimulationOutput): string {
  return table(
    [
      'Scenario',
      'Booked slots',
      'No-show',
      'Late (> 15 min)',
      'Expected walk-in attempts',
      'Walk-in cap',
      'Priority share',
      'Mean consultation (min)',
    ],
    output.scenarios.map((s) => [
      s.title,
      String(s.params.bookedCount),
      pct(s.params.noShowProb),
      pct(s.params.lateProb),
      f1(expectedWalkInAttempts(s)),
      String(s.params.walkInCapacity),
      pct(s.params.priorityProb),
      String(s.params.durationMeanMin),
    ]),
  );
}

export function renderSeeds(output: SimulationOutput): string {
  return table(
    ['Scenario', 'Base seed', 'Trials', 'Seeds used'],
    output.scenarios.map((s) => [s.title, String(s.baseSeed), String(s.trials), `${s.firstSeed} to ${s.lastSeed}`]),
  );
}

const MARKERS = {
  tables: '<!-- GENERATED:TABLES -->',
  params: '<!-- GENERATED:PARAMS -->',
  seeds: '<!-- GENERATED:SEEDS -->',
  sha: '{{SHA256}}',
} as const;

/** Fills the generated blocks of the hand-written template. Every marker must be present. */
export function renderReport(template: string, output: SimulationOutput, sha256: string): string {
  for (const marker of Object.values(MARKERS)) {
    if (!template.includes(marker)) throw new Error(`template is missing ${marker}`);
  }
  return template
    .replace(MARKERS.tables, renderTables(output))
    .replace(MARKERS.params, renderParams(output))
    .replace(MARKERS.seeds, renderSeeds(output))
    .replaceAll(MARKERS.sha, sha256);
}
