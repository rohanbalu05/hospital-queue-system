import path from 'node:path';
import type { Page } from '@playwright/test';
import { mockApi, type DemoRole } from './mocks';
import { mockScheduling, type SchedulingMock, type SchedulingOptions } from './scheduling-mocks';
import { mockWave3, type Wave3Mock } from './w3-mocks';

export const SHOTS = path.resolve(import.meta.dirname, '../../../docs/evidence/screenshots');

/** Screenshot with CSS animations and transitions finished, so nothing is captured mid-motion. */
export async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage, animations: 'disabled' });
}

export interface World {
  sched: SchedulingMock;
  w3: Wave3Mock;
}

/** /me for `role`, the scheduling mock (sessions, doctors, appointments) and the Wave 3 mock on top. */
export async function setupW3(page: Page, role: DemoRole, options: SchedulingOptions = {}): Promise<World> {
  await mockApi(page, role);
  const sched = await mockScheduling(page, options);
  const w3 = await mockWave3(page, sched, role === 'patient' ? 'patient' : role === 'doctor' ? 'doctor' : role === 'admin' ? 'admin' : role === 'reception' ? 'reception' : 'followup');
  return { sched, w3 };
}
