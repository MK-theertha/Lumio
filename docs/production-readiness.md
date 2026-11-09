# Production Readiness Checklist

**Current assessment: not production ready.** The core ERP works end to end in development. This file records evidence, not intentions.

## Status by module

| Area                | Working                                                                                                                                   | Missing                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Auth and access     | Login, MFA with recovery codes, refresh rotation and reuse detection, lockout, reset, invites, sessions, roles, company and branch limits | Company switching for users in several companies; breached-password check                                                    |
| Master data         | Customers, suppliers, products, purities, branches, warehouses, departments, employees                                                    | Customer and supplier statements, supplier performance, activity notes UI, party pricing UI (API exists)                     |
| Gold rates          | Entry in g, kg or troy oz; both rate bases; approval; insert-only history; snapshot on every invoice line                                 | External rate provider                                                                                                       |
| Inventory           | Lots and tagged pieces, receive, issue, approved adjustments, transfers through in-transit, oldest-lot-first relief, valuation            | UI for reservations and physical counts (API exists); partial receipt with variance; barcode printing                        |
| Sales and purchases | Drafts, server pricing, approvals, atomic posting, returns with credit notes, gapless numbering, print view                               | PDF generation, emailing invoices, goods receipts separate from invoices, purchase order UI (API only), partial-line returns |
| Finance             | Receipts, payments, allocation, reversal, refunds via the opposite direction, credit limits                                               | Bank statement import and reconciliation, dedicated cashbook and bankbook screens (general ledger API exists)                |
| Accounting          | Chart of accounts, balanced immutable journals, reversal, manual journals with a second approver, two-phase period close, statements      | Multi-currency journals, year-end closing entries, configurable posting profiles beyond account roles                        |
| VAT                 | Configurable codes and rules, reverse charge, inclusive and exclusive, VAT reports, verified-code gate                                    | Tax invoice format review, tax return, reconciliation, e-invoicing                                                           |
| Compliance          | KYC with encrypted identifiers, threshold rules, cases and decisions, audit log                                                           | Sanctions screening, goAML report generation, audit sealing                                                                  |
| Reports             | Dashboard, 19 reports, CSV export with formula-injection protection                                                                       | Excel and PDF export, scheduled reports, profitability beyond gross profit                                                   |
| Documents           | None                                                                                                                                      | Upload, malware scanning, private storage, expiry tracking                                                                   |
| Notifications       | Email through the outbox                                                                                                                  | In-app notifications, low-stock and payment-due alerts                                                                       |
| Platform            | Migrations, outbox, retries, dead-letter queue, health checks, structured logs, optional Sentry                                           | OpenTelemetry metrics, nightly integrity job, reservation expiry job                                                         |

## Verified locally (2026-11-09)

- Lint, formatting, strict type checks, module boundaries and OpenAPI drift check pass.
- 100 unit and component tests and 81 integration tests pass, on a real MongoDB 8 replica set and Redis.
- 4 Playwright browser tests pass against the running stack: sign-in, every navigation page, theme, and a full buy, sell, pay and report workflow.
- Tested under real concurrency: 12 sales exceeding stock, 8 sales of one tagged piece, duplicate idempotency keys, concurrent credit sales at the limit.
- Tested: company and branch isolation, permissions, second-person approval, immutable journals, single reversal, period close, MFA, token reuse.
- API and worker production images run healthy, non-root, read-only, with all capabilities dropped.
- Worker delivered email to the local mail catcher. `npm audit --omit=dev` reports no known vulnerabilities.

## Not verified

- GitHub Actions and `deploy.sh` have never been executed. Rollback is untested. CI does not run the browser tests yet.
- `infrastructure/mongo/create-app-user.js` (the database-level immutability role) has not been run. Immutability is currently enforced in application code only, so the design's database-level guarantee is not yet in force.
- No load, failover, restore or penetration testing.
- Written but with no automated test yet: stock reservations and physical counts, manual journals, invitations and password-reset completion, refunds, purchase returns, party pricing rules, tax inclusive invoices through the API.

## Known technical debt

| Item                                                                                           | Resolve by |
| ---------------------------------------------------------------------------------------------- | ---------- |
| OpenAPI covers health endpoints only; business routes are undocumented                         | Next       |
| Tenant models are loosely typed (`Model<any>`), so services lose compile-time field checks     | Next       |
| Generic isolation test across every route is not yet generated; isolation is tested per sample | Next       |
| Invoice lines price on the server only; the client preview from `calc-engine` was not built    | Later      |
| Base images pinned by tag, `latest` dev images, Node 22, TypeScript 6                          | Phase 10   |
| Browser errors go to the console only                                                          | Phase 10   |

## Gates that code cannot satisfy

- [ ] Answers to open questions Q1-Q6, Q8-Q10. Pricing, rounding and costing currently use unapproved proposals
- [ ] Accountant sign-off on calculation vectors and posting rules
- [ ] UAE tax adviser review of VAT treatment and invoice content
- [ ] AML compliance officer review of rules and reporting
- [ ] E-invoicing obligation and deadline confirmed
- [ ] Hosting, data residency, and RPO/RTO decided
- [ ] Independent penetration test
- [ ] Restore drill and rollback drill completed
