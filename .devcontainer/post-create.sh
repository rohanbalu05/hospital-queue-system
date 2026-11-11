#!/usr/bin/env bash
# One-time Codespace setup: PostgreSQL 16 (PGDG), pnpm, Playwright Chromium.
set -euo pipefail
sudo apt-get update -y
sudo apt-get install -y curl ca-certificates gnupg lsb-release
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor --yes -o /usr/share/keyrings/pgdg.gpg
echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
sudo apt-get update -y
sudo apt-get install -y postgresql-16 postgresql-client-16
npm install -g pnpm@10.28.0
bash .devcontainer/post-start.sh
pnpm install
pnpm --filter @hqms/tests exec playwright install --with-deps chromium || echo "post-create: Playwright browser install skipped"
echo "post-create: done. Run ./init.sh then pnpm dev"
