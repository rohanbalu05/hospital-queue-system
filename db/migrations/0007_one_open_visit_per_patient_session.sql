-- Codex P1 #2 backstop: a patient holds at most one open or in-service visit per session. A parked (absent or
-- skipped) entry keeps its visit open, so a second admission of the same patient cannot create another place
-- even if an application guard is bypassed. Completed and left visits do not count, so a patient can have a
-- legitimate second visit after the first is finished or abandoned. Visit rows are not deleted, so this
-- needs no data repair for a database where the application guard was in force; a database that already
-- holds duplicates must close the extra visits first (the CREATE fails loudly rather than guessing).
CREATE UNIQUE INDEX visits_one_open_per_patient_session_uq
  ON visits (session_id, patient_id)
  WHERE status IN ('open', 'in_service');
