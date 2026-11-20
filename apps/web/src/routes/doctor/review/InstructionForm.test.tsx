import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InstructionVersion } from '@hqms/contracts';
import { InstructionForm } from './InstructionForm';

// Radix Select expects pointer-capture and scrollIntoView, which jsdom lacks.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const currentVersion: InstructionVersion = {
  id: uuid(0x71),
  instructionId: uuid(0x72),
  patientId: uuid(0x73),
  version: 2,
  title: 'Diabetes care after discharge',
  body: 'Check sugar before breakfast.',
  status: 'current',
  verifiedBy: uuid(0x74),
  verifiedByName: 'Dr. Meenakshi Rao',
  verifiedAt: '2026-11-09T10:00:00+05:30',
  supersedesId: uuid(0x70),
  sourceDraftId: null,
};

describe('InstructionForm, new version of an existing instruction (B4)', () => {
  it('sends instructionId and the current version id as expectedCurrentVersionId', async () => {
    const user = userEvent.setup();
    const onVerify = vi.fn();
    render(
      <InstructionForm
        initialTitle="Diabetes care after discharge"
        initialBody="Check sugar before breakfast and at bedtime."
        current={[currentVersion]}
        sourceDraftId={uuid(4)}
        pending={false}
        error={null}
        onVerify={onVerify}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Save as' }));
    await user.click(await screen.findByRole('option', { name: /New version of/ }));
    await user.click(screen.getByRole('button', { name: 'Verify instruction' }));
    expect(onVerify).toHaveBeenCalledWith({
      title: 'Diabetes care after discharge',
      body: 'Check sugar before breakfast and at bedtime.',
      instructionId: currentVersion.instructionId,
      expectedCurrentVersionId: currentVersion.id,
      sourceDraftId: uuid(4),
    });
  });

  it('sends neither field for a brand new instruction', async () => {
    const user = userEvent.setup();
    const onVerify = vi.fn();
    render(
      <InstructionForm initialTitle="Back pain care" initialBody="Avoid lifting for 2 weeks." current={[currentVersion]} pending={false} error={null} onVerify={onVerify} />,
    );
    await user.click(screen.getByRole('button', { name: 'Verify instruction' }));
    const sent = onVerify.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('instructionId');
    expect(sent).not.toHaveProperty('expectedCurrentVersionId');
  });

  it('on a 409 tells the doctor someone else verified meanwhile and offers a refresh', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(
      <InstructionForm
        initialTitle="Diabetes care"
        initialBody="Check sugar."
        current={[currentVersion]}
        pending={false}
        error="Conflict"
        conflict
        onRefresh={onRefresh}
        onVerify={vi.fn()}
      />,
    );
    expect(screen.getByText(/another doctor verified a newer version/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Refresh instructions' }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
