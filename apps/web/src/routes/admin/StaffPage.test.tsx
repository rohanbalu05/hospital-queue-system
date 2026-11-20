import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StaffMember } from '@hqms/contracts';
import { Providers, stubApi, testQueryClient, uuid, type Handler } from '@/lib/testing';
import StaffPage from './StaffPage';

afterEach(() => vi.unstubAllGlobals());

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});

const DOCTORS = [
  { id: uuid(0xd1), fullName: 'Dr. Meenakshi Rao', department: 'General Medicine', room: '12', active: true },
  { id: uuid(0xd2), fullName: 'Dr. Arvind Kulkarni', department: 'Paediatrics', room: '4', active: true },
  { id: uuid(0xd3), fullName: 'Dr. Farah Siddiqui', department: 'ENT', room: '7', active: true },
];
const ME = {
  userId: uuid(1),
  email: 'admin@hqms.test',
  displayName: 'Anil Shetty',
  role: 'admin',
  patientId: null,
  doctorId: null,
  assignedDoctorIds: [],
};
const STAFF: StaffMember[] = [
  { userId: uuid(1), displayName: 'Anil Shetty', email: 'admin@hqms.test', role: 'admin', doctorIds: [], active: true, doctorId: null },
  { userId: uuid(2), displayName: 'Deepa Nair', email: 'deepa.nair@hospital.example', role: 'reception', doctorIds: [DOCTORS[0]!.id], active: true, doctorId: null },
  { userId: uuid(3), displayName: 'Dr. Meenakshi Rao', email: 'meenakshi.rao@hospital.example', role: 'doctor', doctorIds: [], active: true, doctorId: DOCTORS[0]!.id },
  { userId: uuid(4), displayName: 'Rakesh Pai', email: 'rakesh.pai@hospital.example', role: 'followup', doctorIds: [], active: false, doctorId: null },
];
const TEMP = 'Marigold-7281-Tiger';

const json = (body: unknown, status = 200) => ({ status, body });
const error = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });

function mount(...handlers: Handler[]) {
  const api = stubApi(
    (r) => (r.method === 'GET' && r.path === '/me' ? json(ME) : undefined),
    (r) => (r.method === 'GET' && r.path === '/doctors' ? json(DOCTORS) : undefined),
    (r) => (r.method === 'GET' && r.path === '/admin/staff' ? json(STAFF) : undefined),
    ...handlers,
  );
  render(
    <Providers qc={testQueryClient()}>
      <StaffPage />
    </Providers>,
  );
  return api;
}

const rowOf = async (name: string) => (await screen.findAllByTestId('staff-row')).find((r) => r.textContent?.includes(name))!;

describe('Staff page: list', () => {
  it('marks a deactivated account with the word, and offers Activate instead of Deactivate', async () => {
    mount();
    const pai = await rowOf('Rakesh Pai');
    expect(pai).toHaveAttribute('data-active', 'false');
    expect(within(pai).getByText('Deactivated')).toBeVisible();
    expect(within(pai).getByRole('button', { name: 'Activate, Rakesh Pai' })).toBeVisible();
    expect(within(pai).queryByRole('button', { name: /^Deactivate/ })).toBeNull();

    const nair = await rowOf('Deepa Nair');
    expect(within(nair).getByText('Active')).toBeVisible();
    expect(within(nair).getByRole('button', { name: 'Deactivate, Deepa Nair' })).toBeVisible();
    expect(within(nair).getByRole('button', { name: 'Reset password, Deepa Nair' })).toBeVisible();
    expect(within(nair).getByRole('button', { name: 'Edit assignments, Deepa Nair' })).toBeVisible();
  });
});

describe('Add staff member', () => {
  async function openDialog(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Add staff member' }));
    return screen.findByRole('dialog', { name: 'Add staff member' });
  }
  async function pickRole(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, role: string) {
    await user.click(within(dialog).getByRole('combobox', { name: 'Role' }));
    await user.click(await screen.findByRole('option', { name: role }));
  }

  it('creates a reception login with doctor assignments and shows the temporary password once', async () => {
    const user = userEvent.setup();
    const posts: Array<{ key: string | null; body: unknown }> = [];
    mount((r) => {
      if (r.method === 'POST' && r.path === '/admin/staff') {
        posts.push({ key: r.headers.get('Idempotency-Key'), body: r.body });
        return json(
          {
            member: { userId: uuid(9), displayName: 'Lata Menon', email: 'lata.menon@hospital.example', role: 'reception', doctorIds: [DOCTORS[1]!.id], active: true, doctorId: null },
            temporaryPassword: TEMP,
          },
          201,
        );
      }
      return undefined;
    });
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText('Name'), 'Lata Menon');
    await user.type(within(dialog).getByLabelText('Email'), 'Lata.Menon@hospital.example');
    await pickRole(user, dialog, 'Reception');
    await user.click(within(dialog).getByRole('checkbox', { name: /Dr\. Arvind Kulkarni/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(posts[0]!.body).toEqual({
      displayName: 'Lata Menon',
      email: 'lata.menon@hospital.example',
      role: 'reception',
      doctorIds: [DOCTORS[1]!.id],
    });

    const pw = await screen.findByRole('dialog', { name: 'Temporary password' });
    expect(pw).toHaveTextContent('Give this to the staff member. It is shown only once.');
    expect(within(pw).getByTestId('temp-password')).toHaveTextContent(TEMP);
    expect(pw).toHaveTextContent('Lata Menon');
    await user.click(within(pw).getByRole('button', { name: 'Copy password' }));
    expect(await navigator.clipboard.readText()).toBe(TEMP);
    await user.click(within(pw).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText(TEMP)).toBeNull();
  });

  it('links an existing doctor that has no login, and does not offer doctors that already have one', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    mount((r) => {
      if (r.method === 'POST' && r.path === '/admin/staff') {
        posts.push(r.body);
        return json({ member: { ...STAFF[2]!, userId: uuid(10), displayName: 'Dr. Arvind Kulkarni', doctorId: DOCTORS[1]!.id }, temporaryPassword: TEMP }, 201);
      }
      return undefined;
    });
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText('Name'), 'Dr. Arvind Kulkarni');
    await user.type(within(dialog).getByLabelText('Email'), 'arvind.kulkarni@hospital.example');
    await pickRole(user, dialog, 'Doctor');
    await user.click(within(dialog).getByRole('combobox', { name: 'Doctor record' }));
    expect(screen.queryByRole('option', { name: /Meenakshi Rao/ })).toBeNull();
    expect(screen.getByRole('option', { name: /Farah Siddiqui/ })).toBeVisible();
    await user.click(screen.getByRole('option', { name: /Arvind Kulkarni/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ displayName: 'Dr. Arvind Kulkarni', email: 'arvind.kulkarni@hospital.example', role: 'doctor', doctorId: DOCTORS[1]!.id });
  });

  it('creates a new doctor record with department and room', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    mount((r) => {
      if (r.method === 'POST' && r.path === '/admin/staff') {
        posts.push(r.body);
        return json({ member: { ...STAFF[2]!, userId: uuid(11), displayName: 'Dr. Pooja Bhat' }, temporaryPassword: TEMP }, 201);
      }
      return undefined;
    });
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText('Name'), 'Dr. Pooja Bhat');
    await user.type(within(dialog).getByLabelText('Email'), 'pooja.bhat@hospital.example');
    await pickRole(user, dialog, 'Doctor');
    await user.click(within(dialog).getByRole('radio', { name: 'Create a new doctor record' }));
    await user.type(within(dialog).getByLabelText('Department'), 'Dermatology');
    await user.type(within(dialog).getByLabelText('Room'), '3');
    await user.click(within(dialog).getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      displayName: 'Dr. Pooja Bhat',
      email: 'pooja.bhat@hospital.example',
      role: 'doctor',
      newDoctor: { department: 'Dermatology', room: '3' },
    });
  });

  it('asks for the missing fields before sending anything', async () => {
    const user = userEvent.setup();
    const api = mount();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Create account' }));
    expect(within(dialog).getByText('Enter the staff member’s full name.')).toBeVisible();
    expect(within(dialog).getByText('Enter a valid email address.')).toBeVisible();
    expect(within(dialog).getByText('Choose a role.')).toBeVisible();
    expect(api.calls.some((c) => c.startsWith('POST'))).toBe(false);
  });

  it('says in words when the email is already in use', async () => {
    const user = userEvent.setup();
    mount((r) => (r.method === 'POST' && r.path === '/admin/staff' ? error(409, 'CONFLICT', 'That email address is already in use.') : undefined));
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText('Name'), 'Lata Menon');
    await user.type(within(dialog).getByLabelText('Email'), 'deepa.nair@hospital.example');
    await pickRole(user, dialog, 'Follow-up');
    await user.click(within(dialog).getByRole('button', { name: 'Create account' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Account not created');
    expect(alert).toHaveTextContent('That email address is already in use.');
  });
});

describe('Deactivate, activate and reset password', () => {
  it('deactivates with a reason', async () => {
    const user = userEvent.setup();
    const calls: Array<{ path: string; key: string | null; body: unknown }> = [];
    mount((r) => {
      if (r.method === 'POST' && r.path.endsWith('/deactivate')) {
        calls.push({ path: r.path, key: r.headers.get('Idempotency-Key'), body: r.body });
        return json({ ...STAFF[1]!, active: false });
      }
      return undefined;
    });
    await user.click(within(await rowOf('Deepa Nair')).getByRole('button', { name: 'Deactivate, Deepa Nair' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate this account?' });
    expect(dialog).toHaveTextContent('signed out');
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate account' }));
    expect(within(dialog).getByText('Give a reason of at least 3 characters.')).toBeVisible();
    expect(calls).toHaveLength(0);
    await user.type(within(dialog).getByLabelText('Reason'), 'Left the hospital');
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate account' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ path: `/admin/staff/${uuid(2)}/deactivate`, body: { reason: 'Left the hospital' } });
    expect(calls[0]!.key).toBeTruthy();
  });

  it('activates a deactivated account with a reason', async () => {
    const user = userEvent.setup();
    const calls: Array<{ path: string; body: unknown }> = [];
    mount((r) => {
      if (r.method === 'POST' && r.path.endsWith('/activate')) {
        calls.push({ path: r.path, body: r.body });
        return json({ ...STAFF[3]!, active: true });
      }
      return undefined;
    });
    await user.click(within(await rowOf('Rakesh Pai')).getByRole('button', { name: 'Activate, Rakesh Pai' }));
    const dialog = await screen.findByRole('dialog', { name: 'Activate this account?' });
    await user.type(within(dialog).getByLabelText('Reason'), 'Returned from leave');
    await user.click(within(dialog).getByRole('button', { name: 'Activate account' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ path: `/admin/staff/${uuid(4)}/activate`, body: { reason: 'Returned from leave' } });
  });

  it('does not let an admin deactivate their own account', async () => {
    const user = userEvent.setup();
    const api = mount();
    await user.click(within(await rowOf('Anil Shetty')).getByRole('button', { name: 'Deactivate, Anil Shetty' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate this account?' });
    await user.type(within(dialog).getByLabelText('Reason'), 'Testing');
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate account' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('You cannot deactivate your own account. Ask another admin to do it.');
    expect(api.calls.some((c) => c.endsWith('/deactivate'))).toBe(false);
  });

  it('explains the last-admin refusal in plain words', async () => {
    const user = userEvent.setup();
    mount((r) => (r.method === 'POST' && r.path.endsWith('/deactivate') ? error(409, 'CONFLICT', 'Cannot deactivate the last active admin.') : undefined));
    await user.click(within(await rowOf('Deepa Nair')).getByRole('button', { name: 'Deactivate, Deepa Nair' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate this account?' });
    await user.type(within(dialog).getByLabelText('Reason'), 'Left the hospital');
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate account' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This is the last active admin. Make another admin account first.');
  });

  it('resets a password with a reason and shows the new temporary password once', async () => {
    const user = userEvent.setup();
    const calls: Array<{ path: string; key: string | null; body: unknown }> = [];
    mount((r) => {
      if (r.method === 'POST' && r.path.endsWith('/reset-password')) {
        calls.push({ path: r.path, key: r.headers.get('Idempotency-Key'), body: r.body });
        return json({ member: STAFF[1]!, temporaryPassword: TEMP });
      }
      return undefined;
    });
    await user.click(within(await rowOf('Deepa Nair')).getByRole('button', { name: 'Reset password, Deepa Nair' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reset password' });
    await user.type(within(dialog).getByLabelText('Reason'), 'Forgot it at the desk');
    await user.click(within(dialog).getByRole('button', { name: 'Reset password' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ reason: 'Forgot it at the desk' });
    const pw = await screen.findByRole('dialog', { name: 'Temporary password' });
    expect(pw).toHaveTextContent('Give this to the staff member. It is shown only once.');
    expect(within(pw).getByTestId('temp-password')).toHaveTextContent(TEMP);
  });
});
