# 14. Implementation Roadmap

## 14.1 Why the phase order changes

The brief's order has a dependency problem. Purchase and Sales (Phase 6) must "update accounting", and the Definition of Done requires audit logging on every module,
yet Accounting is Phase 7 and Audit is Phase 8. Building in that order means either stubs in financial code, or retrofitting posting into finished modules.

The proposal keeps your phases but pulls forward thin **kernels**, leaving the full feature sets where you placed them.

| Phase | Name                                              | Scope                                                                                                                                           | Size | Exit criteria                                                             |
| ----- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------- |
| 1     | Architecture                                      | This document set                                                                                                                               | —    | Your approval; blocking questions answered                                |
| 2     | Foundation                                        | Monorepo, Compose, CI, env validation, shared packages, **kernel: errors, context, tenant guard, audit writer, idempotency, outbox, numbering** | L    | `docker compose up` healthy; CI green; guard and kernel tests pass        |
| 2a    | **Calc engine** (moved up)                        | Full engine and golden vectors                                                                                                                  | M    | Accountant signs off vectors                                              |
| 3     | Auth and access                                   | Login, rotation, MFA, sessions, users, RBAC, approvals kernel, org setup UI                                                                     | L    | Security and isolation test suites pass                                   |
| 4     | Master data                                       | Parties (with KYC capture), products, purities, gold rates, warehouses, branches                                                                | L    | Each module meets Definition of Done                                      |
| 4a    | **Ledger and tax kernel** (moved up from 7 and 8) | Chart of accounts, posting service, posting profiles, periods, immutability role, tax code determination                                        | M    | Balanced posting, immutability and period tests pass                      |
| 5     | Inventory                                         | Movements, receiving, issuing, adjustments, transfers, reservations, counts, valuation                                                          | XL   | Concurrency suite and I3, I6 pass                                         |
| 6     | Purchase and Sales                                | Orders, invoices, returns, payments, open items, PDFs, email                                                                                    | XL   | Ten-step E2E passes                                                       |
| 7     | Accounting and Finance                            | Manual journals, reversal UI, GL, reconciliation, close, statements, cashbook, bankbook                                                         | L    | Trial balance, P&L and balance sheet agree with independent recalculation |
| 8     | VAT and Compliance                                | VAT reports, tax invoice review, KYC workflows, AML rules, regulatory reports, audit UI, e-invoice adapter design                               | L    | Rules reviewed by a UAE tax and AML adviser                               |
| 9     | Analytics                                         | Dashboards, full report catalogue, exports, schedules                                                                                           | L    | Reports reconcile with ledger                                             |
| 10    | Production preparation                            | Load test, security review, restore drill, rollback drill, readiness report                                                                     | L    | Evidence recorded on the checklist                                        |

Sizes are relative. I have not converted them to dates, since the pace depends on your review cadence and on answers to open questions.

## 14.2 Working method per module

Requirements note → contract (Zod and OpenAPI) → model and indexes → service and repository → API → frontend → audit and permissions → tests → docs → verify end to end.
Each phase ends with a report stating what was run, what passed and what remains. Critical modules go through a review pass before being marked done.

## 14.3 Honest scope statement

This is a very large system and will span many working sessions. Reaching "code complete" is achievable through this roadmap. **"Production ready" additionally requires** things that cannot be done from a code editor:
your accountant's sign-off on posting rules, UAE tax and AML adviser review, a real deployment target, and penetration testing. Those are tracked as explicit gates, and I won't describe the system as production-ready without them.
