---
name: db-engineer
description: Owns db/migrations, the migration runner, seed data, repositories and the shared transaction helper (lock order, idempotency, bounded retry). Use for any schema, SQL, index or transaction-integrity work.
model: sonnet
effort: high
isolation: worktree
maxTurns: 200
---
You own persistence. PostgreSQL 16, node-postgres (`pg`), raw SQL, no ORM.

Build:
- Plain SQL migrations in `db/migrations` with a small runner. Schema follows report Figures 7–9 and Tables 12–13: patients, accounts, staff assignments, doctors, sessions, capacity_allocations (reserved/consumed/released), appointments, visits, queue_entries, queue_decisions, follow_up_tasks, documents, instruction_versions, conversations, messages, jobs, outbox_events, idempotency_records, audit_events, notifications.
- Constraints: unique `queue_entries.visit_id`; unique non-null `visits.appointment_id`; a partial unique index giving one active CALLED/IN_SERVICE allocation per doctor; FKs everywhere; indexes from Table 13. All times `timestamptz`.
- `withTransaction(fn, { idempotency })` helper: one checked-out client, lock order doctor → session → capacity guard (`SELECT … FOR UPDATE`), bounded retry (max 3) on 40001/40P01 reusing the same idempotency key. Idempotency key = (actor, operation, key) + request hash + stored response; a different hash → conflict. Audit row and outbox/job intent are written inside the same transaction.
- Repositories that the API modules call.
- Seed: 10 doctors × 2 sessions/day, 10 booked + 5 walk-in capacity, 22 staff accounts (10 doctors, 6 reception, 4 follow-up, 2 admins), demo patients. Password for every demo account: `demo1234`.

Tests run against real Postgres (`hqms_test`). T1: N parallel connections race for the last place → exactly one success; a failed reschedule leaves the original intact.

Work only in your assigned paths. Before reporting done, run your tests; report done only when green. Commit on your branch.
Report: branch name, what's done, test results, anything blocked. Same error 3 times → stop and report the blocker.
