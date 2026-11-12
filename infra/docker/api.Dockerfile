# API image. Build context is the repo root.
# `pnpm --filter @hqms/api build` bundles the API and the workspace TypeScript packages (D-010) into
# apps/api/dist/main.js; third-party packages stay in node_modules. The bundle resolves db/migrations
# relative to itself (/repo/db/migrations), so the repo layout is kept in the runtime image.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY tests/package.json ./tests/package.json
COPY db ./db
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @hqms/api build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /repo/apps/api
COPY --from=build /repo /repo
# Private document storage (OBJECT_STORAGE=local-disk). Mount the shared named volume here.
RUN mkdir -p /var/hqms/storage && chown -R node:node /var/hqms
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
