#!/usr/bin/env bash
# Every Codespace start: make sure Postgres is running with the local dev password.
sudo service postgresql start >/dev/null 2>&1 || true
for _ in $(seq 1 20); do pg_isready -q -h localhost && break; sleep 1; done
sudo -u postgres psql -qc "ALTER USER postgres PASSWORD 'postgres'" >/dev/null 2>&1 || true
pg_isready -h localhost || echo "post-start: Postgres not ready"
