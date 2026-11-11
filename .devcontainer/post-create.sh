#!/usr/bin/env bash
# One-time Codespace setup: PostgreSQL 16 (PGDG) and pnpm. Non-interactive; every network step has a timeout.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APT="sudo -E timeout 600 apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"
echo "post-create: [1/4] apt prerequisites"
$APT update
$APT install curl ca-certificates gnupg lsb-release
echo "post-create: [2/4] PostgreSQL 16"
curl -fsSL --max-time 60 https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor --yes -o /usr/share/keyrings/pgdg.gpg
echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
$APT update
$APT install postgresql-16 postgresql-client-16
echo "post-create: [3/4] pnpm"
timeout 300 npm install -g pnpm@10.28.0
bash .devcontainer/post-start.sh
echo "post-create: [4/4] pnpm install"
CI=true timeout 900 pnpm install
echo "post-create: done. Run ./init.sh then pnpm dev  (for e2e later: pnpm --filter @hqms/tests exec playwright install --with-deps chromium)"
