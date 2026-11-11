import { ModulesContainer, Reflector } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IS_PUBLIC, ROLES_KEY } from '../src/identity/auth.decorators.js';
import { createTestApp, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

describe('default deny across the whole application (FR-01, NFR-06)', () => {
  it('every controller route declares roles or is explicitly public', () => {
    const reflector = new Reflector();
    const modules = t.app.get(ModulesContainer);
    const undeclared: string[] = [];
    let routes = 0;
    for (const m of modules.values()) {
      for (const c of m.controllers.values()) {
        const meta = c.metatype as (new (...args: never[]) => unknown) | null;
        if (!meta) continue;
        const proto = meta.prototype as Record<string, unknown>;
        for (const name of Object.getOwnPropertyNames(proto)) {
          const fn = proto[name];
          if (name === 'constructor' || typeof fn !== 'function') continue;
          if (Reflect.getMetadata('path', fn) === undefined) continue; // not a route handler
          routes += 1;
          const targets = [fn as (...args: unknown[]) => unknown, meta];
          const isPublic = reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets);
          const roles = reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY as never, targets) as string[] | undefined;
          if (!isPublic && (!roles || roles.length === 0)) undeclared.push(`${meta.name}.${name}`);
        }
      }
    }
    expect(routes).toBeGreaterThan(60);
    expect(undeclared).toEqual([]);
  });

  it('the Wave 3 routes all answer 401 without a session', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const probes: Array<[string, string]> = [
      ['post', '/follow-up-tasks'],
      ['get', '/follow-up-tasks'],
      ['get', `/follow-up-tasks/${id}`],
      ['post', `/follow-up-tasks/${id}/acknowledge`],
      ['post', `/follow-up-tasks/${id}/resolve`],
      ['post', `/follow-up-tasks/${id}/cancel`],
      ['post', `/follow-up-tasks/${id}/return-booking`],
      ['get', '/me/follow-ups'],
      ['post', '/documents'],
      ['get', '/documents'],
      ['get', `/documents/${id}`],
      ['get', `/documents/${id}/file`],
      ['get', `/documents/${id}/drafts`],
      ['post', `/documents/${id}/retry-ocr`],
      ['post', `/documents/${id}/verify`],
      ['get', '/review-inbox'],
      ['get', '/instructions'],
      ['post', '/assistant/messages'],
      ['get', '/assistant/conversations'],
      ['get', `/assistant/conversations/${id}/messages`],
      ['get', '/reports/operations'],
      ['get', '/notifications'],
      ['post', `/notifications/${id}/read`],
    ];
    for (const [method, path] of probes) {
      const res = await (request(t.server) as unknown as Record<string, (p: string) => request.Test>)[method]!(path);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});
