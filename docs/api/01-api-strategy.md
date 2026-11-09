# 10. API Design Strategy

## 10.1 Contract first

Zod schemas in `packages/validation` are the single source. They validate requests on the server, power forms on the client, and generate the OpenAPI document.
The endpoint's contract is written and reviewed before its implementation. CI fails if the generated OpenAPI differs from the committed file, so contract changes are visible in review.
Swagger UI is available in development and staging; in production it is off by default.

## 10.2 Conventions

- Base path `/api/v1`. Plural kebab-case resources. Breaking changes go to `/api/v2`, with additive changes staying in place.
- **State transitions are explicit commands**, never a `PATCH status`, so each maps to one permission and one audit action:

```
POST   /api/v1/sales-invoices                     create draft
GET    /api/v1/sales-invoices?status=&from=&sort=-postingDate&limit=
PATCH  /api/v1/sales-invoices/:id                 draft only, needs If-Match
POST   /api/v1/sales-invoices/quote               server-side calculation, no write
POST   /api/v1/sales-invoices/:id/submit
POST   /api/v1/sales-invoices/:id/approve
POST   /api/v1/sales-invoices/:id/post            Idempotency-Key required
POST   /api/v1/sales-invoices/:id/credit-notes
```

## 10.3 Response format

```jsonc
// Success
{ "data": { "id": "…", "totals": { "grandTotal": "3847.20", "currency": "AED" } },
  "meta": { "correlationId": "…" } }

// List
{ "data": [ … ], "meta": { "page": { "limit": 50, "nextCursor": "…" }, "correlationId": "…" } }

// Error
{ "error": { "code": "INSUFFICIENT_STOCK", "message": "…",
             "details": [ { "path": "lines[0].netWeight", "issue": "…" } ],
             "correlationId": "…" } }
```

Decimals are **strings**, always. A weight always accompanies its unit; money always accompanies its currency. Error `code` values are a stable, documented enum.

## 10.4 Status codes

`200` read, `201` create, `202` async job accepted, `400` malformed, `401` unauthenticated, `403` forbidden, `404` missing **or outside tenant scope** (so existence is not disclosed),
`409` state or version conflict, `412` `If-Match` failed, `422` business rule, `429` rate limit, `5xx` server.

## 10.5 Queries

- Pagination: **cursor** for ledgers, movements and audit logs (stable under inserts, no deep skip); offset for short admin lists. `limit` capped at 200.
- Filtering and sorting: each endpoint declares an allowlist backed by an index. Unknown parameters return `400`, so unindexed queries cannot be requested.
- Search: prefix on indexed codes, MongoDB text search on names. Atlas Search can come later without API changes.

## 10.6 Headers and concurrency

| Header              | Use                                                                        |
| ------------------- | -------------------------------------------------------------------------- |
| `Idempotency-Key`   | Required for commands that move money or stock                             |
| `If-Match` / `ETag` | Optimistic concurrency on draft and master edits                           |
| `X-Correlation-Id`  | Accepted if valid, otherwise generated. Echoed, logged, propagated to jobs |
| `X-Branch-Id`       | Selects a working branch, validated against assignments                    |

## 10.7 Long-running work

Exports and scheduled reports return `202` with a job resource. On completion the user is notified and gets a permission-checked download. Inline responses are limited by row count.

## 10.8 Testing the contract

Supertest integration tests assert each response against the generated schema. Once real endpoints exist, Postman collections can be added as runnable contract checks in CI if you want them, but they aren't required by this design.
