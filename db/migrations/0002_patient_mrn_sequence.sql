-- 0002: MRN generator. A sequence hands out numbers without taking any lock, so registering a patient
-- never interferes with the doctor -> session -> capacity lock order. Gaps after a rollback are fine.
-- Seeded demo patients use BLR-000001..BLR-000099 explicitly; generated numbers start at 1000.
CREATE SEQUENCE patient_mrn_seq START WITH 1000 MINVALUE 1000;
