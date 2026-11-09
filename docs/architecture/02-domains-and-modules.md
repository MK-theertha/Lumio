# 2–3. Business Domains and Module Hierarchy

## 2.1 Domain classification

| Domain                       | Type       | Owns                                                          | Why it is classified this way                            |
| ---------------------------- | ---------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| Gold pricing and calculation | Core       | Purities, rates, pricing policies, engine                     | The product's differentiator; errors cost money directly |
| Inventory                    | Core       | Lots, pieces, balances, movements, counts                     | Physical gold is the main asset                          |
| Sales                        | Core       | Invoices, returns, receipts                                   | Revenue workflow                                         |
| Purchasing                   | Core       | Orders, receipts, invoices, returns                           | Supply workflow, including old-gold buyback              |
| Ledger                       | Core       | Chart of accounts, journals, periods                          | Financial truth                                          |
| Finance                      | Supporting | Cash and bank accounts, payments, allocations, reconciliation | Feeds the ledger                                         |
| Tax                          | Supporting | Tax codes, treatment rules, VAT records                       | Jurisdiction-specific and configurable                   |
| Compliance                   | Supporting | KYC, risk flags, cases, regulatory reports                    | Regulated obligation                                     |
| Master data                  | Supporting | Parties, products, categories                                 | Shared reference data                                    |
| Organisation                 | Generic    | Companies, branches, warehouses, employees                    | Standard                                                 |
| Identity and access          | Generic    | Users, sessions, roles                                        | Standard, security-critical                              |
| Reporting                    | Generic    | Read models, exports, dashboards                              | Reads only, owns no truth                                |
| Platform kernel              | Generic    | Audit, approvals, numbering, documents, notifications, outbox | Shared mechanisms                                        |

## 2.2 Module hierarchy

```
platform-kernel
├─ tenancy-context      request context, guard plugin
├─ audit                immutable log, integrity seals
├─ approvals            policies, requests, maker-checker
├─ numbering            gapless series by scope
├─ idempotency          key claim and replay
├─ outbox               event capture and relay
├─ documents            upload, scan, versions, expiry, download
└─ notifications        in-app, email

organisation            companies · branches · warehouses · locations · departments · employees · settings
identity                auth · MFA · sessions · login history · users
access                  roles · permissions · assignments

master-data
├─ parties              profiles · addresses · tax registration · categories · notes and activity · credit limits
│                       customer view · supplier view · statements · supplier performance
└─ products             catalogue · categories · barcodes

pricing
├─ purities             karat and fineness master · custom purities
├─ gold-rates           entry · approval · history · lookup · provider adapters
├─ pricing-policies     making and wastage defaults · rounding profile
└─ party-pricing        customer- and supplier-specific rules

inventory
├─ lots-and-pieces      batches · serialised pieces · labels
├─ movements            receive · issue · ledger
├─ reservations
├─ transfers            dispatch · in-transit · receive · variance
├─ adjustments          approval-based
├─ counts               physical verification · reconciliation
├─ valuation            cost layers · valuation
└─ alerts               low stock

purchasing              orders · goods receipts · invoices · returns · supplier credit notes · attachments
sales                   invoices · returns · refunds · credit notes · receipts · PDF · email

finance
├─ accounts             cash · bank · payment
├─ payments             receipts · payments · refunds · methods
├─ allocation           open items · allocation · outstanding
└─ reconciliation       statements · matching · cashbook · bankbook

ledger
├─ chart-of-accounts
├─ journals             drafts · approval · posted · reversal
├─ posting-profiles     business event → account mapping
├─ periods              fiscal years · close · reopen
└─ statements           trial balance · P&L · balance sheet · cash flow

tax                     tax codes · treatment rules · transactions · VAT reports · reconciliation · e-invoice adapter
compliance              KYC · screening adapter · rule engine · risk flags · cases · regulatory reports
reporting               dashboards · report catalogue · exports · schedules
```

## 2.3 Permission-relevant user journeys per role

| Role                            | Primary work                                   | Must not do                                        |
| ------------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| Super Administrator             | Platform: provision companies, support         | Read tenant financials without audited break-glass |
| Company Administrator           | Users, settings, branches                      | Approve own changes                                |
| Branch Manager                  | Branch approvals and oversight                 | See other branches unless assigned                 |
| Accountant                      | Journals, periods, reconciliation              | Create sales they then approve                     |
| Sales Manager / Executive       | Sales; manager approves discounts              | Executive: see cost price or margin                |
| Purchase Manager                | Purchases and approvals                        | Approve own purchase                               |
| Inventory Manager / Storekeeper | Stock operations; manager approves adjustments | Storekeeper: see valuation                         |
| Auditor                         | Read everything in scope, export               | Change anything                                    |
