# Demo seed

`pnpm --filter @hqms/db seed` (or `pnpm db:seed`) runs migrations, then this seed. It is idempotent: stable ids
derived from natural keys, `ON CONFLICT DO NOTHING`, and sessions for dates that do not exist yet are added.
Re-running it on a later day extends the 7-day window without touching existing rows.

`pnpm --filter @hqms/db reset` drops and recreates the `public` schema, migrates and seeds. It refuses unless
the database name has a `test` segment (`hqms_test`, `hqms_test_db_engineer`), `NODE_ENV=development`, or `--force`.

**Production guard.** The seed creates 22 staff accounts with a public password, so it refuses to run
(`SeedRefusedError`, exit code 1) when `NODE_ENV=production` unless `ALLOW_DEMO_SEED=true` is also set. Use the
override only for a throwaway demo deployment (the `docker compose` demo stack must set it on the `api` service,
whose image runs with `NODE_ENV=production`); never on real data.

**Password for every demo account: `demo1234`** (argon2id).

## Data

- Hospital: BMSIT Teaching Hospital, Yelahanka (Asia/Kolkata).
- 5 departments, 2 doctors each (10 doctors): General Medicine, Paediatrics, ENT, Orthopaedics, Dermatology.
- Sessions for today .. today+6 (IST), 2 per doctor per day: morning 09:00-13:00 and afternoon 14:00-18:00,
  20-minute slots, 10 booked + 5 walk-in places, policy version 1. Today is `open`, later days `scheduled`.
- 22 staff: 10 doctors, 6 reception, 4 follow-up, 2 admin. 40 patients (BLR-000001..BLR-000040), 10 with logins.
- 15 demo appointments for today and tomorrow, booked through the real capacity primitives (counters match allocations).

## Accounts

| Email | Role | Scope |
| --- | --- | --- |
| `admin@hqms.test` | admin | hospital-wide |
| `admin2@hqms.test` | admin | hospital-wide |
| `reception@hqms.test` | reception | assigned to all 10 doctors |
| `reception2@hqms.test` .. `reception6@hqms.test` | reception | 2 doctors each |
| `doctor@hqms.test` | doctor | Dr. Suresh Hegde (first General Medicine doctor) |
| `doctor2@hqms.test` .. `doctor10@hqms.test` | doctor | doctors 2..10 in the order below |
| `followup@hqms.test` | followup | assigned to all 10 doctors |
| `followup2@hqms.test` .. `followup4@hqms.test` | followup | 4, 4 and 2 doctors |
| `patient@hqms.test` | patient | Ramesh Kumar (BLR-000001), booked today with `doctor@hqms.test` |
| `patient2@hqms.test` | patient | Sunita Devi (BLR-000002), booked tomorrow with Dr. Meera Krishnamurthy |
| `patient3@hqms.test` .. `patient10@hqms.test` | patient | patients 3..10 |

Doctors, in order: 1 Dr. Suresh Hegde (OPD 1), 2 Dr. Lakshmi Narayan (OPD 2), 3 Dr. Meera Krishnamurthy (OPD 5),
4 Dr. Arjun Shetty (OPD 6), 5 Dr. Kavitha Reddy (OPD 9), 6 Dr. Mohammed Irfan (OPD 10), 7 Dr. Prakash Naik (OPD 12),
8 Dr. Deepa Venkatesh (OPD 13), 9 Dr. Shweta Kulkarni (OPD 15), 10 Dr. Vikram Bhat (OPD 16).

Patients 11..40 have no login (reception can search and book for them). Generated MRNs for new patients start at
`BLR-001000` (sequence `patient_mrn_seq`, migration 0002).
