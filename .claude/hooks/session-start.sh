#!/usr/bin/env bash
# Runs when a Claude Code session starts or resumes. Starts Postgres in cloud
# sessions, installs deps if missing, and prints where the run left off.
# Never fails the session.
set +e

if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  if ! pg_isready -q 2>/dev/null; then
    service postgresql start >/dev/null 2>&1
    sleep 2
  fi
  su postgres -c "psql -tAc \"ALTER USER postgres PASSWORD 'postgres'\"" >/dev/null 2>&1
  for db in hqms hqms_test; do
    if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$db'\"" 2>/dev/null | grep -q 1; then
      su postgres -c "createdb $db" >/dev/null 2>&1
    fi
  done
fi

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
if [ -f package.json ] && [ ! -d node_modules ]; then
  pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null 2>&1
fi

echo "== HQMS session start =="
if pg_isready -q 2>/dev/null; then echo "Postgres: running"; else echo "Postgres: NOT running (run: service postgresql start)"; fi
if [ -f PROGRESS.md ]; then
  echo "== PROGRESS.md (last 30 lines) =="
  tail -n 30 PROGRESS.md
else
  echo "No PROGRESS.md yet: fresh start. The kickoff prompt is in KICKOFF.md."
fi
exit 0
