import type { Page } from '@playwright/test';
import type { Wave3Mock, TaskRow } from './w3-mocks';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export const T_URGENT = uuid(0x7a10);
export const T_RECOVERY = uuid(0x7a01);
export const T_BP = uuid(0x7a03);
export const T_NO_VISIT = uuid(0x7a11);
const T_DERM_DONE = uuid(0x7a05);

const PHONES: Record<string, string> = {};
let nextPhone = 12301;
const phoneFor = (patientId: string) => (PHONES[patientId] ??= `+91 98450 ${nextPhone++}`);

/**
 * Wave 6 additions on top of the Wave 3 follow-up mock (D-038): MRN, phone and doctor on every task, an urgent red-flag
 * escalation, a task with a doctorName but no source visit, a resolved task that carries the reply the patient was sent,
 * and a resolve route that stores patientReply (the Wave 3 handler ignores it).
 */
export async function applyW6(page: Page, w3: Wave3Mock): Promise<void> {
  w3.tasks.forEach((t, i) => {
    t.patientMrn = `MRN-${(204100 + i * 7).toString()}`;
    t.patientPhone = phoneFor(t.patientId);
    t.doctorName = (t.sourceVisit as { doctorName?: string } | null | undefined)?.doctorName ?? null;
  });

  const bp = w3.tasks.find((t) => t.id === T_BP) as TaskRow;
  const recovery = w3.tasks.find((t) => t.id === T_RECOVERY) as TaskRow;
  const derm = w3.tasks.find((t) => t.id === T_DERM_DONE) as TaskRow;
  derm.patientReply = 'Good to hear the rash is settling. Please keep using the cream for 7 days and come back if it spreads.';

  w3.tasks.push({
    ...bp,
    id: T_URGENT,
    patientId: recovery.patientId,
    patientName: 'Harish Gowda',
    kind: 'assistant_escalation',
    title: 'Question: dizzy after the new tablets',
    detail: 'Patient asked through the assistant: "I feel dizzy after the new tablets. Should I stop taking them?" Possible adverse reaction. Red-flag symptom reported.',
    sourceMessageId: uuid(0x7b10),
    status: 'open',
    dueAt: new Date('2026-11-11T05:30:00Z').toISOString(),
    overdue: false,
    urgent: true,
    version: 1,
    patientMrn: 'MRN-204102',
    patientPhone: phoneFor(recovery.patientId),
    doctorName: 'Dr. Meenakshi Rao',
  });

  // A task whose API row has the doctor's name but no source-visit detail: the return dialog must still default to that doctor.
  w3.tasks.push({
    ...bp,
    id: T_NO_VISIT,
    patientId: bp.patientId,
    patientName: bp.patientName,
    title: 'Call to arrange a review of the thyroid profile',
    detail: 'Dr. Rao wants a review of the thyroid profile. Book a morning session if possible.',
    status: 'acknowledged',
    acknowledgedAt: new Date('2026-11-11T03:40:00Z').toISOString(),
    version: 2,
    sourceVisit: null,
    patientMrn: 'MRN-204119',
    patientPhone: phoneFor(bp.patientId),
    doctorName: 'Dr. Meenakshi Rao',
  });

  await page.route(
    (url) => /^\/api\/follow-up-tasks\/[^/]+\/resolve$/.test(url.pathname),
    async (route) => {
      const id = new URL(route.request().url()).pathname.split('/')[3];
      const body = (route.request().postDataJSON?.() ?? {}) as { patientReply?: string };
      const t = w3.tasks.find((x) => x.id === id);
      if (t && body.patientReply) t.patientReply = body.patientReply;
      await route.fallback();
    },
  );
}
