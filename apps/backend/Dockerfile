# Build context is the repository root. Targets: dev, api, worker.
FROM node:22-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json .npmrc ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/shared-utils/package.json packages/shared-utils/
COPY packages/validation/package.json packages/validation/
COPY packages/calc-engine/package.json packages/calc-engine/
COPY apps/backend/package.json apps/backend/
COPY apps/worker/package.json apps/worker/
COPY apps/frontend/package.json apps/frontend/
RUN npm ci

FROM deps AS dev
COPY . .
USER node

FROM deps AS build
COPY . .
RUN npm run build:packages \
  && npm run build -w @lumio/backend -w @lumio/worker \
  && npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/backend/dist ./apps/backend/dist
COPY --from=build /app/apps/backend/package.json ./apps/backend/
USER node

FROM runtime AS api
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/backend/dist/server.js"]

FROM runtime AS worker
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||4001)+'/healthz/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/worker/dist/main.js"]
