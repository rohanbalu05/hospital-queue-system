-- 0006: the audit trail is append-only (FR-15, NFR-06).
--
-- audit_events rows are written once and never changed or removed by the application, a migration script or a
-- stray statement: UPDATE and DELETE raise. (A privileged operator can still drop the trigger deliberately; that
-- is a schema change, visible in review, not something the app can do by accident.) Same approach as
-- instruction_versions_immutable in 0001/0005.
CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% is not allowed)', TG_OP
    USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_append_only_trg ON audit_events;
CREATE TRIGGER audit_events_append_only_trg
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
