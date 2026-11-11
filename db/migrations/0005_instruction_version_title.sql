-- 0005: each instruction version carries its own title (Wave 3, FR-13).
--
-- The title of a verified instruction belongs to the version the clinician verified: version 2 may be
-- retitled, and version 1 must keep showing what was actually verified. The column is nullable so rows
-- written before this migration (backfilled below) and direct inserts stay valid; readers use
-- COALESCE(iv.title, i.title). The immutability trigger now covers the title as well.
ALTER TABLE instruction_versions ADD COLUMN title text;

-- The trigger forbids every update except current -> superseded; switch it off for the one-off backfill.
ALTER TABLE instruction_versions DISABLE TRIGGER instruction_versions_immutable_trg;
UPDATE instruction_versions iv SET title = i.title FROM instructions i WHERE i.id = iv.instruction_id;
ALTER TABLE instruction_versions ENABLE TRIGGER instruction_versions_immutable_trg;

CREATE OR REPLACE FUNCTION instruction_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.verified_by IS DISTINCT FROM OLD.verified_by
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.instruction_id IS DISTINCT FROM OLD.instruction_id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NOT (OLD.status = 'current' AND NEW.status = 'superseded') THEN
    RAISE EXCEPTION 'instruction_versions rows are immutable (only current -> superseded allowed)';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
