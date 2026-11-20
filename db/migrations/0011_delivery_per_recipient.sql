-- 0011: one SMS/email per RECIPIENT, not per address (security review P1, D-039).
-- Two patients can share a phone (a parent and a child). With UNIQUE (event_id, channel, address) only the first
-- patient's SMS row was written; the second patient, perhaps without a login, was silently never told. The key now
-- includes the patient, so each patient gets their own row; replays of the same event stay idempotent.
-- NULLS NOT DISTINCT (PostgreSQL 15+) keeps staff rows (patient_id NULL) unique per address, as before.
ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_event_uq;
ALTER TABLE notification_deliveries
  ADD CONSTRAINT notification_deliveries_event_uq UNIQUE NULLS NOT DISTINCT (event_id, channel, address, patient_id);
