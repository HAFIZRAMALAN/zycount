# 01 — Accounting Principles & Glossary

## Fundamental invariants (§3)

These are enforced in code and asserted in tests ([12 — Testing](12-testing-strategy.md)).

1. **Every journal balances:** `Σ debit = Σ credit` (to the cent) and total > 0.
2. **Accounting equation holds:** `Assets = Liabilities + Equity` at all times.
3. **Trial balance balances:** `Σ all debits = Σ all credits` across the GL.
4. **Immutability of posted entries:** once `POSTED`, a journal's lines never change. Corrections
   are made by posting a **reversal** (an equal-and-opposite entry that references the original).
5. **Period integrity:** entries cannot post into a `CLOSED` period; reopening is authorised and audited.
6. **Full traceability:** every GL line carries `source` + `sourceId`; every financial-statement
   figure drills down to GL → journal → source document → audit trail.

## Normal balances

| Account type | Increases with | Normal balance |
|---|---|---|
| Asset | Debit | Debit |
| Expense | Debit | Debit |
| Cost of Sales | Debit | Debit |
| Liability | Credit | Credit |
| Equity | Credit | Credit |
| Revenue | Credit | Credit |

## Posting lifecycle

```
DRAFT ──post──▶ POSTED ──reverse──▶ REVERSED
  │                                     ▲
  └──edit/delete allowed only here      │
                                        └── reversal is itself a POSTED entry
```

- **DRAFT** — editable, not in the GL, not in reports.
- **POSTED** — in the GL, immutable, appears in reports.
- **REVERSED** — a posted entry that has been fully reversed by a linked reversal entry.

## Period locking (§30)

- Periods have status `OPEN` or `CLOSED`.
- Closing a period requires the month-end checklist to be complete (or explicitly overridden with audit).
- Normal users cannot post to or edit a closed period.
- Reopening requires an authorised role and writes an `AuditLog` entry.

## Glossary

| Term | Meaning |
|---|---|
| **COA** | Chart of Accounts — the tree of ledger accounts |
| **GL** | General Ledger — the posted, immutable record of all journal lines |
| **Journal / JV** | A balanced set of debit/credit lines representing one accounting event |
| **AR / AP** | Accounts Receivable / Accounts Payable |
| **Fiscal period** | A datable accounting window (usually a calendar month) |
| **Reversal** | An equal-and-opposite journal that cancels a posted entry |
| **Recurring journal** | A template that auto-posts on a schedule |
| **Three-way match** | PO qty vs GRN qty vs invoice qty/value reconciliation before AP approval |
| **FX revaluation** | Period-end restatement of foreign-currency balances at current rates |
| **Base / functional currency** | The company's reporting currency (default MYR) |
| **Posting rule** | The Dr/Cr mapping a business transaction produces (see [04](04-accounting-posting-rules.md)) |
