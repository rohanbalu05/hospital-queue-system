#!/usr/bin/env node
// Runs a command with the given directories appended, keeping only those that exist.
// Usage: node scripts/run-on-existing.mjs "<dirs space separated>" -- <cmd> [args...]
// Lets depcruise/semgrep tolerate packages (apps/api, packages/db, ...) that are not built yet.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [dirsArg, sep, cmd, ...args] = process.argv.slice(2);
if (sep !== '--' || !cmd) {
  console.error('usage: run-on-existing.mjs "<dirs>" -- <cmd> [args...]');
  process.exit(2);
}
const dirs = dirsArg.split(/\s+/).filter((d) => d && existsSync(d));
if (dirs.length === 0) {
  console.log('run-on-existing: no matching directories, nothing to do');
  process.exit(0);
}
const res = spawnSync(cmd, [...args, ...dirs], { stdio: 'inherit' });
if (res.error) {
  console.error(res.error.message);
  process.exit(127);
}
process.exit(res.status ?? 1);
