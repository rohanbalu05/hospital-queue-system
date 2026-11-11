import { z } from 'zod';
import {
  QueueEntryActionRequest,
  type MarkUnavailableRequest,
  type PauseSessionRequest,
  type QueueCommandResult,
  type SetPriorityRequest,
  type VisitActionRequest,
} from '@hqms/contracts';

/**
 * POST /queue-entries/{id}/re-enter. The contract's QueueEntryActionRequest plus `admitLate`, which
 * reception sets to confirm a returning group-A patient who is now past the grace period (FR-05-b / FR-08-b).
 */
export const ReEnterRequest = QueueEntryActionRequest.extend({ admitLate: z.boolean().optional() });
export type ReEnterRequest = z.infer<typeof ReEnterRequest>;

/** The contracts package exports these without inferred types; infer them once here. */
export type VisitActionRequestDto = z.infer<typeof VisitActionRequest>;
export type QueueEntryActionRequestDto = z.infer<typeof QueueEntryActionRequest>;
export type SetPriorityRequestDto = z.infer<typeof SetPriorityRequest>;
export type PauseSessionRequestDto = z.infer<typeof PauseSessionRequest>;
export type MarkUnavailableRequestDto = z.infer<typeof MarkUnavailableRequest>;
export type QueueCommandResultDto = z.infer<typeof QueueCommandResult>;
