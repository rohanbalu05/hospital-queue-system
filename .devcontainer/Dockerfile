# Dev container image: Node 22 + psql client + pnpm. RUN steps execute as root at build time (no sudo needed).
FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@10.28.0
