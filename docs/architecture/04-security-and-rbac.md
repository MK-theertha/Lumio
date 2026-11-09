# 9. Authentication, RBAC and Security

## 9.1 Token and session model

| Item            | Design                                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access token    | JWT, about 10 minutes, held in memory by the SPA, sent as `Authorization: Bearer`. Claims: `sub`, `sid`, `cid` (active company), `pv` (permission version). Signed with key rotation via `kid` |
| Refresh token   | 256-bit opaque, in cookie `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`. Stored only as SHA-256 in `sessions`                                                                         |
| Rotation        | Single use. Each refresh issues a new token in the same `familyId`                                                                                                                             |
| Reuse detection | Replay of a used token revokes the whole family and alerts the user. A short grace window, plus single-flight refresh via the Web Locks API, handles multiple tabs                             |
| Revocation      | Session state checked per request through Redis, with fallback to MongoDB. Deactivation takes effect immediately                                                                               |
| CSRF            | Bearer API is immune by construction. Cookie-bearing `/auth/refresh` and `/auth/logout` also require an `Origin` allowlist match and a custom header                                           |

## 9.2 Authentication flows

- **Passwords:** Argon2id with parameters per current OWASP guidance, calibrated on production hardware. Breached-password check is pluggable.
- **MFA:** TOTP with encrypted secrets and one-time hashed recovery codes. Mandatory for privileged roles. WebAuthn can be added behind the same interface.
- **Lockout:** Progressive delay per account plus limits per IP. Hard lockouts would let an attacker deny service to a known user, so they are time-boxed and alert.
- **Reset and verification:** Hashed single-use tokens with short TTL. Responses do not reveal whether an account exists. Reset revokes all sessions.
- **Registration:** Invite-only inside a company. Company provisioning is a platform-level action ([Q16](../business-rules/03-risks-and-open-questions.md)).
- **Multi-company users:** One `users` row, company membership via assignments. Switching company reissues the access token.

## 9.3 Authorisation

Permission keys live in `packages/shared-types`, shared by API and UI, as `resource:action`:

```
sales_invoice:create | read | update | approve | reject | post | reverse | export
journal:post | reverse   period:close | reopen   financials:view_cost   users:manage   settings:manage
```

Middleware per route: `authenticate → resolveContext → require('sales_invoice:post')`, followed by branch scope checks in the service.

| Layer                 | Enforces                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| Route                 | Permission key                                                                                              |
| Service               | Branch scope; state; **segregation of duties** (approver ≠ creator, poster ≠ approver where policy demands) |
| Repository and plugin | Tenant isolation                                                                                            |
| Serialiser            | Field-level masking (`financials:view_cost` controls cost and margin)                                       |
| UI                    | Navigation and action visibility, as a convenience only                                                     |

Roles are per-company permission bundles, seeded from the ten suggested roles and editable. Assignments carry scope (`company` or a list of branches).
Effective permissions are cached in Redis keyed by user and `pv`; changing a role bumps `pv`.

**Super Administrator** is a separate platform scope with no implicit access to tenant data. Support access is a time-boxed break-glass, with a reason, audited and visible to the tenant.

**Approval engine.** `approvalPolicies` define thresholds by document type, amount, discount percentage and branch, each with one or more levels.

## 9.4 Application security controls

| Threat          | Control                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| NoSQL injection | Zod strict schemas; `sanitizeFilter`; no user-built operators; filter allowlist per endpoint              |
| XSS             | React escaping, strict CSP via Helmet, no `dangerouslySetInnerHTML`, sanitised templates for PDF          |
| SSRF            | PDF renderer network-isolated, no remote resources                                                        |
| Abuse           | Redis sliding-window limits by route class, per IP and per user. Auth limits fail closed if Redis is down |
| CORS            | Explicit origin allowlist, per environment                                                                |
| Mass assignment | DTO-based writes; Zod strips unknown fields and rejects them on commands                                  |
| Secrets         | Validated environment at boot; secret manager in deployed environments; none in images                    |
| Logs            | Pino redaction allowlist; tests assert tokens, passwords and KYC fields never appear                      |

## 9.5 Sensitive data

KYC identifiers and bank details use field-level AES-256-GCM with envelope keys held behind a `KeyProvider` interface (env-backed in dev, KMS in production), and HMAC blind indexes for duplicate detection.
Key rotation is supported by a key ID on every ciphertext. Data at rest and in transit is encrypted at the infrastructure level as well.

## 9.6 Documents

Files are sent through the API, which decides the type from the file's own bytes (PDF, PNG or JPEG only), limits the size to 10 MB and writes to private S3-compatible storage. An outbox event has the worker scan the file with ClamAV. Clean files become downloadable; infected files are deleted and their record kept.
Downloads go through the API, need a permission check and are audited. `scanStatus` of `PENDING` or `INFECTED` is not downloadable, and a scanner failure leaves the file blocked. Without a scanner, which only development allows, files are marked `SCAN_SKIPPED`. Files attached to KYC records also need `kyc:read`.

## 9.7 Audit

Every state change records actor, action, entity, redacted before and after, IP, session and correlation ID, and is written inside the transaction.
See [consistency 8.9](03-consistency-strategy.md#89-audit-integrity).
