# 8. Accounting and Inventory Consistency Strategy

## 8.1 Invariants

| #   | Invariant                                                    | Mechanism                                        | Detected by                            |
| --- | ------------------------------------------------------------ | ------------------------------------------------ | -------------------------------------- |
| I1  | Every journal balances                                       | Service check; `$expr` validator on the header   | Integrity job compares lines to header |
| I2  | Posted financial records never change                        | Insert-only DB role                              | Permission test; hash check            |
| I3  | Stock balance equals the sum of its movements                | Same transaction                                 | Nightly recompute                      |
| I4  | Stock never goes negative unless configured                  | Conditional update                               | Concurrency test                       |
| I5  | A serial piece is sold at most once                          | Compare-and-set on status                        | Concurrency test                       |
| I6  | Inventory value agrees with the Inventory GL control account | Same transaction                                 | Reconciliation report                  |
| I7  | AR/AP control accounts equal the sum of open items           | Same transaction                                 | Reconciliation report                  |
| I8  | Business numbers are unique and gapless within scope         | Counter in the posting transaction, unique index | Gap report                             |
| I9  | Every journal traces to its source                           | Required `sourceDoc`, unique per kind            | Integrity job                          |
| I10 | No posting into a closed period                              | Two-phase close                                  | Integrity job                          |

## 8.2 Transaction rules

**Use a transaction** whenever a command writes more than one document that must agree: posting, payment, transfer dispatch or receipt, adjustment approval, reversal.

**Do not use one** for single-document updates, master data, reads, reports, or anything calling an external system.

- `session.withTransaction()` with `readConcern: snapshot`, `writeConcern: majority`. It retries the callback on transient errors, so **the callback holds no side effects**: no email, HTTP or queue calls. Those go through the outbox.
- Invoice lines are capped at 500, keeping transactions short and well below the 60-second default lifetime.
- Lock ordering: resources are touched in a fixed order (stock keys sorted, then series, then party), reducing retries.

## 8.3 Stock writes

```js
// Fungible stock. Filter and update are one atomic operation.
stockBalances.updateOne(
  { ...key, availableNet: { $gte: qty } },     // omitted only when negative stock is explicitly enabled
  { $inc: { onHandNet: -qty, availableNet: -qty, /* pieces, gross, fine */ }, ... },
  { session })
// matchedCount === 0 → InsufficientStockError, transaction aborts
```

```js
// Serial piece
stockItems.updateOne(
  { _id, status: 'IN_STOCK' },
  { $set: { status: 'SOLD', soldBy: invoiceId } },
  { session },
);
```

Moving average cost requires reading before writing, so it uses the `version` field as a compare-and-set inside the transaction.

`stockBalances` tracks four quantities in parallel, since gold is controlled by weight and purity as well as by count: pieces, gross, net, fine.

## 8.4 Write skew and how it is closed

Snapshot isolation does not stop two transactions that read the same row and write different rows.

- **Credit limit.** Two concurrent credit sales could each see headroom. Fixed by a conditional update on the shared `partyBalances` document, so they conflict.
- **Period close.** A posting could read `OPEN` while close commits. Writing to the period document on each post would serialise all postings company-wide.
  Instead close is two-phase: set `CLOSING`, which new postings reject, then wait longer than the maximum transaction lifetime so in-flight transactions drain,
  then verify and set `CLOSED`.
- **Number series.** Incremented inside the posting transaction, so it rolls back with it. Contention is limited to one series scope, which is acceptable at trading volumes and required by gapless numbering.

## 8.5 Immutability and correction

- `journalEntries`, `journalLines`, `stockMovements`, `paymentAllocations`, `taxTransactions`, `goldRates`, `auditLogs` and others of class A use a custom MongoDB role with `find` and `insert` only. Migrations run under a separate, deploy-time credential.
- A reversal inserts a new entry with swapped sides and `reversesEntryId`. A unique index allows only one. Reversal in a closed period posts to the current open period.
- `salesInvoices` and similar class D documents move through statuses, so a role cannot freeze them. Instead a canonical `postedHash` is written at posting and the integrity job verifies it. Tampering becomes detectable, though not impossible at the database level.
- Outstanding balances live in `openItems`, so payments never touch a posted invoice.

## 8.6 Idempotency

`Idempotency-Key` is required on commands that move money or stock. The key is claimed **inside the same transaction**, so a crash leaves no partial claim.
Same key and same body returns the stored response; same key with a different body returns `422`. A concurrent duplicate conflicts on the unique index, retries once the first request commits, and then replays its response, so callers do not need to handle an in-flight state.
Unique constraints on source documents give a second, independent barrier.

## 8.7 Outbox

Events are inserted in the business transaction. The relay claims pending rows and enqueues to BullMQ with `jobId = eventId`, and handlers are idempotent.
Delivery is at-least-once. Failed jobs retry with exponential backoff, then land in a dead-letter queue with an alert.

## 8.8 Integrity job

Nightly per company, reporting to Compliance and on-call: journal balance (I1), balance recompute (I3), control-account reconciliation (I6, I7),
number gaps (I8), `postedHash` verification, audit seal verification. A failure raises a critical alert and is **never auto-repaired**. Investigation is a human decision.

## 8.9 Audit integrity

Audit rows are written inside the business transaction. A per-company hash chain across each row would serialise all writes, so the worker **seals batches** periodically,
chaining each seal to the last, and exports seals to write-once object storage. A retrospective edit then breaks a chain whose anchor sits outside the database.

## 8.10 Reporting consistency

Financial statements aggregate `journalLines` directly, with `ledgerRollups` for closed periods and dashboards. Rollups are updated asynchronously and reconciled, keeping AR and Cash from becoming hot documents in the posting path.
Statutory reports read from the primary or with majority read concern. Dashboards may use secondaries.
