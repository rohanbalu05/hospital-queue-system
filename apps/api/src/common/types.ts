import type { z } from 'zod';
import type {
  AppointmentListQuery,
  CancelAppointmentRequest,
  CreateSessionRequest,
  SessionListQuery,
} from '@hqms/contracts';

/** The contracts package exports these schemas without inferred types; infer them once here. */
export type AppointmentListQueryDto = z.infer<typeof AppointmentListQuery>;
export type CancelAppointmentRequestDto = z.infer<typeof CancelAppointmentRequest>;
export type CreateSessionRequestDto = z.infer<typeof CreateSessionRequest>;
export type SessionListQueryDto = z.infer<typeof SessionListQuery>;
