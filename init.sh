#!/usr/bin/env bash
# Idempotent local setup: Postgres up, databases created, deps installed, schema migrated, demo data seeded.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"

[ -f .env ] || { cp .env.example .env && echo "init: created .env from .env.example"; }

pg_up() { pg_isready -q -h "$PGHOST" -p "$PGPORT" 2>/dev/null; }

if pg_up; then
  echo "init: Postgres already running on $PGHOST:$PGPORT"
else
  echo "init: starting Postgres"
  if command -v service >/dev/null 2>&1 && service postgresql start >/dev/null 2>&1; then
    :
  elif command -v docker >/dev/null 2>&1; then
    docker compose up -d postgres
  else
    echo "init: cannot start Postgres (no 'service' or docker). Start it and re-run." >&2
    exit 1
  fi
  for _ in $(seq 1 30); do pg_up && break; sleep 1; done
  pg_up || { echo "init: Postgres did not become ready" >&2; exit 1; }
fi

run_psql() { psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 -tAc "$1"; }

for db in hqms hqms_test; do
  if [ "$(run_psql "SELECT 1 FROM pg_database WHERE datname='${db}'")" = "1" ]; then
    echo "init: database ${db} exists"
  else
    run_psql "CREATE DATABASE ${db}" >/dev/null
    echo "init: created database ${db}"
  fi
done

echo "init: installing dependencies"
pnpm install

if [ -d packages/db ]; then
  echo "init: migrating and seeding"
  pnpm db:migrate
  pnpm db:seed
else
  echo "init: NOTICE packages/db not present yet, skipping migrate and seed"
fi

cat <<'EOF'

init: done.
  pnpm dev      start api :3000, worker, web :5173
  pnpm verify   typecheck, lint, dependency rules, tests, Semgrep
  Demo accounts use password demo1234 (see db/seed).
EOF
