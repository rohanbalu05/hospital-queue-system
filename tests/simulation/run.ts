/**
 * CLI: runs every scenario and writes the evidence files.
 *
 *   pnpm --filter @hqms/tests simulate [-- --trials 500] [-- --out <dir>] [-- --no-report]
 *
 * Writes results.json, summary.csv, per-trial.csv and results.sha256 (SHA-256 of results.json) to the
 * output directory (default docs/evidence/simulation), and renders
 * docs/evidence/simulation-fcfs-vs-policy.md from report.template.txt unless --no-report is given.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TRIALS } from './model.js';
import { renderReport } from './report.js';
import { perTrialCsv, runAll, summaryCsv, toJson } from './simulate.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const trials = Number(argValue('--trials') ?? DEFAULT_TRIALS);
if (!Number.isInteger(trials) || trials < 1) throw new Error('--trials must be a positive integer');
const outDir = resolve(argValue('--out') ?? join(repoRoot, 'docs', 'evidence', 'simulation'));
const writeReport = !process.argv.includes('--no-report');

const { output, perTrial } = runAll(trials);
const json = toJson(output);
const sha = createHash('sha256').update(json).digest('hex');

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'results.json'), json);
writeFileSync(join(outDir, 'summary.csv'), summaryCsv(output));
writeFileSync(join(outDir, 'per-trial.csv'), perTrialCsv(perTrial));
writeFileSync(join(outDir, 'results.sha256'), `${sha}  results.json\n`);

if (writeReport) {
  const template = readFileSync(join(here, 'report.template.txt'), 'utf8');
  writeFileSync(
    join(repoRoot, 'docs', 'evidence', 'simulation-fcfs-vs-policy.md'),
    renderReport(template, output, sha),
  );
}

console.log(`scenarios: ${output.scenarios.map((s) => s.name).join(', ')}`);
console.log(`trials per scenario: ${trials}`);
console.log(`results.json sha256: ${sha}`);
console.log(`written to ${outDir}`);
