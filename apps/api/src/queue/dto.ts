import type { z } from 'zod';
import type {
  MarkUnavailableRequest,
  PauseSessionRequest,
  QueueCommandResult,
  QueueEntryActionRequest,
  SetPriorityRequest,
  VisitActionRequest,
} from '@hqms/contracts';

/** The contracts package exports these without inferred types; infer them once here. */
export type VisitActionRequestDto = z.infer<typeof VisitActionRequest>;
export type QueueEntryActionRequestDto = z.infer<typeof QueueEntryActionRequest>;
export type SetPriorityRequestDto = z.infer<typeof SetPriorityRequest>;
export type PauseSessionRequestDto = z.infer<typeof PauseSessionRequest>;
export type MarkUnavailableRequestDto = z.infer<typeof MarkUnavailableRequest>;
export type QueueCommandResultDto = z.infer<typeof QueueCommandResult>;
