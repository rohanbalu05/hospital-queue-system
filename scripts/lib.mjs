// Shared helpers for the evidence generators. Node built-ins only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Run a command (no shell) in ROOT; returns { status, stdout, stderr }. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

export function vcsInfo() {
  const hash = run('git', ['rev-parse', '--short=12', 'HEAD']).stdout.trim() || 'unknown';
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim() || 'unknown';
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']).stdout.trim() !== '';
  return { hash, branch, dirty };
}

export function stamp() {
  const g = vcsInfo();
  return { ...g, date: new Date().toISOString(), host: `${process.platform}/${process.arch}, Node ${process.version}` };
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Workspace dirs that contain a package.json: apps/*, packages/*, tests. */
export function workspaceDirs() {
  const out = [];
  for (const group of ['apps', 'packages']) {
    const dir = path.join(ROOT, group);
    if (!fs.existsSync(dir)) continue;
    for (const d of fs.readdirSync(dir).sort()) {
      if (fs.existsSync(path.join(dir, d, 'package.json'))) out.push(`${group}/${d}`);
    }
  }
  if (fs.existsSync(path.join(ROOT, 'tests/package.json'))) out.push('tests');
  return out;
}

export function pkgName(dir) {
  return readJson(path.join(ROOT, dir, 'package.json')).name ?? dir;
}

export function mdTable(header, rows) {
  const esc = (v) => String(v).replaceAll('|', '\\|');
  return [
    `| ${header.map(esc).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n');
}

export function toolVersion(cmd, args = ['--version']) {
  const r = run(cmd, args);
  return (r.stdout || r.stderr).trim().split('\n')[0] || 'not available';
}

export const pct = (n) => (typeof n === 'number' ? `${n.toFixed(2)}%` : 'n/a');
