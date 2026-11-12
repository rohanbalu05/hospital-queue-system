import { z } from 'zod';
import {
  type AcknowledgeTaskRequest,
  type CancelTaskRequest,
  FollowUpStatus,
  Id,
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
