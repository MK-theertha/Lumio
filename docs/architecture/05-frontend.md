# 11. Frontend Architecture

## 11.1 Structure

```
apps/frontend/src/
  app/         router, providers, error boundaries
  layouts/     AppShell + Dashboard, Sales, Purchases, Inventory, Customers, Suppliers,
               Accounting, Payments, Reports, Compliance, Settings
  features/<feature>/
               api/  (queries, mutations, keys)   components/   pages/   hooks/   index.ts
  components/  ui/ (shadcn)   data-table/   forms/   feedback/   money/
  contexts/    auth, active-company-and-branch, theme
  hooks/  lib/ (api client, query client)  services/  types/  utils/
```

`features/` depend on `components/` and `lib/`, never on each other's internals. This mirrors backend module boundaries. Files are kept small, and a component over about 250 lines is split.

## 11.2 State

| State                        | Tool                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Server data                  | TanStack Query, with keys always including company and branch so a switch can never show stale tenant data |
| Session, theme, active scope | React Context, split by change frequency to avoid re-render storms                                         |
| Filters, sort, page          | URL search params: shareable and back-button safe                                                          |
| Forms                        | React Hook Form with Zod resolvers from `packages/validation`                                              |

Mutations invalidate exact keys. No optimistic updates on financial or stock commands: the UI shows the server's result, never a prediction.
Rendering rule: **no client-side arithmetic on money or weight** outside `calc-engine`.

## 11.3 API client

An Axios instance with interceptors: attach access token; on `401`, single-flight refresh, then retry; generate one `Idempotency-Key` per user **intent**, reused on retry, so a double click or a retry after a timeout is safe; attach correlation ID; normalise errors.

## 11.4 Reusable building blocks

- **`DataTable`**: headless TanStack Table on shadcn primitives. Server-side sort, filter, pagination; skeleton, empty and error states built in; column visibility; export hook. Numeric columns right-aligned with tabular figures.
- **`MoneyCell`, `WeightCell`, `PurityBadge`**: uniform formatting of decimal strings with currency and unit.
- **`StatusBadge`**: one mapping per document lifecycle.
- **`Can` and `usePermission`**: permission-aware rendering. Nav and route guards use the same keys as the API.
- **`InvoiceLineEditor`**: shared by sales and purchasing. Instant preview from `calc-engine`, confirmed by `/quote` before posting. Any difference between preview and server is treated as a defect and logged.
- **`ConfirmDialog`** for posting and reversing: states the consequences. Posting is presented as irreversible.

## 11.5 UX direction

Clean, dense, finance-grade layout: neutral surfaces, one restrained accent, tabular numerals, keyboard-first entry on invoice lines and barcode scanners. Light and dark themes via CSS variables.
Responsive sidebar becoming a drawer on small screens. Wide financial tables keep key columns pinned and scroll horizontally.

Arabic and RTL support is a structural decision; it's cheap now and costly later. Using logical CSS properties from the outset keeps it open ([Q18](../business-rules/03-risks-and-open-questions.md)).

## 11.6 Demo data

Seeds run only outside production, are refused at startup if `NODE_ENV=production`, set an `isDemo` flag on the company, and the UI shows a persistent banner for that company.

## 11.7 Charts

Recharts, fed only from backend aggregates. Empty data gives an empty state, never placeholder series.
