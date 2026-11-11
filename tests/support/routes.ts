/**
 * Derives the API route table (method, path, allowed roles, public or not) from the Nest controllers' own
 * decorators, so a newly added route is covered by the authorization suite automatically instead of
 * depending on a hand-maintained list.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RoleName = 'patient' | 'reception' | 'doctor' | 'followup' | 'admin';

export interface RouteInfo {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** e.g. `/appointments/:id/cancel` */
  path: string;
  /** `null` for a @Public() route. */
  roles: RoleName[] | null;
  file: string;
}

const ALL_ROLES: RoleName[] = ['patient', 'reception', 'doctor', 'followup', 'admin'];
const STAFF_ROLES: RoleName[] = ['reception', 'doctor', 'followup', 'admin'];

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..', '..', 'apps', 'api', 'src');

function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...controllerFiles(full));
    else if (name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

function parseRoles(args: string): RoleName[] {
  const roles = new Set<RoleName>();
  if (args.includes('...ALL_ROLES')) ALL_ROLES.forEach((r) => roles.add(r));
  if (args.includes('...STAFF_ROLES')) STAFF_ROLES.forEach((r) => roles.add(r));
  for (const m of args.matchAll(/'([a-z]+)'/g)) roles.add(m[1] as RoleName);
  return [...roles];
}

export function listRoutes(): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const file of controllerFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    const prefix = /@Controller\(\s*(?:'([^']*)')?\s*\)/.exec(text)?.[1] ?? '';
    let isPublic = false;
    let roles: RoleName[] | undefined;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t.startsWith('@Public(')) isPublic = true;
      const r = /^@Roles\((.*)\)\s*$/.exec(t);
      if (r) roles = parseRoles(r[1] ?? '');
      const m = /^@(Get|Post|Patch|Put|Delete)\(\s*(?:'([^']*)')?\s*\)\s*$/.exec(t);
      if (m) {
        const path = `/${[prefix, m[2] ?? ''].filter((p) => p !== '').join('/')}`;
        routes.push({
          method: (m[1] as string).toUpperCase() as RouteInfo['method'],
          path,
          roles: isPublic ? null : (roles ?? []),
          file: file.slice(SRC.length + 1),
        });
        isPublic = false;
        roles = undefined;
      }
    }
  }
  return routes.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
}

/** Replace `:param` segments with a syntactically valid UUID that matches no row. */
export function fillPath(path: string, uuid = '00000000-0000-4000-8000-000000000000'): string {
  return path.replace(/:[A-Za-z]+/g, uuid);
}
