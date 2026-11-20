-- 0010: persona-review fixes (B6; DECISIONS D-038).

-- 1. Follow-up answers the patient can read (PR-14) and urgent escalations (PR-13).
--    `patient_reply` is written by staff on resolve and shown on the patient's Follow-ups page; the existing
--    `outcome_note` stays staff-only. `urgent` sorts red-flag escalations first and shortens their due time.
ALTER TABLE follow_up_tasks
  ADD COLUMN patient_reply    text,
  ADD COLUMN patient_reply_at timestamptz,
  ADD COLUMN urgent           boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT follow_up_reply_ck CHECK ((patient_reply IS NULL) = (patient_reply_at IS NULL));
CREATE INDEX follow_up_tasks_urgent_idx ON follow_up_tasks (urgent, status, due_at) WHERE urgent;

-- 2. Worker heartbeat (PR-01/PR-02): /health and the admin system panel can tell a dead worker from an idle one.
CREATE TABLE worker_heartbeats (
  worker_id        text PRIMARY KEY,
  job_types        text[] NOT NULL DEFAULT '{}',   -- empty = every job type
  dispatch_outbox  boolean NOT NULL,
  started_at       timestamptz NOT NULL,
  last_seen_at     timestamptz NOT NULL
);

-- 3. Staff lifecycle (PR-42): the users table already has `active`; a login session of a deactivated user or a user
--    whose password was reset is revoked by deleting their auth_sessions rows. Record who changed what in audit only.
--    Patient phone lookups for duplicate detection (PR-22) use patients_phone_idx (0001) and lower(full_name) (0001).
