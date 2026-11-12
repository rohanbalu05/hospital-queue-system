# Web image: Vite build served by nginx, which proxies /api/* to the api service (D-013).
# Assumption: apps/web defines `build` and emits apps/web/dist.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY tests/package.json ./tests/package.json
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @hqms/web build

FROM nginx:1.27-alpine
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
