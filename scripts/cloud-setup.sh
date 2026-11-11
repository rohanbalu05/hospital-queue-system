#!/bin/bash
# Paste this into the claude.ai/code environment's "Setup script" box.
# Runs as root on Ubuntu 24.04 before each new session; the result is cached.
# Postgres 16, Docker, Node 22 and pnpm are already pre-installed on the VM.
pip install --break-system-packages --quiet semgrep || pip install --quiet semgrep || true
npm install -g --silent typescript typescript-language-server || true
npx -y playwright@latest install --with-deps chromium || true
exit 0
