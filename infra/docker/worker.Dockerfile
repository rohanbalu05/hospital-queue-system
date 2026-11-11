# Worker image. Build context is the repo root.
# Assumption: apps/worker defines `build` and `start`.
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
RUN corepack enable
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo ./
RUN mkdir -p /var/hqms/storage
CMD ["pnpm", "--filter", "@hqms/worker", "start"]
