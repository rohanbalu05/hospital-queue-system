# Rollout plan

Syllabus Module 5: rolling out an enterprise application. This is a plan, not a record of a deployment. No rollout
timing or recovery figure here is a measured result; the recovery exercise (see `docs/evidence/`) produces those.

## 1. Stages

| Stage | Environment | Purpose | Exit criterion |
| --- | --- | --- | --- |
| 1 Local demo | Docker Compose on a laptop | Demonstrate end-to-end flows with fake adapters | `docker compose up --build` serves the app; seeded accounts can log in |
| 2 Hosted reference | Google Cloud reference deployment (report Figure 10) | Show the design runs on managed services | Smoke checks in section 3 pass |
| 3 Pilot (out of scope for the course) | Hospital validation | Validate with real staff | Requires separate approval; not part of Phase 2 |

## 2. Local demo

```bash
./init.sh                 # Postgres, databases, install, migrate, seed
pnpm dev                  # api :3000, worker, web :5173
# or the container stack
docker compose up --build # postgres, api, worker, web (nginx) on :5173
```

All providers are fake or local (`.env.example`), so no keys are needed. The nginx container serves the Vite build and
proxies `/api/*` to `api:3000` (D-013). The Dockerfiles assume each app provides `build` and `start` scripts.

## 3. Hosted Google Cloud reference

Components (report section 6.13, Figure 10): Compute Engine host running api, worker and reverse-proxy containers;
Cloud SQL for PostgreSQL 16; private Cloud Storage bucket for documents (`OBJECT_STORAGE=gcs`); Identity Platform
(`IDENTITY_PROVIDER=identity-platform`); Vision and Gemini adapters for the follow-up add-on. Preferred region is
Mumbai, subject to service availability. Provider processing locations must be verified separately. Sizing in the
report is a starting point for measurement, not verified capacity, and a single application host is a failure point.

Release steps:

1. CI green on the release commit (`pnpm verify`, `pnpm test:concurrency`).
2. Build and tag images (version plus git SHA); record the migration version the release expects.
3. Take a Cloud SQL backup or confirm point-in-time recovery is enabled before touching the schema.
4. Apply migrations with the runner (`pnpm db:migrate`) against Cloud SQL, from the release image or a bastion.
5. Deploy worker, then api, then web. Secrets come from protected runtime configuration, never from the image.
6. Smoke checks: `GET /health` on the api, login with a non-patient account, open a session queue, receive an SSE
   event, worker job age near zero.
7. Record the release (version, SHA, migration version, time) in the change log.

## 4. Data migrations

- Schema and data changes are forward-only numbered SQL (`db/migrations`); see `config-management.md`.
- Use expand then contract: add nullable columns or new tables first, deploy code that writes both, backfill, switch
  reads, and drop old structures in a later release.
- Migrations run in one transaction per file with checksums recorded; long backfills run as batched worker jobs rather
  than inside a migration.
- Seed data is demo-only and is never run against a hosted environment that holds real data.

## 5. Rollback

Rolling back application code does not roll back the database (report section 6.13).

| Situation | Action |
| --- | --- |
| Bad application release, schema compatible | Redeploy the previous image tag; no database action |
| Bad application release, new schema is additive | Redeploy previous image; leave additive schema in place |
| Migration failed | The file ran in one transaction, so nothing partial applied; fix forward with a new numbered file |
| Data damaged | Point-in-time recovery to a restored instance, then reconcile pending jobs and refresh client snapshots before staff resume calls (report section 6.14) |
| Local demo | `pnpm db:reset` or `docker compose down -v` |

After any rollback, the worker reconciles pending jobs and clients reload their queue snapshots before doctors resume
calling patients. Recovery point and time objectives are measured in the recovery drill, not assumed.

## 6. Communication and fallback

During a hosted release window staff keep a manual paper fallback for the queue. A release does not happen while a
clinic session is live.
