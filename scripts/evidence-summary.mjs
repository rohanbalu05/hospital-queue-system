// Renders docs/evidence/SUMMARY.md from feature_list.json + a requirement→code/evidence map.
// Measured numbers live in the evidence files; this table links them and keeps target vs measured apart.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const list = JSON.parse(readFileSync('feature_list.json', 'utf8'));
const commit = execSync('git rev-parse --short HEAD').toString().trim();
const today = new Date().toISOString().slice(0, 10);

const code = {
  'FR-01': 'apps/api/src/identity, apps/api/src/access (AuthGuard, RolesGuard, AccessPolicy, PatientScope)',
  'FR-02': 'apps/api/src/scheduling + catalogue; packages/db/src/capacity.ts (updateCapacity); db/migrations/0001 (queue_policies, sessions, session_capacity)',
  'FR-03': 'apps/api/src/scheduling/appointments.service.ts; packages/db/src/{tx,locks,capacity,idempotency}.ts',
  'FR-04': 'apps/api/src/scheduling/appointments.service.ts (cancel, reschedule: reserve target first)',
  'FR-05': 'apps/api/src/arrivals; packages/domain/src/eligibility.ts (classifyArrival, computeEligibleAt)',
  'FR-06': 'packages/domain/src/select.ts (selectNext), apps/api/src/queue/queue.service.ts (call-next)',
  'FR-07': 'apps/api/src/queue/queue.service.ts (doctor → session locks, cross-session occupied check); db partial unique index queue_entries_doctor_active_uq',
  'FR-08': 'apps/api/src/queue (consultation, entry actions, session controls); apps/worker/src/handlers/timers.ts (call_timeout)',
  'FR-09': 'apps/api/src/live (SSE poller), apps/api/src/queue/snapshot.service.ts; apps/web/src/live',
  'FR-10': 'packages/domain/src/eta.ts (EWMA, simulated-time projection); apps/api/src/queue/pressure.ts',
  'FR-11': 'apps/api/src/followup',
  'FR-12': 'apps/api/src/documents (upload limits, private storage); packages/providers (ObjectStorage, OcrProvider); apps/worker/src/handlers/documents.ts',
  'FR-13': 'apps/api/src/documents (verify, versions); db trigger instruction_versions_immutable',
  'FR-14': 'apps/api/src/assistant (deny-list, current versions only, escalation); packages/providers/src/llm.ts; apps/api/src/followup (return booking)',
  'FR-15': 'packages/db/src/writers.ts (writeAudit), apps/api/src/reports, queue_decisions table; db/migrations/0006 (append-only audit)',
  'NFR-01': 'whole stack', 'NFR-02': 'apps/api/src/live', 'NFR-03': 'packages/db (lock order, capacity guard), db constraints',
  'NFR-04': 'n/a (operations)', 'NFR-05': 'docs/runbook.md backup/restore', 'NFR-06': 'apps/api/src/access + every controller @Roles',
  'NFR-07': 'apps/worker (leases, retries), packages/providers adapters outside transactions', 'NFR-08': 'db/migrations, init.sh, apps/web keyboard paths',
};
const evidence = {
  'FR-03': 'T1-booking-collision.md', 'FR-04': 'T1-booking-collision.md', 'FR-05': 'T1-booking-collision.md',
  'FR-06': 'T2-policy-doctor-guard.md, simulation-fcfs-vs-policy.md', 'FR-07': 'T2-policy-doctor-guard.md', 'FR-08': 'T2-policy-doctor-guard.md, e2e-full-visit.md',
  'FR-09': 'T3-live-freshness.md', 'FR-10': 'T3-live-freshness.md (ETA calibration inconclusive)', 'FR-11': 'T4-followup-instruction-controls.md',
  'FR-12': 'T4-followup-instruction-controls.md', 'FR-13': 'T4-followup-instruction-controls.md', 'FR-14': 'T4-followup-instruction-controls.md',
  'FR-15': 'T6-reproducibility-operations.md', 'FR-01': 'authz-tests.md, T4-followup-instruction-controls.md', 'FR-02': 'unit-tests.md',
  'NFR-01': 'T5-workload-failure.md', 'NFR-02': 'T3-live-freshness.md', 'NFR-03': 'T1-booking-collision.md, T2-policy-doctor-guard.md',
  'NFR-04': 'T5-workload-failure.md §6 (method only)', 'NFR-05': 'T5-workload-failure.md (restore drill)', 'NFR-06': 'authz-tests.md, T4-followup-instruction-controls.md',
  'NFR-07': 'T5-workload-failure.md, T4-followup-instruction-controls.md, dynamic-analysis.md', 'NFR-08': 'T6-reproducibility-operations.md, e2e-full-visit.md, uat-checklist.md',
};
const targets = {
  'NFR-01': '100 req/s for 30 min, p95 ≤ 500 ms; 200 req/s for 60 s, p95 ≤ 1 s',
  'NFR-02': '200 clients; freshness p95 ≤ 5 s; unexpected errors < 1%',
  'NFR-03': '0 oversubscriptions / duplicate entries / double allocations',
  'NFR-04': '99.5% availability in operating hours',
  'NFR-05': 'RPO ≤ 15 min, RTO ≤ 60 min (hosted)',
  'NFR-06': '0 unauthorized cross-patient reads/writes',
  'NFR-07': 'committed ops survive restarts; provider failure does not block core',
};
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const rows = list.map((e) => {
  const req = e.requirement;
  const ev = (evidence[req] ?? '').split(', ').filter(Boolean).map((f) => {
    const file = f.split(' ')[0];
    return existsSync(`docs/evidence/${file}`) ? `[${f}](${file})` : f;
  }).join(', ');
  const status = e.passes ? 'PASS (test green this session)' : 'NOT MET / pending';
  const measured = e.verified ?? e.note ?? '';
  return `| ${e.id} | ${esc(e.acceptance)} | ${esc(code[req])} | \`${esc(e.test)}\` | ${ev} | ${status} | ${esc(measured)} |`;
});
const passed = list.filter((e) => e.passes).length;
const md = `# Evidence summary

Generated by \`node scripts/evidence-summary.mjs\` from \`feature_list.json\` on ${today}, commit \`${commit}\`.

**Rule:** a *target* is a Phase 1 acceptance value; a *measured* number comes from a run in this repository, on the declared environment (one shared 4 vCPU VM, API/worker/PostgreSQL/load generator co-located, fake OCR/LLM providers). No target below is presented as achieved unless a run met it, and local results are not claims about the hosted Google Cloud reference, which was not deployed.

**Status:** ${passed} of ${list.length} acceptance criteria have a test that ran green in this session.

## Non-functional targets vs measured

| NFR | Target (Phase 1) | Measured here | Verdict |
| --- | --- | --- | --- |
${Object.entries(targets).map(([id, t]) => {
  const e = list.find((x) => x.requirement === id);
  return `| ${id} | ${t} | ${esc(e?.verified ?? e?.note ?? '')} | ${e?.passes ? 'Met locally' : 'Not demonstrated'} |`;
}).join('\n')}

## Requirement → code → test → evidence

| Criterion | Acceptance | Code | Test | Evidence | Status | Measured / notes |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

## Phase 2 syllabus evidence

| Syllabus item | File |
| --- | --- |
| Construction plan, package structure | [construction-plan.md](../construction/construction-plan.md) |
| Configuration management | [config-management.md](../construction/config-management.md) |
| Development environment | README.md, init.sh, docker-compose.yml |
| Code review | docs/gates/G0–G4.md (reviewer findings and dispositions), DECISIONS.md D-022, D-028, D-029 |
| Static code analysis | [static-analysis.md](static-analysis.md) |
| Build and unit testing | .github/workflows/ci.yml, [unit-tests.md](unit-tests.md), coverage-summary.json |
| Dynamic code analysis | [dynamic-analysis.md](dynamic-analysis.md) |
| Integration / system / performance / security testing | T1–T6 files above, [authz-tests.md](authz-tests.md), [simulation-fcfs-vs-policy.md](simulation-fcfs-vs-policy.md) |
| User acceptance testing | [uat-checklist.md](uat-checklist.md) (scripted; not executed by users) |
| Rollout strategy | [rollout-plan.md](../construction/rollout-plan.md), [runbook](../runbook.md) |
`;
writeFileSync('docs/evidence/SUMMARY.md', md);
console.log(`SUMMARY.md: ${passed}/${list.length}`);
