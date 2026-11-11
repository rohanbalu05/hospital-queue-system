-- 0004: hardening from the Wave 0-1 review (DECISIONS D-022).
--
-- 1. Case-insensitive unique email. The API looks users up with lower(email); the plain UNIQUE on `email`
--    (kept) is case-sensitive, so "A@x.com" and "a@x.com" could both exist. Emails that differ only by case
--    must now conflict.
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

-- 2. Composite ownership: a row that carries its own patient_id must agree with its parent's patient_id,
--    so a version can never cite another patient's instruction and a message never sits in another
--    patient's conversation (NFR-06), whatever the application code does. The single-column FKs stay.
ALTER TABLE instructions  ADD CONSTRAINT instructions_id_patient_uq  UNIQUE (id, patient_id);
ALTER TABLE conversations ADD CONSTRAINT conversations_id_patient_uq UNIQUE (id, patient_id);

ALTER TABLE instruction_versions
  ADD CONSTRAINT instruction_versions_instruction_patient_fk
  FOREIGN KEY (instruction_id, patient_id) REFERENCES instructions (id, patient_id);

ALTER TABLE messages
  ADD CONSTRAINT messages_conversation_patient_fk
  FOREIGN KEY (conversation_id, patient_id) REFERENCES conversations (id, patient_id);
