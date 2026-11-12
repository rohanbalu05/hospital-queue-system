#!/usr/bin/env bash
# NFR-05 restore drill, following docs/runbook.md section 7 (source run, local procedure).
#
#   bash tests/failure/restore-drill.sh            (or: pnpm --filter @hqms/tests restore-drill)
#
# Loads a database (hqms_restore_src) and a storage directory with real files, takes a custom-format pg_dump and a tar of
# the storage directory, makes more writes AFTER the backup, then simulates the loss (kill -9 api and worker, DROP DATABASE,
# delete the storage directory), restores into a NEW database (hqms_restore_new), runs the post-restore reconciliation
# (migration level, capacity invariant, single-allocation check, reconcile_uploads job, documents vs objects), starts the API on the
# restored database and runs `pnpm smoke`. Every duration is measured with `date` on this machine; the numbers are written
# to docs/evidence/T5-restore-drill.raw.json. Only the databases hqms_restore_src and hqms_restore_new are touched.
#
# What this is NOT: the hosted PITR procedure (RPO <= 15 min, RTO <= 60 min targets) is not exercised here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
WORK="${DRILL_WORK:-$(mktemp -d -t hqms-restore-XXXXXX)}"
OUT="${DRILL_OUT:-$ROOT/docs/evidence/T5-restore-drill.raw.json}"
LISTING="${DRILL_LISTING:-$ROOT/docs/evidence/T5-restore-drill.archive-listing.txt}"
SRC=hqms_restore_src
NEW=hqms_restore_new
PORT_SRC="${DRILL_PORT_SRC:-3411}"
PORT_NEW="${DRILL_PORT_NEW:-3412}"
export PGPASSWORD="${PGPASSWORD:-postgres}" PGHOST="${PGHOST:-localhost}" PGUSER="${PGUSER:-postgres}"
PSQL=(psql -qtAX -v ON_ERROR_STOP=1)
TOOL=(pnpm --silent --filter @hqms/tests exec tsx failure/restore-tool.ts)
now_ms() { date +%s%3N; }
iso() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
declare -A T
mark() { T["$1"]="$(now_ms)"; }
log() { echo "[restore-drill $(date -u +%H:%M:%S)] $*"; }
APIPID=""; WORKERPID=""
stop_procs() { for p in $APIPID $WORKERPID; do kill -9 "$p" 2>/dev/null || true; done; APIPID=""; WORKERPID=""; }
trap 'stop_procs' EXIT

mkdir -p "$WORK/backup" "$WORK/storage"
log "work dir $WORK"
[ -f apps/api/dist/main.js ] && [ -f apps/worker/dist/main.js ] || { pnpm --filter @hqms/api build >/dev/null; pnpm --filter @hqms/worker build >/dev/null; }

start_api() { # <db> <port> <storage>
  DATABASE_URL="postgres://$PGUSER:$PGPASSWORD@$PGHOST:5432/$1" PORT="$2" NODE_ENV=production DB_POOL_MAX=10 LOGIN_RATE_LIMIT_MAX=100000 STORAGE_DIR="$3" \
    node apps/api/dist/main.js >"$WORK/api-$1.log" 2>&1 &
  APIPID=$!
  for _ in $(seq 1 200); do curl -fsS "http://127.0.0.1:$2/health" >/dev/null 2>&1 && return 0; sleep 0.1; done
  echo "API did not become healthy"; tail -20 "$WORK/api-$1.log"; exit 1
}
start_worker() { # <db> <storage> [job types]
  DATABASE_URL="postgres://$PGUSER:$PGPASSWORD@$PGHOST:5432/$1" NODE_ENV=production STORAGE_DIR="$2" WORKER_JOB_TYPES="${3:-}" \
    node apps/worker/dist/main.js >"$WORK/worker-$1.log" 2>&1 &
  WORKERPID=$!
}

# ---------------------------------------------------------------- 1. a loaded system -------------------------------------------------
log "1. loading $SRC (seed + synthetic patients, bookings, queue activity, 8 real files in $WORK/storage)"
"${TOOL[@]}" init "$SRC" >/dev/null
start_api "$SRC" "$PORT_SRC" "$WORK/storage"
start_worker "$SRC" "$WORK/storage"
mark load0
LOAD_JSON="$("${TOOL[@]}" load "http://127.0.0.1:$PORT_SRC" "$SRC")"
mark load1
log "   loaded: $LOAD_JSON"
LAST_BEFORE_BACKUP="$("${PSQL[@]}" -d "$SRC" -c "SELECT to_char(max(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') FROM audit_events")"
OPEN_JOBS_AT_BACKUP="$("${PSQL[@]}" -d "$SRC" -c "SELECT count(*) FROM jobs WHERE state IN ('pending','running','failed')")"

# ---------------------------------------------------------------- 2. backup (runbook 7.1) -------------------------------------------
log "2. backup: pg_dump -Fc, then tar of the storage directory (database first, storage second)"
mark b0
pg_dump -h "$PGHOST" -U "$PGUSER" -Fc "$SRC" > "$WORK/backup/hqms.dump"
mark b1
tar czf "$WORK/backup/storage.tgz" -C "$WORK/storage" .
mark b2
BACKUP_AT="$(iso)"
{
  echo "# tar tzvf backup/storage.tgz  (listing taken $BACKUP_AT)"
  tar tzvf "$WORK/backup/storage.tgz"
} > "$LISTING"
ARCHIVE_FILES="$(tar tzf "$WORK/backup/storage.tgz" | grep -vc '/$' || true)"
DUMP_BYTES="$(stat -c %s "$WORK/backup/hqms.dump")"
TGZ_BYTES="$(stat -c %s "$WORK/backup/storage.tgz")"
log "   dump $DUMP_BYTES bytes in $((T[b1]-T[b0])) ms; storage archive $TGZ_BYTES bytes, $ARCHIVE_FILES files, in $((T[b2]-T[b1])) ms"

# ---------------------------------------------------------------- 3. writes after the backup, then the loss -------------------------
log "3. 10 more bookings AFTER the backup (these are expected to be lost), then 15 s of quiet, then the failure"
WRITES_JSON="$("${TOOL[@]}" writes "http://127.0.0.1:$PORT_SRC" "$SRC" 10)"
LAST_BEFORE_FAILURE="$(echo "$WRITES_JSON" | jq -r .lastAuditAt)"
COUNTS_BEFORE_FAILURE="$("${PSQL[@]}" -d "$SRC" -c "SELECT (SELECT count(*) FROM appointments) || ' ' || (SELECT count(*) FROM audit_events) || ' ' || (SELECT count(*) FROM documents)")"
sleep 15
FAIL_AT="$(iso)"
mark fail
stop_procs                                  # kill -9 api and worker
"${PSQL[@]}" -d postgres -c "DROP DATABASE \"$SRC\" WITH (FORCE)"
rm -rf "$WORK/storage"
log "   failure simulated at $FAIL_AT: processes killed, database $SRC dropped, storage directory deleted"

# ---------------------------------------------------------------- 4. restore (runbook 7.3) ------------------------------------------
log "4. restore into a NEW database $NEW and a new storage directory"
mark r0
"${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS \"$NEW\" WITH (FORCE)" -c "CREATE DATABASE \"$NEW\""
pg_restore -h "$PGHOST" -U "$PGUSER" -d "$NEW" --no-owner "$WORK/backup/hqms.dump"
mark r1
mkdir -p "$WORK/storage"
tar xzf "$WORK/backup/storage.tgz" -C "$WORK/storage"
mark r2
log "   pg_restore $((T[r1]-T[r0])) ms; storage restore $((T[r2]-T[r1])) ms"

start_api "$NEW" "$PORT_NEW" "$WORK/storage"
mark apiup
start_worker "$NEW" "$WORK/storage" "reconcile_uploads,ocr_document"
log "   api healthy on the restored database after $((T[apiup]-T[r2])) ms (api start)"

# ---------------------------------------------------------------- 5. reconciliation (runbook 7.3 step 5) ---------------------------
log "5. post-restore reconciliation"
mark rec0
"${PSQL[@]}" -d "$NEW" -c "INSERT INTO jobs (job_type, payload, dedupe_key) VALUES ('reconcile_uploads', '{}'::jsonb, 'reconcile_uploads:manual-' || to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS'))"
RECONCILE_STATE="timeout"
for _ in $(seq 1 120); do
  S="$("${PSQL[@]}" -d "$NEW" -c "SELECT state FROM jobs WHERE job_type = 'reconcile_uploads' AND dedupe_key LIKE 'reconcile_uploads:manual-%' ORDER BY created_at DESC LIMIT 1")"
  if [ "$S" = "succeeded" ] || [ "$S" = "dead" ] || [ "$S" = "cancelled" ]; then RECONCILE_STATE="$S"; break; fi
  sleep 0.25
done
mark rec1
CHECK_JSON="$("${TOOL[@]}" check "$NEW" "$WORK/storage")"
MIGRATION_FILES="$(ls db/migrations/*.sql | wc -l)"
mark rec2
log "   reconcile_uploads job: $RECONCILE_STATE ($((T[rec1]-T[rec0])) ms); checks: $CHECK_JSON"

# ---------------------------------------------------------------- 6. smoke ------------------------------------------------------------
log "6. pnpm smoke against the restored database"
set +e
SMOKE_OUT="$(API_URL="http://127.0.0.1:$PORT_NEW" node scripts/smoke.mjs 2>&1)"; SMOKE_RC=$?
set -e
mark smoke
echo "$SMOKE_OUT" | tail -12
RESTORED_LAST="$("${PSQL[@]}" -d "$NEW" -c "SELECT to_char(max(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') FROM audit_events")"
COUNTS_RESTORED="$("${PSQL[@]}" -d "$NEW" -c "SELECT (SELECT count(*) FROM appointments) || ' ' || (SELECT count(*) FROM audit_events) || ' ' || (SELECT count(*) FROM documents)")"

stop_procs
"${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS \"$NEW\" WITH (FORCE)" >/dev/null

# ---------------------------------------------------------------- result -------------------------------------------------------------
jq -n \
  --arg generatedAt "$(iso)" --arg lastBeforeBackup "$LAST_BEFORE_BACKUP" --arg backupAt "$BACKUP_AT" --arg lastBeforeFailure "$LAST_BEFORE_FAILURE" \
  --arg failAt "$FAIL_AT" --arg restoredLast "$RESTORED_LAST" --arg countsBeforeFailure "$COUNTS_BEFORE_FAILURE" --arg countsRestored "$COUNTS_RESTORED" \
  --argjson load "$LOAD_JSON" --argjson writes "$WRITES_JSON" --argjson check "$CHECK_JSON" \
  --argjson loadMs "$((T[load1]-T[load0]))" --argjson dumpMs "$((T[b1]-T[b0]))" --argjson tarMs "$((T[b2]-T[b1]))" \
  --argjson dumpBytes "$DUMP_BYTES" --argjson tgzBytes "$TGZ_BYTES" --argjson archiveFiles "$ARCHIVE_FILES" --argjson openJobsAtBackup "$OPEN_JOBS_AT_BACKUP" \
  --argjson pgRestoreMs "$((T[r1]-T[r0]))" --argjson storageRestoreMs "$((T[r2]-T[r1]))" --argjson apiStartMs "$((T[apiup]-T[r2]))" \
  --arg reconcileState "$RECONCILE_STATE" --argjson reconcileMs "$((T[rec1]-T[rec0]))" --argjson checksMs "$((T[rec2]-T[rec1]))" \
  --argjson smokeRc "$SMOKE_RC" --argjson smokeMs "$((T[smoke]-T[rec2]))" \
  --argjson rtoMs "$((T[smoke]-T[fail]))" --argjson restoreToHealthyApiMs "$((T[apiup]-T[r0]))" --argjson migrationFiles "$MIGRATION_FILES" \
  '{
    generatedAt: $generatedAt,
    procedure: "docs/runbook.md section 7.1 (backup) and 7.3 (restore), source run, local PostgreSQL 16 and local-disk storage on one machine",
    dataset: { loaded: $load, loadMs: $loadMs, openJobsAtBackup: $openJobsAtBackup },
    backup: { dumpMs: $dumpMs, dumpBytes: $dumpBytes, storageArchiveMs: $tarMs, storageArchiveBytes: $tgzBytes, filesInArchive: $archiveFiles, archiveListing: "docs/evidence/T5-restore-drill.archive-listing.txt" },
    timestamps: { lastCommittedWriteBeforeBackup: $lastBeforeBackup, backupCompletedAt: $backupAt, writesAfterBackup: $writes, lastCommittedWriteBeforeFailure: $lastBeforeFailure, failureAt: $failAt, latestWriteInRestoredDatabase: $restoredLast },
    counts: { "appointments_auditEvents_documents_beforeFailure": $countsBeforeFailure, "appointments_auditEvents_documents_afterRestore": $countsRestored },
    restore: { pgRestoreMs: $pgRestoreMs, storageRestoreMs: $storageRestoreMs, apiStartMs: $apiStartMs, restoreStartToHealthyApiMs: $restoreToHealthyApiMs },
    reconciliation: { reconcileUploadsJob: $reconcileState, reconcileMs: $reconcileMs, checksMs: $checksMs, migrationFilesInRepo: $migrationFiles, checks: $check },
    smoke: { exitCode: $smokeRc, ms: $smokeMs },
    localRtoMs: { definition: "from the moment the failure was simulated (processes killed) until pnpm smoke passed; excludes detection and decision time and any human steps", value: $rtoMs },
    notMeasured: "Hosted PITR (RPO <= 15 min) and the hosted RTO <= 60 min are not exercised by this local procedure."
  }' > "$OUT"
log "result written to $OUT"
log "local RTO (failure -> smoke passed): $((T[smoke]-T[fail])) ms; smoke exit code $SMOKE_RC"
[ "$SMOKE_RC" -eq 0 ]
