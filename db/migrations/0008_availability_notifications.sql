-- 0008: doctor availability lifecycle, notification delivery, patient transfer (B1-B3; DECISIONS D-032..D-034).
--
-- No new session status: "Away" is the user-facing name of `paused` (paused_at / pause_until / pause_reason
-- already hold since / expected return / reason). This migration only adds what the new features store.

-- 1. In-app notifications carry where to go and how loud they are. Existing rows keep NULL link / 'info'.
ALTER TABLE notifications
  ADD COLUMN link     text,
  ADD COLUMN severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'urgent'));

-- 2. Delivery log: one row per recipient per channel per event ("Notifications sent", admin).
--    in_app rows are written 'sent' together with the notification; sms/email rows start 'queued' and are
--    sent by the worker's deliver_notification job through the NotificationProvider adapter (fake by default),
--    outside any transaction. The unique key makes at-least-once dispatch idempotent.
CREATE TABLE notification_deliveries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id             uuid REFERENCES outbox_events(id),
  notification_id      uuid REFERENCES notifications(id),
  recipient_user_id    uuid REFERENCES users(id),        -- NULL for a patient without a login (SMS only)
  patient_id           uuid REFERENCES patients(id),
  channel              text NOT NULL CHECK (channel IN ('in_app', 'sms', 'email')),
  address              text NOT NULL,                    -- phone, email, or 'in-app'; masked on every read
  body                 text NOT NULL,
  status               text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  provider             text,
  provider_message_id  text,
  attempts             integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error           text,
  session_id           uuid REFERENCES sessions(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  CONSTRAINT notification_deliveries_recipient_ck CHECK (recipient_user_id IS NOT NULL OR patient_id IS NOT NULL),
  CONSTRAINT notification_deliveries_sent_ck CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT notification_deliveries_event_uq UNIQUE (event_id, channel, address)
);
CREATE INDEX notification_deliveries_time_idx ON notification_deliveries (created_at DESC);
CREATE INDEX notification_deliveries_session_idx ON notification_deliveries (session_id, created_at DESC);

-- 3. Transfer of a checked-in patient to another doctor's session (B3, D-033).
--    The old visit ends as 'transferred' (not 'left': the patient did not walk out); the new visit is kind
--    'transfer' and points back to it. The original appointment is not touched.
ALTER TABLE visits DROP CONSTRAINT visits_kind_check;
ALTER TABLE visits ADD CONSTRAINT visits_kind_check
  CHECK (kind IN ('appointment', 'walkin', 'late_admission', 'transfer'));
ALTER TABLE visits DROP CONSTRAINT visits_status_check;
ALTER TABLE visits ADD CONSTRAINT visits_status_check
  CHECK (status IN ('open', 'in_service', 'completed', 'left', 'transferred'));
ALTER TABLE visits ADD COLUMN transferred_from_visit_id uuid REFERENCES visits(id);
CREATE UNIQUE INDEX visits_transferred_from_uq ON visits (transferred_from_visit_id)
  WHERE transferred_from_visit_id IS NOT NULL;
