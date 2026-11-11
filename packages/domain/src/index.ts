export type {
  DecisionReason,
  Group,
  Instant,
  PriorityClass,
  QueueEntryState,
  SessionStatus,
} from './types.js';
export { MINUTE_MS, toMs } from './types.js';

export { DEFAULT_POLICY, normalizePointer, rotationLabel, validatePolicy } from './policy.js';
export type { Policy } from './policy.js';

export { classifyArrival, computeEligibleAt, isEligible } from './eligibility.js';
export type { ArrivalClass, EligibilityBasis } from './eligibility.js';

export { selectNext } from './select.js';
export type { Candidate, Selection, SelectionInput } from './select.js';

export { projectOrder, simulatePolicyOrder } from './projection.js';
export type { ProjectedStep, ProjectionInput } from './projection.js';

export {
  InvalidTransitionError,
  TRANSITIONS,
  allowedTransitions,
  assertTransition,
  canTransition,
  isTerminal,
} from './lifecycle.js';
export type {
  AppointmentStatus,
  DocumentStatus,
  FollowUpStatus,
  MachineName,
  MachineStates,
  QueueEntryStatus,
  VisitStatus,
} from './lifecycle.js';

export {
  COLD_START_BAND,
  COLD_START_SAMPLES,
  WARM_BAND,
  ewmaUpdate,
  initialEstimator,
  projectEta,
  recordConsultation,
} from './eta.js';
export type { Estimator, Eta, EtaInput, EtaStatus } from './eta.js';
