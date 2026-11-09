# Production Readiness Checklist

**Current assessment: not production ready.** The core ERP works end to end in development. This file records evidence, not intentions.

## Status by module

| Area                | Working                                                                                                                                                                                                                                                      | Missing                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth and access     | Login, MFA with recovery codes, refresh rotation and reuse detection, lockout, reset, invites, sessions, roles, company and branch limits                                                                                                                    | Company switching for users in several companies; breached-password check                                                                                                               |
| Master data         | Customers, suppliers, products, purities, branches, warehouses, departments, employees                                                                                                                                                                       | Customer and supplier statements, supplier performance, activity notes UI, party pricing UI (API exists)                                                                                |
| Gold rates          | Entry in g, kg or troy oz; both rate bases; approval; insert-only history; snapshot on every invoice line                                                                                                                                                    | External rate provider                                                                                                                                                                  |
| Inventory           | Lots and tagged pieces, receive, issue, approved adjustments, transfers through in-transit, oldest-lot-first relief, valuation                                                                                                                               | UI for reservations and physical counts (API exists); partial receipt with variance; barcode printing                                                                                   |
| Sales and purchases | Drafts, server pricing, approvals, atomic posting, returns with credit notes, gapless numbering, print view, PDF invoices                                                                                                                                    | Bilingual (Arabic) PDF, credit note PDF, emailing invoices, goods receipts separate from invoices, purchase order UI (API only), partial-line returns                                   |
| Finance             | Receipts, payments, allocation, reversal, refunds via the opposite direction, credit limits, bank statement CSV import, auto and manual matching, booking bank-only items, reconciliation that must balance before it completes                              | Direct bank feeds, a way to net a bounced payment against its reversal, unreconciled-account check in period close, dedicated cashbook and bankbook screens (general ledger API exists) |
| Accounting          | Chart of accounts, balanced immutable journals, reversal, manual journals with a second approver, two-phase period close, statements                                                                                                                         | Multi-currency journals, year-end closing entries, configurable posting profiles beyond account roles                                                                                   |
| VAT                 | Configurable codes and rules, reverse charge, inclusive and exclusive, VAT reports, verified-code gate, UBL e-invoice XML, provider adapter with retries and status tracking                                                                                 | Accredited e-invoicing provider (only a local simulator exists), e-invoice credit notes, validation of the XML against PINT AE, tax invoice format review, tax return, reconciliation   |
| Compliance          | KYC with encrypted identifiers, threshold rules, cases and decisions, audit log, sanctions screening against imported lists (UN consolidated XML, CSV), holds on flagged parties, goAML DPMSR and STR preparation with second-person approval and sealed XML | Validation against the FIU goAML XSD, automatic list refresh, screening of beneficial owners, audit sealing                                                                             |
| Reports             | Dashboard, 19 reports, CSV export with formula-injection protection                                                                                                                                                                                          | Excel and PDF export, scheduled reports, profitability beyond gross profit                                                                                                              |
| Documents           | Upload with content-based type checks, private S3-compatible storage, ClamAV scanning, versions, expiry list, audited downloads, stricter access for KYC files                                                                                               | Reminders before expiry, per-object encryption beyond what the bucket provides                                                                                                          |
| Notifications       | Email through the outbox                                                                                                                                                                                                                                     | In-app notifications, low-stock and payment-due alerts                                                                                                                                  |
| Platform            | Migrations, outbox, retries, dead-letter queue, health checks, structured logs, optional Sentry                                                                                                                                                              | OpenTelemetry metrics, nightly integrity job, reservation expiry job                                                                                                                    |

## Verified locally (2026-11-09)

- Lint, formatting, strict type checks, module boundaries and OpenAPI drift check pass.
- 124 unit and component tests and 122 integration tests pass, on a real MongoDB 8 replica set, Redis and an S3-compatible store.
- 5 Playwright browser tests pass against the running stack: sign-in, every navigation page, theme, a full buy, sell, pay and report workflow, and sanctions import, document upload and download, and bank statement import.
- The sanctions parser reads the published UN consolidated list (1,007 subjects, checked 2026-11-09).
- Tested under real concurrency: 12 sales exceeding stock, 8 sales of one tagged piece, duplicate idempotency keys, concurrent credit sales at the limit.
- Tested: company and branch isolation, permissions, second-person approval, immutable journals, single reversal, period close, MFA, token reuse.
- API and worker production images run healthy, non-root, read-only, with all capabilities dropped.
- Worker delivered email to the local mail catcher. `npm audit --omit=dev` reports no known vulnerabilities.

## Not verified

- GitHub Actions and `deploy.sh` have never been executed. Rollback is untested. CI does not run the browser tests yet.
- `infrastructure/mongo/create-app-user.js` (the database-level immutability role) has not been run. Immutability is currently enforced in application code only, so the design's database-level guarantee is not yet in force.
- No load, failover, restore or penetration testing.
- Malware scanning is tested against a stand-in that follows the clamd wire protocol, not a real ClamAV daemon.
- goAML XML follows the UNODC element names and has not been validated against the UAE FIU XSD. E-invoice XML has not been checked by an accredited provider or against PINT AE. Neither may be filed until it has.
- The worker's handlers for document scans, sanctions rechecks and e-invoices call functions that are tested directly; those three paths have not been run through the queue end to end.
- Migration `004-new-role-permissions` has only run against databases with no existing companies.
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
- [ ] AML compliance officer review of rules and reporting, including the sanctions match threshold and which lists must be imported
- [ ] Registration with goAML, and the FIU's XSD obtained
- [ ] Accredited e-invoicing service provider chosen and its adapter built
- [ ] E-invoicing obligation and deadline confirmed
- [ ] Hosting, data residency, and RPO/RTO decided
- [ ] Independent penetration test
- [ ] Restore drill and rollback drill completed
