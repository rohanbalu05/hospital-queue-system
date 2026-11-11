import { z } from 'zod';
import {
  type AcknowledgeTaskRequest,
  type CancelTaskRequest,
  type FollowUpKind,
  FollowUpStatus,
  Id,
  type Disposition,
} from '@hqms/contracts';

export type AcknowledgeTaskRequestDto = z.infer<typeof AcknowledgeTaskRequest>;
export type CancelTaskRequestDto = z.infer<typeof CancelTaskRequest>;

const BoolString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

/**
 * GET /follow-up-tasks. The contract's `FollowUpListQuery` uses `z.coerce.boolean()`, which turns the string
 * "false" into `true`; this schema parses `overdue=false` correctly. Same fields otherwise.
 */
export const FollowUpListQueryParams = z.object({
  owner: z.enum(['me', 'unassigned', 'all']).default('me'),
  status: FollowUpStatus.optional(),
  overdue: BoolString.optional(),
  patientId: Id.optional(),
});
export type FollowUpListQueryDto = z.infer<typeof FollowUpListQueryParams>;

/**
 * What a patient sees of a staff task (GET /me/follow-ups): status and timing only. Staff titles, details,
 * outcome notes and owner names stay on the staff side; the summary is fixed wording per kind.
 */
export interface PatientFollowUp {
  id: string;
  kind: z.infer<typeof FollowUpKind>;
  summary: string;
  status: z.infer<typeof FollowUpStatus>;
  dueAt: string;
  disposition: Disposition | null;
  returnAppointmentId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}
