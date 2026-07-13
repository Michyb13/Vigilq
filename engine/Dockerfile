# Build context is the repo root (see docker-compose.yml), not engine/,
# because this image bundles the dashboard's static export too — the
# dashboard is served by the engine's own Fastify instance on the same
# port, not as a separate container.

# --- Stage 1: build the dashboard (static export) ---
FROM node:22-alpine AS dashboard-build
WORKDIR /app/dashboard
RUN corepack enable
COPY dashboard/package.json dashboard/pnpm-lock.yaml* dashboard/.npmrc ./
RUN pnpm install --frozen-lockfile
COPY dashboard/ ./
RUN pnpm build

# --- Stage 2: build the engine ---
FROM node:22-alpine AS engine-build
WORKDIR /app/engine
RUN corepack enable
COPY engine/package.json engine/pnpm-lock.yaml* engine/.npmrc ./
RUN pnpm install --frozen-lockfile
COPY engine/ ./
RUN pnpm build
# pnpm's prune wants an interactive confirmation before removing packages,
# which there's no TTY to answer inside a Docker build — CI=true is pnpm's
# own documented way to skip that prompt non-interactively.
RUN CI=true pnpm prune --prod

# --- Stage 3: production image ---
FROM node:22-alpine
WORKDIR /app
COPY --from=engine-build /app/engine/package.json ./
COPY --from=engine-build /app/engine/node_modules ./node_modules
COPY --from=engine-build /app/engine/dist ./dist
COPY --from=dashboard-build /app/dashboard/out ./dashboard/out

ENV DASHBOARD_DIST_PATH=/app/dashboard/out
ENV PORT=4000
EXPOSE 4000

CMD ["node", "dist/index.js"]
