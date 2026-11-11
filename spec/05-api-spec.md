# 05 — API Specification (§53)

REST API served by the NestJS backend under `/api`. JSON in/out. All money as strings to avoid
float loss (e.g. `"1234.56"`). Auth via short-lived JWT access token + refresh token (httpOnly cookie).

## Conventions

- Base URL: `/api`. Health: `/health` (unauthenticated).
- **Company scoping:** company-scoped requests carry `X-Company-Id` header (or `:companyId` path param); the API verifies the user has access.
- **Pagination:** `?page=1&pageSize=50` → `{ data, page, pageSize, total }`. Max `pageSize` 200.
- **Filtering/sort:** `?sort=-date&status=POSTED&q=INV-2026`.
- **Errors:** structured envelope (see [09](09-status-validation-errors.md)):
  ```json
  { "error": { "code": "JOURNAL_UNBALANCED", "message": "…", "reference": "ERR-20260925-00124", "posted": false } }
  ```
- **Idempotency:** POSTs that create postings accept `Idempotency-Key` header.

## Auth (§2)

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/login` | email+password → access + refresh; may return `mfaRequired` |
| POST | `/auth/mfa/verify` | TOTP code → tokens |
| POST | `/auth/refresh` | refresh cookie → new access token |
| POST | `/auth/logout` | revoke refresh token |
| GET | `/auth/me` | current user, roles, permissions, companies |

## Core accounting (Phase 1)

| Method | Path | Permission |
|---|---|---|
| GET/POST | `/companies` | `company.read` / `company.create` |
| GET/PATCH | `/companies/:id` | `company.read` / `company.edit` |
| GET/POST | `/companies/:id/accounts` | `account.read` / `account.create` |
| PATCH | `/accounts/:id` | `account.edit` |
| GET/POST | `/companies/:id/fiscal-periods` | `period.read` / `period.create` |
| POST | `/fiscal-periods/:id/close` | `period.close` |
| POST | `/fiscal-periods/:id/reopen` | `period.reopen` |
| GET/POST | `/companies/:id/journals` | `journal.read` / `journal.create` |
| GET | `/journals/:id` | `journal.read` |
| PATCH | `/journals/:id` | `journal.edit` (DRAFT only) |
| POST | `/journals/:id/post` | `journal.post` |
| POST | `/journals/:id/reverse` | `journal.reverse` |
| GET | `/companies/:id/ledger` | `ledger.read` — GL with drill-down params (account, period) |
| GET | `/companies/:id/reports/trial-balance` | `report.read` |
| GET | `/companies/:id/reports/profit-loss` | `report.read` |
| GET | `/companies/:id/reports/balance-sheet` | `report.read` |

**Create journal** body:
```json
{
  "date": "2026-01-15",
  "description": "Sales invoice INV-2026-000001",
  "lines": [
    { "accountId": "…AR…",   "debit": "1060.00", "credit": "0" },
    { "accountId": "…Sales…","debit": "0",       "credit": "1000.00" },
    { "accountId": "…Tax…",  "debit": "0",       "credit": "60.00" }
  ]
}
```
Server rejects with `JOURNAL_UNBALANCED` unless `Σdebit == Σcredit`.

## Commercial (Phase 2)

Standard REST resources with `/post`, `/approve`, `/cancel` actions where the status system applies:
`/customers`, `/invoices`, `/credit-notes`, `/receipts`, `/suppliers`, `/bills`, `/debit-notes`,
`/supplier-payments`, `/bank-accounts`, `/bank-transactions`, `/reconciliations`.
Reports: `/reports/ar-aging`, `/reports/ap-aging`, `/reports/cash-flow`.

## Later phases

Inventory (`/products`, `/warehouses`, `/stock-*`), assets (`/assets`, `/depreciation-runs`),
payroll (`/employees`, `/payroll-runs`), tax (`/tax-codes`, `/tax-returns`), budgets, projects,
documents (`/attachments`), automation (`/automations`), AI (`/ai/query`, `/ai/ocr`).

## OAuth & developer platform (§53)

- **OAuth 2.0** authorization-code + PKCE for third-party apps; scopes mirror permission codes.
- **API keys** for server-to-server, scoped and revocable, shown once on creation.
- **Developer console:** manage apps, keys, webhooks; view request logs.

## Webhooks & events (§53)

Subscribe to events; Zycount POSTs signed payloads (HMAC-SHA256 in `X-Zycount-Signature`) with retry/backoff.

Event catalog (extensible):
```
invoice.created   invoice.posted   invoice.paid
payment.received  bill.created     bill.paid
customer.created  supplier.created
journal.posted    journal.reversed
period.closed     stock.low        reconciliation.mismatch
payroll.ready     anomaly.flagged
```

## Versioning

URI-versioned when breaking: `/api/v2/…`. Additive changes stay on `/api`. Deprecations announced via `Deprecation`/`Sunset` headers.
