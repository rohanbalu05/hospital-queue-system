import type { StaffMember } from '@hqms/contracts';
import { plainErrorMessage } from '@/components/queue/states';
import { ApiRequestError } from '@/lib/api';

export type StaffAction = 'deactivate' | 'activate' | 'reset';

/** Staff changes refused by a rule, in plain words. Anything else keeps the message the API wrote for people. */
export function staffErrorWords(err: unknown): string {
  if (!(err instanceof ApiRequestError)) return 'Something went wrong. Try again.';
  const text = `${err.message} ${JSON.stringify(err.details ?? '')}`;
  if (/last\s+(active\s+)?admin|LAST_ADMIN/i.test(text)) return 'This is the last active admin. Make another admin account first.';
  if (/themself|themselves|yourself|own account|SELF_/i.test(text)) return 'You cannot deactivate your own account. Ask another admin to do it.';
  return plainErrorMessage(err) ?? 'Something went wrong. Try again.';
}

/** Doctors with no login yet: the ones a new doctor account can be linked to. */
export function doctorsWithoutLogin<D extends { id: string }>(doctors: D[], staff: StaffMember[]): D[] {
  const linked = new Set(staff.map((m) => m.doctorId).filter((id): id is string => Boolean(id)));
  return doctors.filter((d) => !linked.has(d.id));
}

export const isActive = (m: StaffMember): boolean => m.active !== false;

export const ASSIGNABLE_ROLES: ReadonlyArray<StaffMember['role']> = ['reception', 'followup'];
