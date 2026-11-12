// Prints markdown tables from a T5 load raw JSON (run: node tests/load/summarise-raw.mjs docs/evidence/T5-load-30min.raw.json)
import { readFileSync } from 'node:fs';
const raw = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const f = (x) => (x === undefined || x === null || Number.isNaN(x) ? 'n/a' : String(x));
for (const ph of raw.phases) {
  console.log(`\n### phase ${ph.name}: target ${ph.targetRps}/s x ${ph.plannedSeconds}s, started ${ph.startedAt}`);
  console.log(`achieved ${ph.achievedRps} req/s over ${ph.actualIssueSeconds}s, requests ${ph.requestsCompleted}, peak in flight ${ph.peakInFlight}, scheduler lag p99 ${ph.schedulerLagMs.p99} ms`);
  const o = ph.latencyMs;
  console.log('| Class | n | p50 | p95 | p99 | max | status |\n| --- | ---: | ---: | ---: | ---: | ---: | --- |');
  const row = (n, d, st) => console.log(`| ${n} | ${d.n} | ${f(d.p50)} | ${f(d.p95)} | ${f(d.p99)} | ${f(d.max)} | ${st} |`);
  row('**overall**', o.overall, '');
  row('reads', o.reads, '');
  row('writes', o.writes, '');
  for (const [c, d] of Object.entries(o.perClass)) row(c, d, JSON.stringify(d.byStatus) + (d.byCode && Object.keys(d.byCode).length ? ' ' + JSON.stringify(d.byCode) : '') + (d.networkErrors ? ' NET ' + JSON.stringify(d.networkErrors) : ''));
  const s = ph.status;
  console.log(`status: total ${s.total}, 2xx ${s.ok2xx}, expected 409 ${s.expected409} ${JSON.stringify(s.expected409ByCode)}, other 4xx ${s.other4xxUnexpected}, 5xx ${s.serverError5xx}, transport ${s.networkErrorOrTimeout}; unexpected samples ${JSON.stringify(s.unexpectedSamples.slice(0, 5))}`);
  console.log(`process events ${JSON.stringify(s.processEvents)}; apiAliveAtEnd ${s.apiAliveAtEnd}; workerAliveAtEnd ${s.workerAliveAtEnd}`);
  console.log(`cycles ${JSON.stringify(ph.cycles)}`);
  const d = ph.durability;
  console.log(`durability: dAppointments ${d.deltaAppointments} vs book201 ${d.successfulBook201}; dEntries ${d.deltaQueueEntries} vs arrivals ${d.successfulArrivals}; dCompleted ${d.deltaCompletedEntries} vs cycles ${d.completedCyclesObserved}`);
  console.log(`invariants: ${ph.invariants.monitorChecks.length} monitor checks, max violations ${Math.max(0, ...ph.invariants.monitorChecks.map((c) => c.violations))}, final ${JSON.stringify(ph.invariants.final)}; slowest check ${Math.max(0, ...ph.invariants.monitorChecks.map((c) => c.ms))} ms`);
  console.log(`resources ${JSON.stringify(ph.resources)}`);
  console.log(`apiRssTrend ${JSON.stringify(ph.apiRssTrend)}; workerRssTrend ${JSON.stringify(ph.workerRssTrend)}`);
  const sm = ph.samples;
  if (sm.length > 10) {
    const q = (k) => sm.map((x) => x[k]).filter((v) => v !== undefined);
    const mx = (a) => Math.max(...a);
    console.log(`load1 range ${Math.min(...q('load1'))}..${mx(q('load1'))}; system CPU max ${mx(q('systemCpuPct'))}; other DB tx/s max ${mx(q('otherDbTxPerSec'))}`);
    const thirds = [0, 1, 2].map((i) => sm.slice(Math.floor((sm.length * i) / 3), Math.floor((sm.length * (i + 1)) / 3)));
    console.log('RSS by third (api/worker mean MB): ' + thirds.map((t) => `${(t.reduce((a, x) => a + (x.apiRssMb ?? 0), 0) / t.length).toFixed(1)}/${(t.reduce((a, x) => a + (x.workerRssMb ?? 0), 0) / t.length).toFixed(1)}`).join(' | '));
  }
  console.log(`errors per 10 s bucket ${JSON.stringify(s.networkErrorsPer10sBucket)}`);
  console.log(`machine timeline (every 60 s): ${(ph.machineTimeline ?? []).map((m) => `${m.tSec}s load ${m.load1} [${m.busyProcesses}]`).join('; ')}`);
}
console.log('\nidle', JSON.stringify(raw.idleAfterRun), 'deaths', JSON.stringify(raw.processDeaths?.map((d) => ({ p: d.process, shutdown: d.expectedShutdownByHarness, ...d.exitInfo }))));
console.log('logErrorCounts api', raw.apiLogErrorCount, 'worker', raw.workerLogErrorCount, raw.apiLogErrorLines?.slice(0, 3));
console.log('env', JSON.stringify(raw.environment.machine), JSON.stringify(raw.environment.dataset));
