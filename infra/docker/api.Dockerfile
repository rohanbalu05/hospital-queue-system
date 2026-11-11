# API image. Build context is the repo root.
# Assumption: apps/api defines `build` (bundles TS source incl. workspace packages, D-010) and `start`.
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
RUN corepack enable
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo ./
RUN mkdir -p /var/hqms/storage
EXPOSE 3000
CMD ["pnpm", "--filter", "@hqms/api", "start"]
