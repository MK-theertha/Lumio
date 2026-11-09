# Lumio — Gold Trading ERP: Documentation Index

**Status:** Architecture approved on 2026-11-08. Phase 2 (foundation) and the calculation engine are built.
These documents describe the target design; [production-readiness.md](production-readiness.md) records what actually exists and has been verified.

**Start here:** the [Project Guide](PROJECT-GUIDE.md) explains how the code works today, and the [File Reference](FILE-REFERENCE.md) describes every file. The documents below record the intended design.

| #    | Topic                                   | Document                                                                                       |
| ---- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1    | System architecture and decision record | [architecture/01-system-architecture.md](architecture/01-system-architecture.md)               |
| 2, 3 | Business domains and module hierarchy   | [architecture/02-domains-and-modules.md](architecture/02-domains-and-modules.md)               |
| 4, 5 | MongoDB collections and relationships   | [database/01-collections-and-relationships.md](database/01-collections-and-relationships.md)   |
| 6    | Critical business workflows             | [business-rules/01-workflows.md](business-rules/01-workflows.md)                               |
| 7    | Gold calculation engine                 | [business-rules/02-calculation-engine.md](business-rules/02-calculation-engine.md)             |
| 8    | Accounting and inventory consistency    | [architecture/03-consistency-strategy.md](architecture/03-consistency-strategy.md)             |
| 9    | Authentication, RBAC and security       | [architecture/04-security-and-rbac.md](architecture/04-security-and-rbac.md)                   |
| 10   | API design strategy                     | [api/01-api-strategy.md](api/01-api-strategy.md)                                               |
| 11   | Frontend architecture                   | [architecture/05-frontend.md](architecture/05-frontend.md)                                     |
| 12   | Docker, CI/CD and observability         | [deployment/01-docker-cicd-observability.md](deployment/01-docker-cicd-observability.md)       |
| 13   | Testing strategy                        | [architecture/06-testing-strategy.md](architecture/06-testing-strategy.md)                     |
| 14   | Implementation roadmap                  | [architecture/07-roadmap.md](architecture/07-roadmap.md)                                       |
| 15   | Risks, assumptions, open questions      | [business-rules/03-risks-and-open-questions.md](business-rules/03-risks-and-open-questions.md) |

## Where this proposal departs from the brief

Each departure needs your approval. The reasoning is in the linked document.

| Brief                                                 | Proposal                                                                                                                     | Why                                                                                                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Accounting in Phase 7, audit and VAT in Phase 8       | Build the **ledger, tax-calculation, audit, approval and outbox kernels** before the modules that depend on them             | Sales step 13 "update accounting" and the Definition of Done cannot be met otherwise ([roadmap](architecture/07-roadmap.md))           |
| Gold Value = Fine Weight × Applicable Rate            | Every rate carries an explicit **basis**                                                                                     | Applying a 22K rate to fine weight discounts purity twice ([engine](business-rules/02-calculation-engine.md#2-the-rate-basis-problem)) |
| Separate customer and supplier modules                | Two UI modules over **one `parties` collection**                                                                             | One KYC record and one AML view per legal person; a customer selling old gold is also a supplier                                       |
| Access token storage unspecified, "HTTP-only cookies" | Refresh token in an HttpOnly cookie; **access token in memory** as a Bearer header                                           | Removes CSRF from every API route but one                                                                                              |
| `packages/` lists three packages                      | Add **`packages/calc-engine`**                                                                                               | Client preview and server must run identical arithmetic                                                                                |
| `frontend/src/stores/`                                | `contexts/`                                                                                                                  | The stack specifies React Context, with no store library                                                                               |
| Stack list                                            | Add `decimal.js`, TanStack Table, `dependency-cruiser`, headless Chromium (worker only), ClamAV, SeaweedFS and Mailpit (dev) | Each fills a stated requirement; see the decision record                                                                               |
