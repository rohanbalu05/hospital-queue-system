import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Raw machine-readable numbers of the last run; the evidence markdown quotes them. */
export const RESULTS_FILE =
  process.env['T1_RESULTS_FILE'] ?? resolve(here, '..', '..', 'docs', 'evidence', 'T1-booking-collision.raw.json');

/** Evidence file for the authorization suite. */
export const AUTHZ_RESULTS_FILE = resolve(here, '..', '..', 'docs', 'evidence', 'authz-tests.raw.json');

/** Raw numbers of the T2 (policy + doctor guard) and T3 (live freshness) suites. */
export const T2_RESULTS_FILE = resolve(here, '..', '..', 'docs', 'evidence', 'T2-policy-doctor-guard.raw.json');
export const T3_RESULTS_FILE = resolve(here, '..', '..', 'docs', 'evidence', 'T3-live-freshness.raw.json');

/** Merge `data` under `key` into the results file (test files run one after another, never concurrently). */
export function recordResult(key: string, data: unknown, file: string = RESULTS_FILE): void {
  let current: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      current = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      current = {};
    }
  }
  current[key] = data;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
}
