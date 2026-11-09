# 13. Testing Strategy

## 13.1 Layers

| Layer          | Tools                             | Scope                                                                                                           |
| -------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Unit           | Vitest, `fast-check`              | `calc-engine`, permissions, validators, service rules                                                           |
| Integration    | Vitest, Supertest, Testcontainers | Real MongoDB **replica set** and Redis. Transactions, indexes, validators and role restrictions cannot be faked |
| Component      | React Testing Library             | Forms, tables, permission rendering                                                                             |
| End to end     | Playwright                        | Full stack in Compose                                                                                           |
| Non-functional | k6, restore drills, security scan | Load, DR, OWASP review                                                                                          |

An in-memory or mocked database is not used for integration tests. The behaviours most at risk are precisely those of the real database.

## 13.2 Must-have scenarios

**Calculation.** Accountant-approved golden vectors per purity and policy combination. Property tests: allocations sum exactly, apportionment sums exactly, inclusive and exclusive tax round-trip. Boundaries at each scale. Each guard's invalid input.

**Concurrency** (real parallel requests):

| Scenario                                          | Expected                                            |
| ------------------------------------------------- | --------------------------------------------------- |
| 20 concurrent sales of the last piece             | Exactly 1 succeeds, 19 receive `INSUFFICIENT_STOCK` |
| Concurrent lot sales summing to more than on hand | Never negative; balance equals sum of movements     |
| 50 concurrent postings in one series              | Numbers unique and gapless                          |
| Same `Idempotency-Key` sent 10 times in parallel  | One effect, identical responses                     |
| Concurrent credit sales exceeding the limit       | Limit never exceeded                                |
| Post during period close                          | Rejected, or committed before close completes       |
| Two simultaneous reversals                        | Exactly one succeeds                                |

**Atomicity.** Fault injection at each step of the posting transaction shows that nothing persists after a failure.

**Immutability.** Using the application's real DB credential, `update` and `delete` on class A collections are refused.

**Isolation.** A generated test runs against **every route in the OpenAPI document**: Company A's token against Company B's identifiers returns `404`. Branch scope equivalent. A new route is covered automatically.

**Permissions.** Generated matrix of role × endpoint, plus segregation of duties.

**Security.** Token reuse revokes the family, lockout, expired and tampered tokens, NoSQL operator payloads, upload of disguised files, log-redaction assertions.

**End to end.** The ten-step workflow in the brief, plus returns, transfers and period close.

**Invariant check after every integration suite.** The integrity job runs over the test database and must report clean.

## 13.3 Coverage gates

Line and branch coverage of 95% or more for `calc-engine`, 85% or more for ledger, inventory, finance and access. Coverage is a floor: the scenarios above are the actual bar.

## 13.4 What local tests cannot show

Performance under production data volumes, real failover behaviour and real integration with email, malware scanning or a gold rate provider need staging verification. These are tracked on the readiness checklist and will not be claimed until performed.
