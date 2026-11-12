/** Display name of the hospital shown in the shells. Demo data; configurable later from the admin area. */
export const HOSPITAL_NAME = 'BMSIT Teaching Hospital, Yelahanka';
/** Short form for narrow screens. */
export const HOSPITAL_SHORT_NAME = 'BMSIT Hospital';
export const HOSPITAL_PLACE = 'Bengaluru';

/** The dev-only primitives gallery is excluded from production builds. */
export const DEV_ROUTES = import.meta.env.DEV;

/** Demo accounts and the shared password are shown only in dev builds, or when the build sets VITE_DEMO=true. */
export const SHOW_DEMO = import.meta.env.DEV || import.meta.env.VITE_DEMO === 'true';

export const DEMO_PASSWORD = 'demo1234';
export const DEMO_ACCOUNTS = [
  { role: 'Admin', email: 'admin@hqms.test', opens: 'Sessions, capacity and reports' },
  { role: 'Reception', email: 'reception@hqms.test', opens: 'Arrivals and the session board' },
  { role: 'Doctor', email: 'doctor@hqms.test', opens: 'Now panel and call next' },
  { role: 'Follow-up', email: 'followup@hqms.test', opens: 'Owned task inbox' },
  { role: 'Patient', email: 'patient@hqms.test', opens: 'Booking and my visit' },
] as const;
