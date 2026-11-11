/** Display name of the hospital shown in the shells. Demo data; configurable later from the admin area. */
export const HOSPITAL_NAME = 'BMSIT Teaching Hospital, Yelahanka';
export const HOSPITAL_PLACE = 'Bengaluru';

/** The dev-only primitives gallery is excluded from production builds. */
export const DEV_ROUTES = import.meta.env.DEV;

export const DEMO_PASSWORD = 'demo1234';
export const DEMO_ACCOUNTS = [
  { role: 'Admin', email: 'admin@hqms.test', opens: 'Sessions, capacity and reports' },
  { role: 'Reception', email: 'reception@hqms.test', opens: 'Arrivals and the session board' },
  { role: 'Doctor', email: 'doctor@hqms.test', opens: 'Now panel and call next' },
  { role: 'Follow-up', email: 'followup@hqms.test', opens: 'Owned task inbox' },
  { role: 'Patient', email: 'patient@hqms.test', opens: 'Booking and my visit' },
] as const;
