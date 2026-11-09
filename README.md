# Lumio

An enterprise ERP for traders, jewellers and bullion dealers, built on the MERN stack with TypeScript.

**Status: core ERP working in development; not production ready.**
See the [production readiness checklist](docs/production-readiness.md) for what is and is not done.

## Quick start

Requires Docker. To run the checks outside Docker you also need Node 22.

```bash
docker compose up --build
```

| Service        | Address                               |
| -------------- | ------------------------------------- |
| Web app        | http://localhost:5173                 |
| API            | http://localhost:4000                 |
| API docs       | http://localhost:4000/api/docs        |
| Email capture  | http://localhost:8025                 |
| Object storage | http://localhost:8333 (S3-compatible) |

The virus scanner is optional because its download is large: `docker compose --profile scan up`.

Create a demo company (development only, shown with a banner in the app):

```bash
docker compose --profile seed run --rm seed
```

Sign in as `admin@demo.lumio.local` with `demo-only-change-me`. Before transacting, set up purities, products, tax codes, tax rules.

If a port is already in use on your machine, override it when starting:
`MONGO_HOST_PORT`, `REDIS_CACHE_HOST_PORT`, `REDIS_QUEUE_HOST_PORT`, `API_HOST_PORT`, `FRONTEND_HOST_PORT`.

## Working on the code

```bash
npm install
npm run lint
npm run format:check
npm run typecheck
npm run boundaries         # enforces module boundaries
npm run openapi:check      # fails if the API contract is out of date
npm run test:unit
npm run test:integration   # starts a real MongoDB replica set and Redis using Docker
npm run build
E2E_BASE_URL=http://localhost:5173 npx playwright test   # needs the stack running and seeded
```

To run the API or worker outside Docker, copy `.env.example` to `.env` and export its values.
The application validates its configuration at startup and refuses to start if anything is missing.

## Layout

```
apps/frontend         React SPA
apps/backend          Express API and domain modules
apps/worker           Background jobs and the outbox relay
packages/calc-engine  tax and settlement arithmetic
packages/validation   Zod schemas: the API contract
packages/shared-types Shared TypeScript types
packages/shared-utils Shared helpers
infrastructure/       Nginx and deployment scripts
docs/                 Architecture, data model, business rules
```

Start with the [project guide](docs/PROJECT-GUIDE.md), the [file reference](docs/FILE-REFERENCE.md) and the [documentation index](docs/README.md). Unresolved business decisions are in
[risks and open questions](docs/business-rules/03-risks-and-open-questions.md).
