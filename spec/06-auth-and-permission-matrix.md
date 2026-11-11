# 06 — Auth & Permission Matrix (§2)

## Roles

`SuperAdmin, Admin, Accountant, FinanceManager, Auditor, Sales, Purchaser, HR, Employee, ReadOnly`.

Roles are assigned per user; a user may hold several. Permissions are the union of their roles'
permissions. Company access is scoped separately (a user is granted access to specific companies).

## Permission actions (§2)

`view, create, edit, delete, approve, post, reverse, export, print` — expressed as codes
`<module>.<action>` (e.g. `invoice.create`, `journal.post`, `period.close`).

## Permission matrix (representative)

✔ = allowed. Fine-grained overrides possible via custom roles (Phase 6).

| Module / action | SuperAdmin | Admin | Accountant | FinanceMgr | Auditor | Sales | Purchaser | HR | Employee | ReadOnly |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Company settings edit | ✔ | ✔ |  |  |  |  |  |  |  |  |
| Users & roles | ✔ | ✔ |  |  |  |  |  |  |  |  |
| COA manage | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |
| Journal create/edit | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |
| Journal **post** | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |
| Journal **reverse** | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |
| Period **close/reopen** | ✔ | ✔ |  | ✔ |  |  |  |  |  |  |
| Invoice create | ✔ | ✔ | ✔ | ✔ |  | ✔ |  |  |  |  |
| Invoice approve/post | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |
| Bill create | ✔ | ✔ | ✔ | ✔ |  |  | ✔ |  |  |  |
| Payment post | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |
| Payroll run | ✔ | ✔ |  | ✔ |  |  |  | ✔ |  |  |
| Expense claim submit | ✔ | ✔ | ✔ | ✔ |  | ✔ | ✔ | ✔ | ✔ |  |
| Reports view/export | ✔ | ✔ | ✔ | ✔ | ✔ |  |  |  |  | ✔ |
| Audit log view | ✔ | ✔ |  | ✔ | ✔ |  |  |  |  |  |
| Everything (read only) |  |  |  |  | ✔ |  |  |  |  | ✔ |

*Auditor* is read-only across financial data **plus** audit-log access; never mutates.

## Authentication

- **Password hashing:** Argon2id.
- **MFA/2FA:** TOTP (authenticator apps); enforced for privileged roles; recovery codes issued once.
- **Sessions:** short-lived JWT access token (~15 min) + rotating refresh token in an httpOnly, Secure, SameSite cookie. Refresh tokens are revocable and tracked per device.
- **Password policy:** min length, complexity, breached-password check, no reuse of last N.
- **Login history & device/IP monitoring:** recorded; unusual logins flagged.
- **Rate limiting:** on auth and sensitive endpoints.

## Enforcement

- API: a `@RequirePermission('journal.post')` guard checks the user's effective permissions **and** company scope on every mutating route.
- UI: controls are hidden/disabled by permission, but the server is the source of truth — the UI never grants access the API wouldn't.
- Every privileged action writes an `AuditLog` entry.

## Web security (§2)

Encryption in transit (TLS) and at rest; CSRF protection on cookie-auth routes; XSS output-encoding;
parameterised queries / ORM (no string-built SQL); security headers (CSP, HSTS); input validation on every endpoint.
