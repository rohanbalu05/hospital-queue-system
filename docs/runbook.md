# Runbook

Operational procedures for the local demo and the hosted reference. Commands assume the repository root.

## Start, stop, reset

| Task | Command |
| --- | --- |
| First-time setup (idempotent) | `./init.sh` |
| Run api, worker, web | `pnpm dev` (web http://localhost:5173, api http://localhost:3000) |
| Container demo stack | `docker compose up --build`; stop with `docker compose down` |
| Wipe demo data | `pnpm db:reset` then `pnpm db:seed`, or `docker compose down -v` |
| Apply new migrations | `pnpm db:migrate` |

## Health checks

- Postgres: `pg_isready -h localhost -p 5432`; in Compose, `docker compose ps` shows the health status.
- API: `curl -i http://localhost:3000/health` (endpoint provided by `apps/api`).
- Web proxy: `curl -i http://localhost:5173/api/health`.
- Worker: log lines show job polling; job age and retries should stay near zero when idle.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `init.sh` cannot start Postgres | No `service` and no Docker | Start Postgres 16 yourself on 5432 and re-run |
| `relation ... does not exist` | Migrations not applied | `pnpm db:migrate` |
| Migration checksum error | An applied file was edited | Restore the original file; add a new numbered migration instead |
| Login works but pages return 401 | Cookie not sent (wrong origin or `COOKIE_SECURE=true` over HTTP) | Use the web origin and `/api` proxy; set `COOKIE_SECURE=false` locally |
| Queue screen shows stale banner | SSE connection dropped | Client falls back to `GET /sessions/{id}/queue`; check api logs and proxy buffering (nginx must not buffer `/api/`) |
| Calls stuck in `called` state | Worker not running | Start the worker; the 2 minute call timeout is a worker job |
| Tests fail with connection errors | `hqms_test` missing | `./init.sh` creates both databases |
| `pnpm verify:fast` matches nothing | Base ref missing | `git fetch origin` or set `HQMS_BASE_REF` |

## Backup and restore

- Local: `pg_dump -h localhost -U postgres hqms > hqms.sql`; restore into an empty database with `psql ... < hqms.sql`.
- Hosted: rely on Cloud SQL backups and point-in-time recovery; after restoring, reconcile pending jobs and refresh
  client snapshots before staff resume calls. Recovery point and time are measured in the recovery drill, not assumed.

## Rollback

See `docs/construction/rollout-plan.md` section 5. Application rollbacks do not roll back the schema.

## Configuration

All settings are environment variables listed in `.env.example`. Never put secrets in the repository.
