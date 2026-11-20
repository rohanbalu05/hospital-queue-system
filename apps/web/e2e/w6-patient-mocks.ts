import type { Page, Route } from '@playwright/test';
import { mockW5, type W5Mock, type W5World } from './w5-patient-mocks';
import { NOW, TODAY } from './scheduling-mocks';

/**
 * Wave 6 patient mock: the care team's reply on follow-ups (PR-14) and red-flag advice from the assistant (PR-13).
 * Layered over mockW5 (appointments, today's visits, sessions, cancel); the clock is fixed at 10:05 am IST on 11 Nov 2026.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const at = (hhmm: string, date = TODAY) => `${date}T${hhmm}:00+05:30`;

export const ADVICE = 'If you have chest pain, trouble breathing, fainting or a swollen face or throat, call 108 or come to the Emergency department now.';
export const CONVERSATION_ID = uuid(0xc601);

export interface FollowUpRow {
  id: string;
  kind: 'post_visit' | 'assistant_escalation' | 'document_review' | 'return_visit';
  summary: string;
  status: 'open' | 'acknowledged' | 'resolved' | 'cancelled';
  dueAt: string;
  disposition: 'advice_given' | 'return_booked' | 'referred' | 'no_action_needed' | 'unreachable' | null;
  returnAppointmentId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  reply?: string | null;
  repliedAt?: string | null;
  urgent?: boolean;
}

export interface MessageRow {
  id: string;
  role: 'patient' | 'assistant';
  body: string;
  outcome: 'answered' | 'escalated' | 'refused' | null;
  citations: unknown[];
  escalationTaskId: string | null;
  escalationDueAt: string | null;
  urgentAdvice?: string | null;
  createdAt: string;
}

export interface W6World extends W5World {
  followUps: FollowUpRow[];
  messages: MessageRow[];
}

export function sampleFollowUps(): FollowUpRow[] {
  return [
    {
      id: uuid(0xf601),
      kind: 'assistant_escalation',
      summary: 'Your question for the follow-up team',
      status: 'acknowledged',
      dueAt: at('12:05'),
      disposition: null,
      returnAppointmentId: null,
      createdAt: at('10:05'),
      resolvedAt: null,
      urgent: true,
    },
    {
      id: uuid(0xf602),
      kind: 'assistant_escalation',
      summary: 'Your question for the follow-up team',
      status: 'resolved',
      dueAt: at('16:00', '2026-11-10'),
      disposition: 'advice_given',
      returnAppointmentId: null,
      createdAt: at('09:12', '2026-11-10'),
      resolvedAt: at('14:10', '2026-11-10'),
      reply: 'Please stop the new tablet tonight and bring the strip to the Paediatrics desk tomorrow at 9 am. Call 108 if the dizziness gets worse.',
      repliedAt: at('14:10', '2026-11-10'),
    },
    {
      id: uuid(0xf603),
      kind: 'post_visit',
      summary: 'Check-in after your visit',
      status: 'resolved',
      dueAt: at('11:00', '2026-11-04'),
      disposition: 'no_action_needed',
      returnAppointmentId: null,
      createdAt: at('09:30', '2026-11-03'),
      resolvedAt: at('10:20', '2026-11-04'),
      reply: null,
    },
    {
      id: uuid(0xf604),
      kind: 'document_review',
      summary: 'Review of your uploaded document',
      status: 'open',
      dueAt: at('15:00', '2026-11-12'),
      disposition: null,
      returnAppointmentId: null,
      createdAt: at('08:40'),
      resolvedAt: null,
    },
  ];
}

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

export async function mockW6(page: Page, seed: Partial<W6World> = {}): Promise<W6World & { w5: W5Mock; asked: string[] }> {
  const w5 = await mockW5(page, seed);
  const world = Object.assign(w5.world, { followUps: [] as FollowUpRow[], messages: [] as MessageRow[], ...seed }) as W6World;
  const asked: string[] = [];

  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname.replace(/^\/api/, '');
      const method = req.method();

      if (method === 'GET' && path === '/me/follow-ups') return json(route, 200, world.followUps);
      if (method === 'GET' && path === '/assistant/conversations') {
        return json(route, 200, world.messages.length ? [{ id: CONVERSATION_ID, createdAt: at('09:12'), lastMessageAt: NOW.toISOString() }] : []);
      }
      if (method === 'GET' && path === `/assistant/conversations/${CONVERSATION_ID}/messages`) return json(route, 200, world.messages);
      if (method === 'POST' && path === '/assistant/messages') {
        const { question } = req.postDataJSON() as { question: string };
        asked.push(question);
        const red = /chest pain|breathless|faint/i.test(question);
        const n = world.messages.length;
        world.messages.push({ id: uuid(0x7c00 + n), role: 'patient', body: question, outcome: null, citations: [], escalationTaskId: null, escalationDueAt: null, createdAt: at('10:04') });
        const dueAt = red ? at('12:05') : at('16:00', '2026-11-12');
        const reply: MessageRow = {
          id: uuid(0x7c80 + n),
          role: 'assistant',
          body: 'Sent to the follow-up team.',
          outcome: 'escalated',
          citations: [],
          escalationTaskId: uuid(0xf6a0 + n),
          escalationDueAt: dueAt,
          urgentAdvice: red ? ADVICE : null,
          createdAt: at('10:05'),
        };
        world.messages.push(reply);
        return json(route, 200, {
          conversationId: CONVERSATION_ID,
          messageId: reply.id,
          outcome: 'escalated',
          answer: reply.body,
          citations: [],
          escalation: { taskId: reply.escalationTaskId, dueAt, ...(red ? { urgent: true } : {}) },
          urgentAdvice: reply.urgentAdvice,
          createdAt: reply.createdAt,
        });
      }
      return route.fallback();
    },
  );

  return Object.assign(world, { w5, asked });
}
