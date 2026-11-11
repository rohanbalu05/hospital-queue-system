-- D-022: one active appointment per patient per session (booked or checked in).
-- Cancelled, rescheduled, missed and completed appointments do not count, so a patient can rebook
-- after cancelling and a reschedule may return to an earlier session.
CREATE UNIQUE INDEX appointments_active_patient_session_uq
  ON appointments (patient_id, session_id)
  WHERE status IN ('booked', 'checked_in');
