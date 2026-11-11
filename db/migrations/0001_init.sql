-- 0001_init.sql: HQMS initial schema (report §6.9–6.11, Table 12, Table 13).
-- All instants are timestamptz. Enumerations are text + CHECK (DECISIONS D-007).
-- Lock order for every state-changing command: doctors row -> sessions row -> session_capacity row.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Identity, patients, staff
-- ---------------------------------------------------------------------------

CREATE TABLE hospitals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  timezone    text NOT NULL DEFAULT 'Asia/Kolkata',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Stable patient identity, independent of any login (assisted registration).
CREATE TABLE patients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id    uuid NOT NULL REFERENCES hospitals(id),
  mrn            text NOT NULL UNIQUE,            -- hospital record number
  full_name      text NOT NULL,
  phone          text,
  date_of_birth  date,
  created_by     uuid,                            -- users.id (FK added below)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patients_phone_idx ON patients (phone);
CREATE INDEX patients_name_idx ON patients (lower(full_name));

CREATE TABLE doctors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id  uuid NOT NULL REFERENCES hospitals(id),
  full_name    text NOT NULL,
  department   text NOT NULL,
  room         text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id        uuid NOT NULL REFERENCES hospitals(id),
  email              text NOT NULL UNIQUE,
  display_name       text NOT NULL,
  role               text NOT NULL CHECK (role IN ('patient','reception','doctor','followup','admin')),
  identity_provider  text NOT NULL DEFAULT 'local' CHECK (identity_provider IN ('local','identity-platform')),
  idp_subject        text,                        -- subject at the external IdP
  password_hash      text,                        -- argon2id, local provider only
  patient_id         uuid REFERENCES patients(id),
  doctor_id          uuid REFERENCES doctors(id),
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_patient_link CHECK ((role = 'patient') = (patient_id IS NOT NULL)),
  CONSTRAINT users_doctor_link  CHECK (role <> 'doctor' OR doctor_id IS NOT NULL),
  CONSTRAINT users_idp_subject_uq UNIQUE (identity_provider, idp_subject)
);
CREATE UNIQUE INDEX users_patient_uq ON users (patient_id) WHERE patient_id IS NOT NULL;
CREATE UNIQUE INDEX users_doctor_uq  ON users (doctor_id)  WHERE doctor_id IS NOT NULL;

ALTER TABLE patients ADD CONSTRAINT patients_created_by_fk FOREIGN KEY (created_by) REFERENCES users(id);

-- Staff scope: which doctors a reception/followup user works for. Admins are hospital-wide.
CREATE TABLE staff_assignments (
  user_id     uuid NOT NULL REFERENCES users(id),
  doctor_id   uuid NOT NULL REFERENCES doctors(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, doctor_id)
);
CREATE INDEX staff_assignments_doctor_idx ON staff_assignments (doctor_id);

-- Login sessions (httpOnly cookie carries the raw token; only its SHA-256 is stored).
CREATE TABLE auth_sessions (
  token_hash   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);

-- ---------------------------------------------------------------------------
-- Policy and sessions (Table 7)
-- ---------------------------------------------------------------------------

CREATE TABLE queue_policies (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version                  integer NOT NULL UNIQUE CHECK (version > 0),
  rotation                 text[] NOT NULL DEFAULT ARRAY['A','A','W'],
  early_eligibility_min    integer NOT NULL DEFAULT 10 CHECK (early_eligibility_min >= 0),
  late_grace_min           integer NOT NULL DEFAULT 15 CHECK (late_grace_min >= 0),
  aging_trigger_min        integer NOT NULL DEFAULT 45 CHECK (aging_trigger_min > 0),
  called_timeout_sec       integer NOT NULL DEFAULT 120 CHECK (called_timeout_sec > 0),
  ewma_alpha               numeric(4,3) NOT NULL DEFAULT 0.2 CHECK (ewma_alpha > 0 AND ewma_alpha <= 1),
  initial_estimate_min     numeric(6,2) NOT NULL DEFAULT 12 CHECK (initial_estimate_min > 0),
  default_booked_capacity  integer NOT NULL DEFAULT 10 CHECK (default_booked_capacity >= 0),
  default_walkin_capacity  integer NOT NULL DEFAULT 5  CHECK (default_walkin_capacity >= 0),
  note                     text,
  created_by               uuid REFERENCES users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT queue_policies_rotation_ck CHECK (
    array_length(rotation, 1) >= 1 AND rotation <@ ARRAY['A','W']::text[]
  )
);

CREATE TABLE sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id        uuid NOT NULL REFERENCES doctors(id),
  policy_id        uuid NOT NULL REFERENCES queue_policies(id),   -- fixed for the session (report §6.2)
  session_date     date NOT NULL,                                 -- hospital-local date
  label            text NOT NULL CHECK (label IN ('morning','afternoon','evening')),
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  slot_minutes     integer NOT NULL DEFAULT 20 CHECK (slot_minutes > 0),
  status           text NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled','open','paused','unavailable','closed')),
  paused_at        timestamptz,
  pause_until      timestamptz,                                   -- NULL while paused = unknown duration -> ETA withheld
  pause_reason     text,
  rotation_pointer integer NOT NULL DEFAULT 0 CHECK (rotation_pointer >= 0),
  queue_version    bigint  NOT NULL DEFAULT 0,                    -- bumped on every committed queue change
  next_seq_a       integer NOT NULL DEFAULT 1,
  next_seq_w       integer NOT NULL DEFAULT 1,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_time_ck CHECK (ends_at > starts_at),
  CONSTRAINT sessions_doctor_start_uq UNIQUE (doctor_id, starts_at)
);
CREATE INDEX sessions_date_idx ON sessions (session_date, doctor_id);

-- Capacity guard: one row per session, locked after doctor and session.
-- Counters are maintained in the same transaction as capacity_allocations rows.
CREATE TABLE session_capacity (
  session_id        uuid PRIMARY KEY REFERENCES sessions(id),
  booked_capacity   integer NOT NULL CHECK (booked_capacity >= 0),
  walkin_capacity   integer NOT NULL CHECK (walkin_capacity >= 0),
  booked_reserved   integer NOT NULL DEFAULT 0 CHECK (booked_reserved >= 0),  -- reserved + consumed
  walkin_used       integer NOT NULL DEFAULT 0 CHECK (walkin_used >= 0),
  version           integer NOT NULL DEFAULT 1,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_capacity_booked_ck CHECK (booked_reserved <= booked_capacity),
  CONSTRAINT session_capacity_walkin_ck CHECK (walkin_used <= walkin_capacity)
);

-- ---------------------------------------------------------------------------
-- Appointments, allocations, visits, queue
-- ---------------------------------------------------------------------------

CREATE TABLE capacity_allocations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES sessions(id),
  kind         text NOT NULL CHECK (kind IN ('booked','walkin')),
  state        text NOT NULL CHECK (state IN ('reserved','consumed','released')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX capacity_allocations_session_idx ON capacity_allocations (session_id, kind, state);

CREATE TABLE appointments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id            uuid NOT NULL REFERENCES patients(id),
  session_id            uuid NOT NULL REFERENCES sessions(id),
  doctor_id             uuid NOT NULL REFERENCES doctors(id),
  scheduled_at          timestamptz NOT NULL,
  status                text NOT NULL DEFAULT 'booked'
                        CHECK (status IN ('booked','checked_in','completed','cancelled','missed','rescheduled')),
  allocation_id         uuid NOT NULL UNIQUE REFERENCES capacity_allocations(id),
  rescheduled_from_id   uuid REFERENCES appointments(id),
  follow_up_task_id     uuid,                      -- return booking linkage (FK added below)
  booked_by             uuid NOT NULL REFERENCES users(id),
  cancel_reason         text,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appointments_patient_idx ON appointments (patient_id, scheduled_at);
CREATE INDEX appointments_session_idx ON appointments (session_id, status);

CREATE TABLE visits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id       uuid NOT NULL REFERENCES patients(id),
  session_id       uuid NOT NULL REFERENCES sessions(id),
  doctor_id        uuid NOT NULL REFERENCES doctors(id),
  appointment_id   uuid REFERENCES appointments(id),
  allocation_id    uuid NOT NULL UNIQUE REFERENCES capacity_allocations(id),
  kind             text NOT NULL CHECK (kind IN ('appointment','walkin','late_admission')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_service','completed','left')),
  checked_in_at    timestamptz NOT NULL,
  started_at       timestamptz,
  completed_at     timestamptz,
  checked_in_by    uuid NOT NULL REFERENCES users(id),
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- Table 13: one attendance per appointment (unique non-null appointment_id).
CREATE UNIQUE INDEX visits_appointment_uq ON visits (appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX visits_patient_idx ON visits (patient_id, checked_in_at);

CREATE TABLE queue_entries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id           uuid NOT NULL REFERENCES visits(id),
  session_id         uuid NOT NULL REFERENCES sessions(id),
  doctor_id          uuid NOT NULL REFERENCES doctors(id),
  queue_group        text NOT NULL CHECK (queue_group IN ('A','W')),
  token              text NOT NULL,                -- e.g. A-014, W-005
  seq                integer NOT NULL,             -- stable sequence within session (tie-breaker)
  state              text NOT NULL DEFAULT 'waiting'
                     CHECK (state IN ('waiting','called','in_service','completed','skipped','absent','cancelled')),
  scheduled_at       timestamptz,                  -- appointments only
  checked_in_at      timestamptz NOT NULL,
  eligible_at        timestamptz NOT NULL,         -- earliest eligible time; refreshed on re-entry
  priority_class     smallint CHECK (priority_class BETWEEN 1 AND 3),   -- 1 = most urgent
  priority_reason    text,
  priority_set_by    uuid REFERENCES users(id),
  priority_set_at    timestamptz,
  called_at          timestamptz,
  call_count         integer NOT NULL DEFAULT 0,
  skipped_at         timestamptz,
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT queue_entries_scheduled_ck CHECK (queue_group = 'W' OR scheduled_at IS NOT NULL),
  CONSTRAINT queue_entries_priority_ck CHECK ((priority_class IS NULL) = (priority_set_by IS NULL)),
  CONSTRAINT queue_entries_token_uq UNIQUE (session_id, token),
  CONSTRAINT queue_entries_seq_uq UNIQUE (session_id, seq)
);
-- Table 13: one queue entry per admitted visit.
CREATE UNIQUE INDEX queue_entries_visit_uq ON queue_entries (visit_id);
-- Table 13: one active called/in-service allocation per doctor (D-005).
CREATE UNIQUE INDEX queue_entries_doctor_active_uq ON queue_entries (doctor_id) WHERE state IN ('called','in_service');
-- Table 13: queue candidate lookup.
CREATE INDEX queue_entries_candidates_idx ON queue_entries (session_id, state, eligible_at);

-- Explainable decisions (FR-06, FR-15). Separate from current entry state.
CREATE TABLE queue_decisions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          uuid NOT NULL REFERENCES sessions(id),
  doctor_id           uuid NOT NULL REFERENCES doctors(id),
  queue_entry_id      uuid REFERENCES queue_entries(id),          -- NULL for NO_ALLOCATION
  reason              text NOT NULL CHECK (reason IN ('CLINICAL_PRIORITY','AGING','ROTATION','NO_ALLOCATION')),
  rotation_slot       integer,                                    -- pointer position served, ROTATION only
  pointer_before      integer NOT NULL,
  pointer_after       integer NOT NULL,
  policy_version      integer NOT NULL,
  queue_version       bigint NOT NULL,
  explanation         text NOT NULL,                              -- plain-words reason shown to the doctor
  candidates          jsonb NOT NULL DEFAULT '[]'::jsonb,         -- eligible-set snapshot (ids, groups, times)
  decided_at          timestamptz NOT NULL,
  decided_by          uuid NOT NULL REFERENCES users(id)
);
CREATE INDEX queue_decisions_session_idx ON queue_decisions (session_id, decided_at);

-- EWMA estimator state per doctor (D-009).
CREATE TABLE service_estimates (
  doctor_id      uuid PRIMARY KEY REFERENCES doctors(id),
  mean_minutes   numeric(8,3) NOT NULL,
  samples        integer NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Documents, OCR drafts, verified instructions
-- ---------------------------------------------------------------------------

CREATE TABLE documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id       uuid NOT NULL REFERENCES patients(id),
  visit_id         uuid REFERENCES visits(id),
  uploaded_by      uuid NOT NULL REFERENCES users(id),
  storage_key      text NOT NULL UNIQUE,           -- private object reference (never public)
  original_name    text NOT NULL,
  mime_type        text NOT NULL CHECK (mime_type IN ('application/pdf','image/png','image/jpeg')),
  size_bytes       integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),   -- 10 MB
  page_count       integer NOT NULL CHECK (page_count BETWEEN 1 AND 10),
  content_hash     text NOT NULL,                  -- sha256 hex
  status           text NOT NULL DEFAULT 'uploaded'
                   CHECK (status IN ('uploaded','accepted','processing','ocr_ready','ocr_failed','verified','rejected')),
  ocr_attempts     integer NOT NULL DEFAULT 0,
  last_error       text,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_patient_idx ON documents (patient_id, created_at);
CREATE INDEX documents_status_idx ON documents (status, updated_at);

CREATE TABLE ocr_drafts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES documents(id),
  provider      text NOT NULL,
  text          text NOT NULL,                     -- DRAFT: never assistant context
  blocks        jsonb NOT NULL DEFAULT '[]'::jsonb, -- source locations {page, bbox, text}
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ocr_drafts_document_idx ON ocr_drafts (document_id, created_at);

-- An instruction is a lineage; each verification creates an immutable version.
CREATE TABLE instructions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id    uuid NOT NULL REFERENCES patients(id),
  document_id   uuid REFERENCES documents(id),
  visit_id      uuid REFERENCES visits(id),
  title         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX instructions_patient_idx ON instructions (patient_id);

CREATE TABLE instruction_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instruction_id   uuid NOT NULL REFERENCES instructions(id),
  patient_id       uuid NOT NULL REFERENCES patients(id),
  version          integer NOT NULL CHECK (version > 0),
  body             text NOT NULL,
  source_draft_id  uuid REFERENCES ocr_drafts(id),
  status           text NOT NULL CHECK (status IN ('current','superseded')),
  verified_by      uuid NOT NULL REFERENCES users(id),
  verified_at      timestamptz NOT NULL,
  supersedes_id    uuid REFERENCES instruction_versions(id),
  CONSTRAINT instruction_versions_uq UNIQUE (instruction_id, version)
);
CREATE UNIQUE INDEX instruction_versions_current_uq ON instruction_versions (instruction_id) WHERE status = 'current';
CREATE INDEX instruction_versions_patient_idx ON instruction_versions (patient_id, status);

-- Versions are immutable except the current -> superseded transition.
CREATE FUNCTION instruction_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body
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
CREATE TRIGGER instruction_versions_immutable_trg BEFORE UPDATE ON instruction_versions
  FOR EACH ROW EXECUTE FUNCTION instruction_versions_immutable();
CREATE TRIGGER instruction_versions_no_delete_trg BEFORE DELETE ON instruction_versions
  FOR EACH ROW EXECUTE FUNCTION instruction_versions_immutable();

-- ---------------------------------------------------------------------------
-- Follow-up, assistant conversations
-- ---------------------------------------------------------------------------

CREATE TABLE follow_up_tasks (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id              uuid NOT NULL REFERENCES patients(id),
  source_visit_id         uuid REFERENCES visits(id),
  source_message_id       uuid,                        -- FK added below
  kind                    text NOT NULL CHECK (kind IN ('post_visit','assistant_escalation','document_review','return_visit')),
  title                   text NOT NULL,
  detail                  text,
  owner_id                uuid REFERENCES users(id),
  status                  text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved','cancelled')),
  due_at                  timestamptz NOT NULL,
  acknowledged_at         timestamptz,
  disposition             text CHECK (disposition IN ('advice_given','return_booked','referred','no_action_needed','unreachable')),
  outcome_note            text,
  resolved_at             timestamptz,
  resolved_by             uuid REFERENCES users(id),
  return_appointment_id   uuid REFERENCES appointments(id),
  created_by              uuid REFERENCES users(id),     -- NULL when created by the system (assistant)
  version                 integer NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT follow_up_closed_ck CHECK (
    (status = 'resolved')  = (disposition IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT follow_up_return_ck CHECK (disposition IS DISTINCT FROM 'return_booked' OR return_appointment_id IS NOT NULL)
);
-- Table 13: staff work due.
CREATE INDEX follow_up_tasks_owner_idx ON follow_up_tasks (owner_id, status, due_at);
CREATE INDEX follow_up_tasks_patient_idx ON follow_up_tasks (patient_id, status);

ALTER TABLE appointments ADD CONSTRAINT appointments_follow_up_fk FOREIGN KEY (follow_up_task_id) REFERENCES follow_up_tasks(id);

CREATE TABLE conversations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id   uuid NOT NULL REFERENCES patients(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_patient_idx ON conversations (patient_id);

CREATE TABLE messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id       uuid NOT NULL REFERENCES conversations(id),
  patient_id            uuid NOT NULL REFERENCES patients(id),
  role                  text NOT NULL CHECK (role IN ('patient','assistant')),
  body                  text NOT NULL,
  outcome               text CHECK (outcome IN ('answered','escalated','refused')),   -- assistant rows
  source_version_ids    uuid[] NOT NULL DEFAULT '{}',   -- instruction_versions cited
  escalation_task_id    uuid REFERENCES follow_up_tasks(id),
  provider              text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_outcome_ck CHECK ((role = 'assistant') = (outcome IS NOT NULL)),
  CONSTRAINT messages_answer_cites_ck CHECK (outcome IS DISTINCT FROM 'answered' OR cardinality(source_version_ids) > 0),
  CONSTRAINT messages_escalation_ck CHECK (outcome IS DISTINCT FROM 'escalated' OR escalation_task_id IS NOT NULL)
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);

ALTER TABLE follow_up_tasks ADD CONSTRAINT follow_up_source_message_fk FOREIGN KEY (source_message_id) REFERENCES messages(id);

-- ---------------------------------------------------------------------------
-- Shared support: idempotency, audit, outbox, jobs, notifications
-- ---------------------------------------------------------------------------

-- Table 13: repeated request protection.
CREATE TABLE idempotency_records (
  actor_id         uuid NOT NULL REFERENCES users(id),
  operation        text NOT NULL,
  idem_key         text NOT NULL,
  request_hash     text NOT NULL,
  response_status  integer NOT NULL,
  response_body    jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, operation, idem_key)
);

CREATE TABLE audit_events (
  id               bigserial PRIMARY KEY,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  actor_id         uuid REFERENCES users(id),      -- NULL = system/worker
  actor_role       text NOT NULL,                  -- role or 'system'
  operation        text NOT NULL,
  entity_type      text NOT NULL,
  entity_id        uuid NOT NULL,
  previous         jsonb,
  next             jsonb,
  reason           text,
  policy_version   integer,
  correlation_id   text
);
CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id, occurred_at);
CREATE INDEX audit_events_time_idx ON audit_events (occurred_at);

-- Domain events (report §6.7). Minimal routing data only; no clinical text.
CREATE TABLE outbox_events (
  position        bigserial PRIMARY KEY,
  id              uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  event_type      text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       uuid NOT NULL,
  entity_version  integer NOT NULL,
  session_id      uuid REFERENCES sessions(id),
  patient_id      uuid REFERENCES patients(id),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  dispatched_at   timestamptz
);
CREATE INDEX outbox_events_pending_idx ON outbox_events (position) WHERE dispatched_at IS NULL;
CREATE INDEX outbox_events_session_idx ON outbox_events (session_id, position);

-- Durable jobs with leases (FOR UPDATE SKIP LOCKED).
CREATE TABLE jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type          text NOT NULL,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key        text UNIQUE,                   -- stable identity for at-least-once delivery
  state             text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','succeeded','failed','dead','cancelled')),
  run_at            timestamptz NOT NULL DEFAULT now(),
  attempts          integer NOT NULL DEFAULT 0,
  max_attempts      integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  lease_owner       text,
  lease_expires_at  timestamptz,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);
CREATE INDEX jobs_ready_idx ON jobs (run_at) WHERE state IN ('pending','failed');
CREATE INDEX jobs_lease_idx ON jobs (lease_expires_at) WHERE state = 'running';

CREATE TABLE notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id   uuid NOT NULL REFERENCES users(id),
  event_id            uuid REFERENCES outbox_events(id),
  kind                text NOT NULL,
  body                text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  read_at             timestamptz,
  CONSTRAINT notifications_event_uq UNIQUE (recipient_user_id, event_id)
);
CREATE INDEX notifications_recipient_idx ON notifications (recipient_user_id, read_at, created_at);

-- Initial policy version (Table 7).
INSERT INTO queue_policies (version, note) VALUES (1, 'Table 7 approved initial values');
