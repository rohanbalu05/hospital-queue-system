import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusWord } from './status';

const moved = { sessionId: '00000000-0000-4000-8000-000000000e01', doctorName: 'Dr. Farah Siddiqui', room: 'Room 7', token: 'W-004' };

describe('StatusWord for a patient who was moved to another doctor', () => {
  it('reads "Moved to Dr. Y (token)" for staff instead of "Checked in"', () => {
    render(<StatusWord status="checked_in" transferredTo={moved} showToken />);
    expect(screen.getByText('Moved to Dr. Farah Siddiqui (W-004)')).toBeVisible();
    expect(screen.queryByText('Checked in')).toBeNull();
  });

  it('reads "Moved to Dr. Y" for the patient, without the token', () => {
    render(<StatusWord status="checked_in" transferredTo={moved} />);
    expect(screen.getByText('Moved to Dr. Farah Siddiqui')).toBeVisible();
  });

  it('keeps the plain status word when nothing moved', () => {
    render(<StatusWord status="checked_in" transferredTo={null} />);
    expect(screen.getByText('Checked in')).toBeVisible();
  });

  it('uses a neutral tone, not the done green', () => {
    render(<StatusWord status="checked_in" transferredTo={moved} />);
    expect(screen.getByText('Moved to Dr. Farah Siddiqui')).toHaveClass('text-muted-foreground');
  });
});
