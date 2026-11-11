# Worker image (also used for the document worker; the role is chosen by WORKER_JOB_TYPES). Build context is the repo root.
# `build` bundles the worker and workspace packages into apps/worker/dist/main.js; pg and argon2 stay external.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY tests/package.json ./tests/package.json
COPY db ./db
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @hqms/worker build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /repo/apps/worker
COPY --from=build /repo /repo
RUN mkdir -p /var/hqms/storage && chown -R node:node /var/hqms
USER node
# The worker has no HTTP port. Healthy = database reachable and no job lease has been expired for more than 2 minutes
# (a stuck or crashed runner). Job age and retries are monitored separately (docs/runbook.md).
HEALTHCHECK --interval=15s --timeout=8s --start-period=30s --retries=4 \
  CMD ["node", "-e", "const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,max:1});p.query(\"SELECT count(*)::int AS n FROM jobs WHERE state='running' AND lease_expires_at < now() - interval '2 minutes'\").then(r=>{p.end();process.exit(r.rows[0].n===0?0:1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
