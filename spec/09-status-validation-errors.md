# 09 — Status, Validation & Errors (§49, §50)

## Status system (§49)

One vocabulary used across the whole product:

`Draft · Pending · Approved · Posted · Partially Paid · Paid · Overdue · Cancelled · Reversed · Archived`

| Status | Meaning | Editable? | In GL? |
|---|---|---|---|
| Draft | Being prepared | Yes | No |
| Pending | Awaiting approval | Limited | No |
| Approved | Approved, not yet posted | No | No |
| Posted | In the ledger | No (reverse only) | Yes |
| Partially Paid | Some payment allocated | No | Yes |
| Paid | Fully settled | No | Yes |
| Overdue | Past due date, unpaid | No | Yes |
| Cancelled | Voided before posting | No | No |
| Reversed | Posted then reversed | No | Yes (+ reversal) |
| Archived | Hidden from default views | No | Yes |

Transitions are validated server-side; illegal transitions are rejected.

## Validation rules (representative)

- Journals: `Σdebit = Σcredit`, ≥ 2 lines, each line one-sided, all accounts postable & active, date within an OPEN period, reference unique.
- Invoices/Bills: at least one line, positive quantities, resolvable tax code, customer/supplier active, due date ≥ issue date.
- Payments: allocation total ≤ payment amount; cannot over-allocate a document.
- Periods: cannot close with unresolved month-end items unless overridden (audited); cannot post into CLOSED.
- Master data: unique codes per company; deletion blocked when referenced (use `isActive`).

Validation is defined once as **Zod schemas in `@zycount/shared`** and enforced on both client and server.

## Error model (§50)

Never show raw `Error 500`. Every error returns a structured envelope and a user-safe message.

```json
{
  "error": {
    "code": "JOURNAL_UNBALANCED",
    "message": "This journal does not balance. Debit 1,060.00 ≠ Credit 1,000.00.",
    "reference": "ERR-20260925-00124",
    "posted": false,
    "fields": { "lines": "Debit and credit totals must match." }
  }
}
```

- **`posted`** is mandatory on any error during a posting action — the user must always know whether
  their transaction hit the ledger. If uncertain, the API resolves it before responding (idempotency key).
- **`reference`** is a traceable code logged with full context for support.
- UI presents: *"Something went wrong. Your transaction was NOT posted. Reference: ERR-… [Retry] [Contact Support]"*.

### Error code families

`AUTH_*`, `PERMISSION_DENIED`, `VALIDATION_*`, `JOURNAL_UNBALANCED`, `PERIOD_CLOSED`,
`ACCOUNT_NOT_POSTABLE`, `POSTING_RULE_UNRESOLVED`, `OVER_ALLOCATION`, `CONFLICT` (optimistic lock),
`RATE_LIMITED`, `NOT_FOUND`, `INTERNAL` (generic, still user-safe).

## Concurrency

Optimistic locking via `updatedAt`/version on editable records; a stale write returns `CONFLICT`
with the current version so the UI can reconcile — no silent overwrite of accounting data.
