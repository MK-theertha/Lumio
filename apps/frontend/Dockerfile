# Build context is the repository root. Targets: dev, prod.
FROM node:22-slim AS deps
WORKDIR /app
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
# Vite writes its bundled config and dependency cache next to the source.
RUN chown -R node:node /app
USER node

FROM deps AS build
COPY . .
RUN npm run build -w @lumio/frontend

FROM nginxinc/nginx-unprivileged:stable-alpine AS prod
COPY infrastructure/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY infrastructure/nginx/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/apps/frontend/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD ["wget", "-q", "--spider", "http://127.0.0.1:8080/nginx-health"]
