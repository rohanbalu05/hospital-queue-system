#!/usr/bin/env bash
# ==========================================================================
#  HQMS one-command local demo (macOS with Homebrew; also works on Linux)
#  Needs: Node.js 22+, pnpm 10, PostgreSQL 16 (Homebrew: brew install node@22 postgresql@16).
#  Every launch RESETS the demo data so "today" is always the current date.
#
#  Optional env overrides: HQMS_API_PORT (default 3000), HQMS_PG_PORT (default 5432), HQMS_DB_NAME (default hqms),
#  SKIP_BREW=1 (do not touch Homebrew services; use whatever Postgres is already listening).
# ==========================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"

API_PORT="${HQMS_API_PORT:-3000}"
PG_PORT="${HQMS_PG_PORT:-5432}"
DB_NAME="${HQMS_DB_NAME:-hqms}"
DB_PASSWORD="${DB_PASSWORD:-postgres}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n[x] %s\n' "$*" >&2; exit 1; }

# ---- Tooling ----
command -v node >/dev/null 2>&1 || die "Node.js not found. Install it: brew install node@22 (then: brew link --overwrite node@22)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js 22 or newer is required (found $(node -v)). Install: brew install node@22 && brew link --overwrite node@22"
if ! command -v pnpm >/dev/null 2>&1; then
  die "pnpm not found. Run: corepack enable   (or: npm install -g pnpm@10.28.0)"
fi

# ---- PostgreSQL ----
if [ "${SKIP_BREW:-0}" != "1" ] && command -v brew >/dev/null 2>&1 && brew list --versions postgresql@16 >/dev/null 2>&1; then
  say "Starting PostgreSQL 16 (Homebrew service)"
  brew services start postgresql@16 >/dev/null 2>&1 || true
  PATH="$(brew --prefix postgresql@16)/bin:$PATH"
  export PATH
fi
command -v psql >/dev/null 2>&1 || die "psql not found. Install PostgreSQL 16: brew install postgresql@16 (Linux: apt install postgresql-16)"
command -v pg_isready >/dev/null 2>&1 || die "pg_isready not found (it ships with PostgreSQL 16)."

say "Waiting for PostgreSQL on localhost:$PG_PORT"
READY=0
for _ in $(seq 1 60); do
  if pg_isready -h localhost -p "$PG_PORT" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
[ "$READY" = 1 ] || die "PostgreSQL is not answering on localhost:$PG_PORT. Check: brew services list  (is another Postgres using the port? see README troubleshooting)"

export PGPASSWORD="$DB_PASSWORD"
if ! psql -h localhost -p "$PG_PORT" -U postgres -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
  # Homebrew creates a superuser named after the macOS user and no `postgres` role: use that to create it.
  say "Creating the 'postgres' database role (password: $DB_PASSWORD)"
  EXISTS="$(PGPASSWORD='' psql -h localhost -p "$PG_PORT" -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='postgres'" 2>/dev/null || true)"
  if [ "$EXISTS" = "1" ]; then
    PGPASSWORD='' psql -h localhost -p "$PG_PORT" -d postgres -v ON_ERROR_STOP=1 -c "ALTER ROLE postgres WITH LOGIN SUPERUSER PASSWORD '$DB_PASSWORD'" >/dev/null \
      || die "Could not set the postgres role password. See README troubleshooting."
  else
    PGPASSWORD='' psql -h localhost -p "$PG_PORT" -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE postgres WITH LOGIN SUPERUSER PASSWORD '$DB_PASSWORD'" >/dev/null \
      || die "Could not create the postgres role. Connect as your own user (psql -d postgres) and run: CREATE ROLE postgres WITH LOGIN SUPERUSER PASSWORD 'postgres';"
  fi
  psql -h localhost -p "$PG_PORT" -U postgres -d postgres -tAc 'SELECT 1' >/dev/null 2>&1 \
    || die "Still cannot log in as postgres/$DB_PASSWORD on localhost:$PG_PORT. See README troubleshooting (role exists with another password, or another Postgres owns the port)."
fi
for DB in "$DB_NAME" hqms_test; do
  if [ "$(psql -h localhost -p "$PG_PORT" -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB'")" != "1" ]; then
    psql -h localhost -p "$PG_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB OWNER postgres" >/dev/null
    echo "created database $DB"
  fi
done

# ---- Environment (same as start-demo.bat) ----
export DATABASE_URL="postgres://postgres:${DB_PASSWORD}@localhost:${PG_PORT}/${DB_NAME}"
export TEST_DATABASE_URL="postgres://postgres:${DB_PASSWORD}@localhost:${PG_PORT}/hqms_test"
export NODE_ENV=development
export PORT="$API_PORT"
export API_PROXY_TARGET="http://localhost:${API_PORT}"
# API and worker must share ONE upload folder (each package runs from its own directory).
export STORAGE_DIR="$ROOT/var/storage"
mkdir -p "$STORAGE_DIR"
LOG="$ROOT/var/demo.log"
: >"$LOG"

say "[1/4] Installing packages (first run takes a few minutes)"
pnpm install

say "[2/4] Resetting demo data for today"
pnpm db:reset

say "[3/4] Starting API :$API_PORT, worker and web :5173 (logs: var/demo.log)"
set -m # job control: the dev stack gets its own process group so Ctrl+C can stop all of it
pnpm dev >>"$LOG" 2>&1 &
DEV_PID=$!
cleanup() {
  trap - INT TERM EXIT
  echo
  echo "Stopping the demo..."
  kill -TERM -- "-$DEV_PID" 2>/dev/null || kill -TERM "$DEV_PID" 2>/dev/null || true
  wait "$DEV_PID" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM EXIT

READY=0
for _ in $(seq 1 120); do
  if curl -fsS "http://localhost:${API_PORT}/health" >/dev/null 2>&1; then READY=1; break; fi
  kill -0 "$DEV_PID" 2>/dev/null || break
  sleep 1
done
if [ "$READY" != 1 ]; then
  tail -n 30 "$LOG" || true
  die "The API did not come up. See var/demo.log"
fi

API_URL="http://localhost:${API_PORT}" node scripts/demo-session-now.mjs || echo "[demo-session] skipped (see message above)"

say "[4/4] Ready: http://localhost:5173"
cat <<'EOF'
Demo logins (password demo1234):
  reception@hqms.test  doctor@hqms.test  patient@hqms.test  followup@hqms.test  admin@hqms.test
Waiting-room display: http://localhost:5173/display
Notifications are FAKE: no SMS or email is really sent. See Admin > Notifications sent.
Press Ctrl+C to stop. Logs: var/demo.log
EOF
if command -v open >/dev/null 2>&1; then
  open http://localhost:5173 || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open http://localhost:5173 >/dev/null 2>&1 || true
fi
wait "$DEV_PID" || true
