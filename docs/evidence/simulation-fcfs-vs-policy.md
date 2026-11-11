# Queue policy simulation: FCFS vs the HQMS policy

> Every number in this file is **measured in simulation** on synthetic, seeded sessions. None is a
> hospital measurement, none is a target, and none validates clinical outcomes. This file is generated
> by `pnpm --filter @hqms/tests simulate` from `tests/simulation/report.template.txt` and
> `docs/evidence/simulation/results.json`; do not edit the tables by hand.

Report reference: section 5.6 (queue comparison), Table 7 (policy values), section 6.4 (selection
procedure), presentation Q&A 5, 6, 7 and 35.

## 1. Purpose

Show, with identical generated arrivals, consultation durations and doctor pauses, how the proposed
selection policy (A,A,W rotation, authorized clinical priority, 45-minute aging trigger) compares with
first come first served (FCFS) on median and p95 wait, appointment start delay, group-specific waits,
longest observed wait, completed visits and doctor utilization, including the metrics on which the
policy does worse (report section 5.6, Q&A 35).

## 2. Reproduce

```
pnpm install
pnpm --filter @hqms/tests simulate          # writes docs/evidence/simulation/* and this file
cat docs/evidence/simulation/results.sha256 # SHA-256 of results.json
pnpm --filter @hqms/tests test:simulation   # determinism and invariant tests
```

- Run again: `results.json` is byte-identical (same SHA-256). Recorded hash of the committed run:
  `22d5f4bab05c68718f620a8f278b5e8138050736c9f718820850770d6a71d6df`.
- Environment of the committed run: Node 22 on Linux x86-64 (4 vCPU cloud container). The full run takes
  about one second. Results depend only on the seeds, the parameters below and the `@hqms/domain`
  package. The generator uses mulberry32 (no `Math.random`); outputs are rounded to three decimals.
  Floating-point library functions (`Math.log`, `Math.exp`, `Math.cos`) could in principle differ in the
  last bit on another platform, so the hash is asserted on the same Node and OS, not across platforms.
- Raw data: `docs/evidence/simulation/results.json` (aggregates, parameters, seeds),
  `summary.csv` (one row per scenario and policy) and `per-trial.csv` (one row per trial and policy).

## 3. Model and assumptions

One doctor, one session. Time is in minutes from 09:00 (hospital-local); the session closes at 13:00.

| Element | Modelled as |
| --- | --- |
| Session | 09:00 to 13:00 (240 min), 210 consultation minutes, two 15-minute doctor pauses (30 min of breaks) |
| Pause rule | Each pause begins at the first moment at or after its nominal start (10:30 and 12:00) when the doctor is not in a consultation, and lasts 15 minutes. A consultation is never interrupted. The pause schedule is identical for both policies |
| Appointments | Slots every 20 minutes (12 slots, 09:00 to 12:40); the scenario's booked count (at most 10) is drawn at random from them |
| Appointment arrival | On time: Normal(-6, 7) minutes relative to the booked time, never before 09:00. Late (10% of appointments): 16 plus Exponential(mean 12) minutes after the booked time. No-shows per scenario. Arrivals after 13:00 are treated as no-shows |
| Arrival class | The domain function `classifyArrival` (late grace 15 min). On time keeps group A; later than grace becomes a late admission ordered as W, assumed approved by staff on arrival |
| Eligibility | The domain function `computeEligibleAt`: on-time appointment max(check-in, booked time - 10 min); walk-in or late admission at its check-in |
| Walk-ins | Poisson arrivals (piecewise constant rate) until 12:30; the first 5 are admitted, later attempts are turned away (identical for both policies) |
| Authorized priority | Assigned at arrival to a fraction of patients; class 1, 2 or 3 at 20%, 30%, 50%. Neither policy can assign it later |
| Consultation duration | Per patient, lognormal with the scenario's arithmetic mean and sigma 0.4 of the underlying normal, clamped to 3 to 45 minutes. Each patient carries the same duration under every policy |
| Call to start | Zero. A called patient is present and starts immediately (the 2-minute call timeout is not modelled) |
| After 13:00 | No new check-ins. The doctor keeps seeing patients already checked in; the overrun is measured |
| Selection (policy) | `selectNext` from `@hqms/domain` with the default policy (Table 7: A,A,W; 45-minute aging; early eligibility 10 min), doctor free (non-preemptive), the rotation pointer carried from each decision to the next |
| Selection (FCFS) | Lowest eligible time, then check-in sequence. No priority. Same eligibility rules, so nobody is called before they are eligible |
| Supplementary arm | FCFS with priority: authorized priority first (best class, then eligible time), otherwise FCFS. It is not part of the report's comparison; it isolates what rotation and aging add on top of honouring priority |

Scenario parameters (all synthetic; the mean consultation of 16 minutes is the report's Table 3
sensitivity case):

| Scenario | Booked slots | No-show | Late (> 15 min) | Expected walk-in attempts | Walk-in cap | Priority share | Mean consultation (min) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Appointment-heavy | 10 | 8.0% | 10.0% | 3.0 | 5 | 3.0% | 12 |
| Walk-in-heavy | 5 | 8.0% | 10.0% | 10.0 | 5 | 3.0% | 12 |
| Priority-heavy | 10 | 8.0% | 10.0% | 6.0 | 5 | 20.0% | 12 |
| Overloaded | 10 | 3.0% | 10.0% | 8.0 | 5 | 5.0% | 16 |

Scenario definitions:

- **Appointment-heavy**: 10 booked slots, few walk-ins, mean 12 min.
- **Walk-in-heavy**: 5 booked slots; about 10 walk-in attempts front-loaded into the first 90 minutes,
  so the cap of 5 admitted walk-ins is reached early.
- **Priority-heavy**: 10 booked slots, about 6 walk-in attempts, 20% of attending patients carry an
  authorized priority.
- **Overloaded**: 10 booked slots, about 8 walk-in attempts, mean 16 min. Expected consultation work
  exceeds the 210 available minutes (report Table 3: admission limits and queue order are different
  controls; a fair order does not create doctor time).

Seeds. A trial's seed is the scenario base seed plus the trial index, and the same seed generates the
same session for every policy:

| Scenario | Base seed | Trials | Seeds used |
| --- | --- | --- | --- |
| Appointment-heavy | 1000000 | 500 | 1000000 to 1000499 |
| Walk-in-heavy | 2000000 | 500 | 2000000 to 2000499 |
| Priority-heavy | 3000000 | 500 | 3000000 to 3000499 |
| Overloaded | 4000000 | 500 | 4000000 to 4000499 |

## 4. Metrics

- **Wait**: eligible time to call time, minutes, for every patient who checked in (all of them are
  eventually served, so no wait is censored). Reported pooled over all patients of all trials (median,
  p95, mean, maximum) and as per-trial values compared pairwise.
- **Longest wait**: the largest wait in a trial. The table gives the mean over trials with a paired
  95% interval, the p95 over trials, and the single worst wait seen in any trial.
- **Group waits**: A = on-time appointments without priority; W = walk-ins and late admissions without
  priority; P = any patient with authorized priority.
- **Appointment start delay**: call time minus booked time, for on-time appointments (including those
  with priority). Negative means called before the booked time.
- **Completed by 13:00**: consultations that ended by 13:00. **Overrun**: minutes after 13:00 until
  the last consultation ends.
- **Utilization**: consultation minutes delivered between 09:00 and 13:00 divided by the 210 nominal
  consultation minutes.
- **Over 45 minutes**: share of patients whose wait exceeded 45 minutes, and share of trials in which
  at least one did. 45 minutes is the aging trigger, not a deadline.
- **Paired differences**: policy minus FCFS on the same generated session, mean over trials with a
  normal-approximation 95% interval (mean plus or minus 1.96 standard errors). "Trials policy higher /
  lower / equal" counts trials by the sign of that difference.

## 5. Invariants asserted during every run

The run fails if any of these is violated (checked in `tests/simulation/engine.ts`, exercised by
`tests/simulation/simulation.test.ts`):

1. Never two patients in service at once, and no consultation overlaps a doctor pause.
2. No patient is selected before becoming eligible; every checked-in patient is served exactly once.
3. Priority never preempts: while a consultation runs, `selectNext` with the doctor occupied is probed
   mid-consultation and must return NO_ALLOCATION; a paused session must not allocate.
4. Pointer behaviour: unchanged on CLINICAL_PRIORITY, AGING and NO_ALLOCATION; advanced to the slot
   after the one served on ROTATION. Each decision is also re-checked against the report section 6.4
   rules independently of the selector (best class and longest wait for priority, oldest eligible wait
   at least 45 minutes for aging, no override pending for rotation).

## 6. Results (measured in simulation)

### Appointment-heavy

10 booked slots, light walk-in demand (about 3 attempts), mean consultation 12 min. Seeds 1000000 to 1000499 (500 trials).

Generated workload per trial (mean): 12.04 patients attend (10.00 booked, 0.83 no-shows, 0.98 late admissions, 2.91 walk-ins admitted of 3.02 attempts, 0.37 with authorized priority); total consultation work 143.88 min against 210 nominal minutes.

| Metric (measured in simulation) | FCFS | HQMS policy | Policy minus FCFS |
| --- | --- | --- | --- |
| Median wait, pooled (min) | 3.8 | 3.1 | -0.6 |
| p95 wait, pooled (min) | 36.3 | 40.3 | +4.0 |
| Mean wait, pooled (min) | 9.2 | 9.2 | 0.0 |
| Longest wait in any trial (min) | 95.7 | 95.7 | 0.0 |
| Longest wait per trial, mean (min) | 26.4 | 29.6 | +3.23 [+2.66, +3.80] |
| Longest wait per trial, p95 over trials (min) | 54.9 | 61.5 | +6.6 |
| Patients waiting more than 45 min | 2.5% | 3.9% | +1.4 pp |
| Trials with any wait over 45 min | 11.4% | 19.8% | +8.4 pp |
| Completed by 13:00 (mean per trial) | 11.62 | 11.61 | 0.00 [-0.02, +0.01] |
| Overrun past 13:00 (mean min) | 3.60 | 3.60 | 0.00 [0.00, 0.00] |
| Doctor utilization (mean) | 66.8% | 66.8% | 0.0 pp |
| AGING overrides per trial (mean) | n/a | 0.47 |  |
| CLINICAL_PRIORITY calls per trial (mean) | n/a | 0.37 |  |

Paired comparison on identical sessions (normal-approximation 95% interval across trials):

| Paired metric (policy minus FCFS, same session) | Mean difference [95% interval] | Trials policy higher | Trials policy lower | Trials equal |
| --- | --- | --- | --- | --- |
| Per-trial median wait (min) | -0.66 [-0.86, -0.46] | 15 | 126 | 359 |
| Per-trial p95 wait (min) | +2.01 [+1.60, +2.41] | 188 | 47 | 265 |
| Per-trial longest wait (min) | +3.23 [+2.66, +3.80] | 174 | 28 | 298 |
| Completed by 13:00 | 0.00 [-0.02, +0.01] | 4 | 5 | 491 |
| Overrun (min) | 0.00 [0.00, 0.00] | 0 | 0 | 500 |

| Group (wait, min: median / p95 / max) | Patients pooled | FCFS | HQMS policy |
| --- | --- | --- | --- |
| A: on-time appointments | 3949 | 1.9 / 35.0 / 95.7 | 1.4 / 30.8 / 95.7 |
| W: walk-ins and late admissions | 1886 | 7.0 / 37.3 / 82.7 | 7.3 / 51.5 / 86.5 |
| P: authorized priority | 187 | 2.5 / 38.5 / 79.5 | 1.9 / 19.9 / 37.0 |

| Appointment start delay, on-time appointments incl. priority (called minus booked time, min) | FCFS | HQMS policy |
| --- | --- | --- |
| Patients pooled | 4080 | 4080 |
| Median | 0.1 | 0.0 |
| p95 | 29.9 | 25.7 |
| Share called more than 15 min after the booked time | 15.0% | 11.6% |

### Walk-in-heavy

5 booked slots; walk-in demand of about 10 attempts front-loaded into the first 90 minutes, so the 5-walk-in cap is reached early; mean 12 min. Seeds 2000000 to 2000499 (500 trials).

Generated workload per trial (mean): 9.49 patients attend (5.00 booked, 0.45 no-shows, 0.41 late admissions, 4.97 walk-ins admitted of 10.00 attempts, 0.31 with authorized priority); total consultation work 113.90 min against 210 nominal minutes.

| Metric (measured in simulation) | FCFS | HQMS policy | Policy minus FCFS |
| --- | --- | --- | --- |
| Median wait, pooled (min) | 5.0 | 4.2 | -0.8 |
| p95 wait, pooled (min) | 38.1 | 43.9 | +5.8 |
| Mean wait, pooled (min) | 10.2 | 10.3 | +0.1 |
| Longest wait in any trial (min) | 97.6 | 113.1 | +15.5 |
| Longest wait per trial, mean (min) | 29.4 | 32.8 | +3.38 [+2.78, +3.98] |
| Longest wait per trial, p95 over trials (min) | 59.4 | 63.0 | +3.6 |
| Patients waiting more than 45 min | 2.8% | 4.7% | +1.9 pp |
| Trials with any wait over 45 min | 16.8% | 26.8% | +10.0 pp |
| Completed by 13:00 (mean per trial) | 9.43 | 9.43 | 0.00 [0.00, 0.00] |
| Overrun past 13:00 (mean min) | 0.49 | 0.49 | 0.00 [0.00, 0.00] |
| Doctor utilization (mean) | 54.0% | 54.0% | 0.0 pp |
| AGING overrides per trial (mean) | n/a | 0.45 |  |
| CLINICAL_PRIORITY calls per trial (mean) | n/a | 0.31 |  |

Paired comparison on identical sessions (normal-approximation 95% interval across trials):

| Paired metric (policy minus FCFS, same session) | Mean difference [95% interval] | Trials policy higher | Trials policy lower | Trials equal |
| --- | --- | --- | --- | --- |
| Per-trial median wait (min) | -1.29 [-1.53, -1.05] | 14 | 187 | 299 |
| Per-trial p95 wait (min) | +2.53 [+2.09, +2.98] | 204 | 38 | 258 |
| Per-trial longest wait (min) | +3.38 [+2.78, +3.98] | 177 | 27 | 296 |
| Completed by 13:00 | 0.00 [0.00, 0.00] | 0 | 0 | 500 |
| Overrun (min) | 0.00 [0.00, 0.00] | 0 | 0 | 500 |

| Group (wait, min: median / p95 / max) | Patients pooled | FCFS | HQMS policy |
| --- | --- | --- | --- |
| A: on-time appointments | 1989 | 0.0 / 35.7 / 97.6 | 0.0 / 21.1 / 79.7 |
| W: walk-ins and late admissions | 2599 | 8.1 / 40.4 / 93.0 | 8.9 / 51.0 / 113.1 |
| P: authorized priority | 155 | 4.3 / 39.0 / 80.8 | 2.1 / 17.1 / 26.7 |

| Appointment start delay, on-time appointments incl. priority (called minus booked time, min) | FCFS | HQMS policy |
| --- | --- | --- |
| Patients pooled | 2057 | 2057 |
| Median | 0.0 | -0.6 |
| p95 | 29.9 | 17.6 |
| Share called more than 15 min after the booked time | 15.3% | 6.7% |

### Priority-heavy

10 booked slots and about 6 walk-in attempts; 20% of attending patients receive an authorized clinical priority (classes 1/2/3 at 20/30/50%); mean 12 min. Seeds 3000000 to 3000499 (500 trials).

Generated workload per trial (mean): 13.59 patients attend (10.00 booked, 0.80 no-shows, 0.94 late admissions, 4.46 walk-ins admitted of 5.84 attempts, 2.64 with authorized priority); total consultation work 163.17 min against 210 nominal minutes.

| Metric (measured in simulation) | FCFS | HQMS policy | Policy minus FCFS |
| --- | --- | --- | --- |
| Median wait, pooled (min) | 8.6 | 6.4 | -2.2 |
| p95 wait, pooled (min) | 47.4 | 54.3 | +6.9 |
| Mean wait, pooled (min) | 13.9 | 13.9 | 0.0 |
| Longest wait in any trial (min) | 119.8 | 145.2 | +25.5 |
| Longest wait per trial, mean (min) | 36.2 | 44.7 | +8.46 [+7.46, +9.45] |
| Longest wait per trial, p95 over trials (min) | 66.4 | 83.6 | +17.2 |
| Patients waiting more than 45 min | 5.8% | 9.0% | +3.2 pp |
| Trials with any wait over 45 min | 27.4% | 47.6% | +20.2 pp |
| Completed by 13:00 (mean per trial) | 12.96 | 12.96 | 0.00 [-0.02, +0.01] |
| Overrun past 13:00 (mean min) | 5.21 | 5.21 | 0.00 [0.00, 0.00] |
| Doctor utilization (mean) | 75.2% | 75.2% | 0.0 pp |
| AGING overrides per trial (mean) | n/a | 1.21 |  |
| CLINICAL_PRIORITY calls per trial (mean) | n/a | 2.64 |  |

Paired comparison on identical sessions (normal-approximation 95% interval across trials):

| Paired metric (policy minus FCFS, same session) | Mean difference [95% interval] | Trials policy higher | Trials policy lower | Trials equal |
| --- | --- | --- | --- | --- |
| Per-trial median wait (min) | -2.36 [-2.76, -1.96] | 18 | 280 | 202 |
| Per-trial p95 wait (min) | +5.71 [+4.99, +6.44] | 325 | 58 | 117 |
| Per-trial longest wait (min) | +8.46 [+7.46, +9.45] | 325 | 33 | 142 |
| Completed by 13:00 | 0.00 [-0.02, +0.01] | 8 | 9 | 483 |
| Overrun (min) | 0.00 [0.00, 0.00] | 0 | 0 | 500 |

| Group (wait, min: median / p95 / max) | Patients pooled | FCFS | HQMS policy | FCFS + priority (reference) |
| --- | --- | --- | --- | --- |
| A: on-time appointments | 3291 | 7.2 / 46.5 / 119.8 | 4.9 / 47.3 / 124.3 | 7.3 / 52.7 / 124.3 |
| W: walk-ins and late admissions | 2184 | 10.3 / 47.6 / 88.7 | 13.0 / 66.2 / 145.2 | 11.2 / 57.4 / 145.2 |
| P: authorized priority | 1321 | 9.2 / 49.5 / 90.7 | 4.4 / 25.4 / 79.4 | 4.4 / 25.4 / 79.4 |

| Appointment start delay, on-time appointments incl. priority (called minus booked time, min) | FCFS | HQMS policy |
| --- | --- | --- |
| Patients pooled | 4096 | 4096 |
| Median | 4.2 | 1.8 |
| p95 | 41.9 | 38.5 |
| Share called more than 15 min after the booked time | 27.4% | 19.0% |

### Overloaded

Full capacity (10 booked, about 8 walk-in attempts so the cap of 5 is normally reached), mean consultation 16 min (report Table 3 sensitivity case). Seeds 4000000 to 4000499 (500 trials).

Generated workload per trial (mean): 14.54 patients attend (10.00 booked, 0.29 no-shows, 0.89 late admissions, 4.88 walk-ins admitted of 7.87 attempts, 0.75 with authorized priority); total consultation work 230.82 min against 210 nominal minutes.

| Metric (measured in simulation) | FCFS | HQMS policy | Policy minus FCFS |
| --- | --- | --- | --- |
| Median wait, pooled (min) | 31.3 | 27.9 | -3.3 |
| p95 wait, pooled (min) | 92.7 | 97.1 | +4.4 |
| Mean wait, pooled (min) | 36.1 | 36.0 | -0.1 |
| Longest wait in any trial (min) | 154.8 | 175.3 | +20.5 |
| Longest wait per trial, mean (min) | 73.4 | 79.8 | +6.39 [+5.52, +7.26] |
| Longest wait per trial, p95 over trials (min) | 117.4 | 122.1 | +4.7 |
| Patients waiting more than 45 min | 35.3% | 38.4% | +3.1 pp |
| Trials with any wait over 45 min | 85.2% | 93.2% | +8.0 pp |
| Completed by 13:00 (mean per trial) | 11.95 | 11.95 | -0.01 [-0.03, +0.02] |
| Overrun past 13:00 (mean min) | 34.78 | 34.78 | 0.00 [0.00, 0.00] |
| Doctor utilization (mean) | 93.4% | 93.4% | 0.0 pp |
| AGING overrides per trial (mean) | n/a | 5.57 |  |
| CLINICAL_PRIORITY calls per trial (mean) | n/a | 0.75 |  |

Paired comparison on identical sessions (normal-approximation 95% interval across trials):

| Paired metric (policy minus FCFS, same session) | Mean difference [95% interval] | Trials policy higher | Trials policy lower | Trials equal |
| --- | --- | --- | --- | --- |
| Per-trial median wait (min) | -1.94 [-2.60, -1.27] | 120 | 256 | 124 |
| Per-trial p95 wait (min) | +5.05 [+4.36, +5.74] | 281 | 33 | 186 |
| Per-trial longest wait (min) | +6.39 [+5.52, +7.26] | 241 | 22 | 237 |
| Completed by 13:00 | -0.01 [-0.03, +0.02] | 16 | 18 | 466 |
| Overrun (min) | 0.00 [0.00, 0.00] | 0 | 0 | 500 |

| Group (wait, min: median / p95 / max) | Patients pooled | FCFS | HQMS policy |
| --- | --- | --- | --- |
| A: on-time appointments | 4147 | 32.5 / 96.0 / 146.7 | 21.8 / 98.0 / 156.6 |
| W: walk-ins and late admissions | 2748 | 29.7 / 90.1 / 154.8 | 45.5 / 98.1 / 175.3 |
| P: authorized priority | 373 | 30.5 / 86.0 / 146.6 | 8.4 / 27.8 / 51.8 |

| Appointment start delay, on-time appointments incl. priority (called minus booked time, min) | FCFS | HQMS policy |
| --- | --- | --- |
| Patients pooled | 4382 | 4382 |
| Median | 27.8 | 16.0 |
| p95 | 90.8 | 91.8 |
| Share called more than 15 min after the booked time | 63.0% | 51.0% |


## 7. Findings

All statements below describe the simulated sessions above and nothing else.

1. **The policy does not create capacity.** Doctor utilization, completed visits by 13:00 and overrun
   are the same under both policies (paired overrun difference 0.00 in every trial of every scenario;
   completed by 13:00 differs in at most 34 of 500 trials and the mean difference is within
   0.03 visits with an interval that includes zero). In the overloaded scenario both policies
   overrun by about 35 minutes on average. A queue order moves waiting between patients; it does not
   remove it. This matches report section 5.5.
2. **Median wait improves, slightly, in all four scenarios.** The pooled median falls by 0.6, 0.8, 2.2
   and 3.3 minutes (appointment-heavy, walk-in-heavy, priority-heavy, overloaded), and the paired
   per-trial median difference has an interval below zero in each. The mean wait is essentially
   unchanged (within 0.1 minute), so the policy redistributes waiting rather than reducing it.
3. **The policy is worse in the tail, in every scenario.** Pooled p95 wait rises by 4.0, 5.8, 6.9 and
   4.4 minutes; the mean longest wait per trial rises by 3.2, 3.4, 8.5 and 6.4 minutes (paired 95%
   intervals exclude zero); the share of patients waiting more than 45 minutes rises by 1.4, 1.9, 3.2
   and 3.1 percentage points; and the share of trials with at least one such wait rises by 8.4, 10.0,
   20.2 and 8.0 points. The worst single wait seen in any trial is longer under the policy in the
   walk-in-heavy (113 vs 98 min), priority-heavy (145 vs 120 min) and overloaded (175 vs 155 min)
   scenarios and equal in the appointment-heavy one. FCFS is, by construction, the order that keeps the
   longest wait small; the policy gives that up on purpose. Aging bounds the damage only loosely: it
   fired 0.5 to 5.6 times per trial and waits well beyond 45 minutes still occur, because aging is a
   trigger, priority can displace it, and a busy doctor cannot be preempted (report Q&A 7).
4. **Walk-in and late-admission patients pay for it.** Group W waits are longer under the policy in
   every scenario: p95 +14.2 min (appointment-heavy), +10.6 (walk-in-heavy), +18.6 (priority-heavy),
   +8.0 (overloaded); the W median also rises (+0.3, +0.8, +2.7 and +15.8 min, the last from 29.7 to
   45.5 min). This is the A,A,W 2:1 rotation doing what it was designed to do, and it is the main cost.
5. **Appointment patients gain.** Group A median waits fall in three scenarios and stay at 0.0 minutes
   in the walk-in-heavy one. A's p95 wait improves
   clearly when load is moderate (35.0 to 30.8 and 35.7 to 21.1 min) but is slightly worse in the
   priority-heavy (46.5 to 47.3) and overloaded (96.0 to 98.0) scenarios, where priority calls and
   aging overrides take turns from the rotation. Calls more than 15 minutes after the booked time fall
   from 15.0% to 11.6%, 15.3% to 6.7%, 27.4% to 19.0% and 63.0% to 51.0% of on-time appointments.
6. **Authorized priority works as designed, and costs others.** Group P waits fall sharply in the
   priority-heavy scenario (median 9.2 to 4.4, p95 49.5 to 25.4 min) and in the overloaded one
   (median 30.5 to 8.4 min). The FCFS arm has no priority, so this compares the full policy with a
   baseline lacking the feature. Against the supplementary FCFS-with-priority arm in the priority-heavy
   scenario, P waits are identical, group A improves (median 7.3 to 4.9 min), and group W is worse
   (median 11.2 to 13.0, p95 57.4 to 66.2 min): the rotation and aging add a further shift from
   walk-ins to appointments on top of priority.
7. **Light load makes the choice matter little.** In the appointment-heavy scenario utilization is
   about 67% and absolute differences are small (median -0.6 min, p95 +4.0 min). The policy's effects
   grow with congestion (priority-heavy and overloaded).

Summary of the trade-off, in simulation: relative to FCFS the policy shortens the typical wait and the
appointment start delay and protects authorized-priority patients, at the cost of longer waits for
walk-in and late patients and a heavier tail (p95, longest wait, share beyond 45 minutes). Whether that
trade is acceptable is a clinic policy decision; this evidence only quantifies it.

## 8. Limitations

- Simulation, not hospital measurement. All arrivals, durations, no-show and priority rates are
  synthetic assumptions chosen to exercise the policy (report section 5.5: approved synthetic planning
  assumptions). Real arrival patterns, interruptions and consultation lengths will differ.
- One doctor and one session at a time. Cross-doctor effects, reception workload, re-entries after a
  skipped call and manual staff actions are not modelled.
- Called patients are assumed present and start at once; the 2-minute call timeout and SKIPPED/ABSENT
  paths are not simulated. Late admissions are assumed approved immediately.
- Authorized priority is assigned at arrival by a random draw. Real priority is a clinical decision and
  can change; priority is modelled as independent of consultation length.
- Walk-in capacity is the default 5 and walk-ins beyond it are turned away identically under both
  policies; refused patients are not counted in any wait.
- The 45-minute aging value is a trigger, not a deadline or guarantee, and the 2:1 rotation is a design
  choice evaluated here, not shown to be optimal. Other rotations and thresholds were not explored.
- Paired intervals are normal approximations over 500 trials per scenario and ignore multiple
  comparisons. Differences of a few tenths of a minute should not be over-read.
- The simulation does not validate clinical outcomes, patient satisfaction or safety.
- The same code path as the API (`selectNext`) is used, but the simulation does not exercise the
  database, locking or idempotency; those are covered by the concurrency tests (T1/T2).
