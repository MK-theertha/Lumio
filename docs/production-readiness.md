# Production Readiness Checklist

**Current assessment: not production ready.** The ERP works end to end in development, but it has never been deployed and the gates at the end of this file are open. This file records evidence, not intentions.

## Status by module

| Area                | Working                                                                                                                                                                                                                                                                                                                                        | Missing                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth and access     | Login, MFA with recovery codes, refresh rotation and reuse detection, lockout, reset, invites, sessions, roles, company and branch limits, company switching, optional breached-password check, first platform admin command                                                                                                                   | Nothing known                                                                                                                                                     |
| Master data         | Customers, suppliers, products, purities, branches with emirate, warehouses, departments, employees, beneficial owners, statements, party pricing, activity notes, supplier performance                                                                                                                                                        | Nothing known                                                                                                                                                     |
| Gold rates          | Entry in g, kg, oz or tola; both rate bases; spot USD/oz conversion; rate board by purity; approval; insert-only history; snapshot on every invoice line                                                                                                                                                                                       | External rate feed, which needs a provider account                                                                                                                |
| Metal accounts      | Unfixed metal received from and issued to parties in fine grams, price fixing with VAT and gain or loss, limits, statements, position report, integrity check                                                                                                                                                                                  | Gold loans, consignment, goldsmith job work                                                                                                                       |
| Inventory           | Lots and tagged pieces, receive, issue, approved adjustments, transfers through in-transit, oldest-lot-first relief, valuation, reservations with expiry, physical counts, barcode labels                                                                                                                                                      | Nothing known                                                                                                                                                     |
| Sales and purchases | Drafts, server pricing, approvals, atomic posting, returns including part of a line, credit notes, gapless numbering, print view, PDF invoices and credit notes with Arabic labels, emailing invoices, purchase orders, goods receipts with variance                                                                                           | Review of the Arabic wording by a native speaker                                                                                                                  |
| Finance             | Receipts, payments, allocation, reversal, refunds via the opposite direction, credit limits, bank statement CSV import, auto and manual matching, booking and netting bank items, reconciliation that must balance, period close check, cash book                                                                                              | Direct bank feeds                                                                                                                                                 |
| Accounting          | Chart of accounts, balanced immutable journals, reversal, manual journals with a second approver, foreign currency on journals and invoices, two-phase period close, year-end closing entries, statements, branch posting profiles                                                                                                             | Exchange gain or loss on settlement, revaluation                                                                                                                  |
| VAT                 | Configurable codes and rules, reverse charge, inclusive and exclusive, VAT reports, VAT Form 201 draft by emirate, reconciliation to the ledger, record of filings, verified-code gate, UBL e-invoice and credit note XML, provider adapter                                                                                                    | Accredited e-invoicing provider (only a local simulator exists), XML validation against PINT AE, imports and adjustments on the return, tax invoice format review |
| Compliance          | KYC with encrypted identifiers, threshold rules, cases and decisions, audit log with sealed batches exported outside the database, sanctions screening of parties and beneficial owners against imported lists with a nightly UN refresh, holds on flagged parties, goAML DPMSR and STR preparation with second-person approval and sealed XML | Validation against the FIU goAML XSD                                                                                                                              |
| Reports             | Dashboard, 26 reports including profit by customer, product, purity and month, net profit by branch, metal position; CSV, Excel and PDF export, scheduled reports by email                                                                                                                                                                     | Nothing known                                                                                                                                                     |
| Documents           | Upload with content-based type checks, private S3-compatible storage, ClamAV scanning, versions, expiry list and reminders, audited downloads, stricter access for KYC files                                                                                                                                                                   | Per-object encryption beyond what the bucket provides                                                                                                             |
| Notifications       | Email through the outbox, in-app notifications, document expiry, low-stock and payment-due alerts                                                                                                                                                                                                                                              | Nothing known                                                                                                                                                     |
| Platform            | Migrations, outbox, retries, dead-letter queue, health checks, structured logs, optional Sentry, browser error reporting, OpenTelemetry metrics and traces, nightly integrity job, reservation expiry job, encrypted backup and restore scripts, TLS proxy configuration                                                                       | Nothing known                                                                                                                                                     |

## Verified locally (2026-11-09)

- Lint, formatting, strict type checks, module boundaries and OpenAPI drift check pass.
- 125 unit and component tests and 224 integration tests pass, on a real MongoDB 8 replica set, Redis and an S3-compatible store.
- Browser tests pass against the running stack: sign-in, every navigation page, theme, a full buy, sell, pay and report workflow, and sanctions import, document upload and download, and bank statement import.
- Tested under real concurrency: 12 sales exceeding stock, 8 sales of one tagged piece, duplicate idempotency keys, concurrent credit sales at the limit, one payment matched to two statement lines.
- Tested: company and branch isolation across every route with an ID (generated from the real routes, and confirmed to leave the other company's data unchanged), permissions, second-person approval, immutable journals, single reversal, period close, MFA, token reuse.
- The integrity job detects deliberately altered journals, stock, party balances, invoices, audit rows and seals, deleted invoices, and postings into closed periods.
- Document scans, sanctions rechecks and e-invoices run through the real outbox, queue and worker. Scanning was run once against a real ClamAV daemon, including detection of the EICAR test file.
- The sanctions parser reads the published UN consolidated list (1,007 subjects, checked 2026-11-09).
- API and worker production images run healthy, non-root, read-only, with all capabilities dropped (not re-run since the documents and reporting work).
- `npm audit --omit=dev` reports no known vulnerabilities.
- Database-level immutability drilled on an authenticated replica set: the application user cannot change or delete journals, audit logs or metal entries, and the application ran seeding, Dubai defaults, a payment, a reversal and an integrity run under that user without permission errors.
- Encrypted backup and restore drilled locally: all 70 collections matched and every integrity check passed on the restored copy.
- TLS proxy drilled locally with an internal certificate: HTTPS, HSTS and redirect from HTTP.
- Load: 20 concurrent users on one development machine, reads and posted payments, no errors, p95 248 ms, and integrity checks passed afterwards. This does not predict production capacity.

## Not verified

- GitHub Actions and `deploy.sh` have never been executed, including the new browser test job. Rollback is untested.
- No failover or penetration testing, and no load test on production-like infrastructure.
- goAML XML follows the UNODC element names and has not been validated against the UAE FIU XSD. E-invoice XML has not been checked by an accredited provider or against PINT AE. Neither may be filed until it has.
- The Arabic labels on PDFs have not been reviewed by a native speaker or tax adviser.
- The nightly job has run in tests by direct call. The BullMQ schedule itself has not been observed firing at 02:00.
- Metrics have not been scraped by a real Prometheus.

## Known technical debt

| Item                                                                                             | Resolve by |
| ------------------------------------------------------------------------------------------------ | ---------- |
| OpenAPI documents every route's request, permissions and errors, but not success response bodies | Later      |
| Invoice lines price on the server only; the client preview from `calc-engine` was not built      | Later      |
| Base images pinned by tag, `latest` dev images, Node 22, TypeScript 6                            | Phase 10   |

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
