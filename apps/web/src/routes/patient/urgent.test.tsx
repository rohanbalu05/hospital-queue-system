import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import type { ConversationMessage } from '@hqms/contracts';
import { RequireRole } from '@/components/layout/Guards';
import { Providers, patientUser, stubApi, testQueryClient, uuid } from '@/lib/testing';
import AssistantPage, { MessageView } from './AssistantPage';

afterEach(() => vi.unstubAllGlobals());
beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
});

const ADVICE = 'If you have chest pain, trouble breathing, fainting or a swollen face or throat, call 108 or come to the Emergency department now.';
const me = patientUser(1, 'Ananya Iyer');
const CONVERSATION = uuid(0xc01);

const escalated = (over: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: uuid(0x7b1),
  role: 'assistant',
  body: 'Sent to the follow-up team.',
  outcome: 'escalated',
  citations: [],
  escalationTaskId: uuid(0x7a1),
  escalationDueAt: '2026-11-11T12:05:00+05:30',
  urgentAdvice: ADVICE,
  createdAt: '2026-11-11T10:05:00+05:30',
  ...over,
});

describe('urgent advice on an assistant message (PR-13)', () => {
  it('shows the advice first, labelled Urgent, with both call links, then the escalation text', () => {
    const { container } = render(
      <ul>
        <MessageView message={escalated()} />
      </ul>,
    );
    const callout = screen.getByTestId('urgent-advice');
    expect(callout).toHaveTextContent('Urgent');
    expect(callout).toHaveTextContent(ADVICE);
    expect(within(callout).getByRole('link', { name: 'Call 108' })).toHaveAttribute('href', 'tel:108');
    expect(within(callout).getByRole('link', { name: /Call the hospital.*080 4123 4500/ })).toHaveAttribute('href', 'tel:08041234500');
    // The callout comes before the escalation wording in document order.
    const escalation = screen.getByText(/Sent to the follow-up team\./);
    expect(callout.compareDocumentPosition(escalation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('svg')).not.toBeNull();
    // An urgent question is promised a reply within 2 hours.
    expect(screen.getByText(/within 2 hours/)).toBeVisible();
    expect(screen.getByText(/11 Nov, 12:05 pm/)).toBeVisible();
  });

  it('is not an alert when it is only history, and is one when it is the answer just received', () => {
    const { rerender } = render(
      <ul>
        <MessageView message={escalated()} />
      </ul>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(
      <ul>
        <MessageView message={escalated()} announce />
      </ul>,
    );
    expect(screen.getByRole('alert')).toHaveAttribute('data-testid', 'urgent-advice');
  });

  it('shows no callout when there is no advice', () => {
    render(
      <ul>
        <MessageView message={escalated({ urgentAdvice: null })} />
      </ul>,
    );
    expect(screen.queryByTestId('urgent-advice')).toBeNull();
    expect(screen.queryByText(/within 2 hours/)).toBeNull();
  });
});

describe('Questions page with a red-flag question', () => {
  it('announces the urgent advice once when it arrives', async () => {
    const messages: ConversationMessage[] = [];
    stubApi(({ method, path }) => {
      if (path === '/me') return { body: me };
      if (method === 'GET' && path === '/assistant/conversations') return { body: messages.length ? [{ id: CONVERSATION, createdAt: '2026-11-11T10:00:00+05:30', lastMessageAt: '2026-11-11T10:05:00+05:30' }] : [] };
      if (method === 'GET' && path === `/assistant/conversations/${CONVERSATION}/messages`) return { body: messages };
      if (method === 'POST' && path === '/assistant/messages') {
        messages.push(
          escalated({ id: uuid(0x7b0), role: 'patient', body: 'I have chest pain after the new tablets', outcome: null, escalationTaskId: null, escalationDueAt: null, urgentAdvice: null, createdAt: '2026-11-11T10:04:00+05:30' }),
          escalated(),
        );
        return {
          body: {
            conversationId: CONVERSATION,
            messageId: uuid(0x7b1),
            outcome: 'escalated',
            answer: 'Sent to the follow-up team.',
            citations: [],
            escalation: { taskId: uuid(0x7a1), dueAt: '2026-11-11T12:05:00+05:30', urgent: true },
            urgentAdvice: ADVICE,
            createdAt: '2026-11-11T10:05:00+05:30',
          },
        };
      }
      return undefined;
    });
    render(
      <Providers qc={testQueryClient()} initial={['/patient/questions']}>
        <Routes>
          <Route element={<RequireRole roles={['patient']} />}>
            <Route path="/patient/questions" element={<AssistantPage />} />
          </Route>
        </Routes>
      </Providers>,
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Your question'), 'I have chest pain after the new tablets');
    await user.click(screen.getByRole('button', { name: 'Ask question' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ADVICE);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(within(alert).getByRole('link', { name: 'Call 108' })).toBeVisible();
  });
});
