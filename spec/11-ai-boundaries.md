# 11 — AI Boundaries (§38–§42)

The AI layer is **assistive and grounded**. Two rules govern everything:

1. **Grounded in real data** — the AI answers by querying actual accounting data, never by inventing figures.
2. **Suggests, never silently acts** — the AI may draft or recommend, but a human confirms anything that
   writes to the ledger. The AI has **no `journal.post` capability**.

## Finance Copilot (§38)

Natural-language questions answered from live data with drill-down links.

Example — *"Why did profit decrease this month?"*
```
Profit decreased by RM12,400 vs August.
Main movements:
 1. Revenue ↓ RM8,000   → [transactions]
 2. Salary ↑ RM4,200    → [transactions]
 3. Utilities ↑ RM1,900 → [transactions]
```

Supported queries: unpaid > 60 days, highest expenses this month, compare months, find unusual
payments, explain cash-flow changes, prepare a management summary.

**Implementation:** the copilot is a tool-using agent restricted to **read-only, permission-scoped
data tools** (e.g. `queryLedger`, `getAging`, `compareperiods`). It cannot call mutating endpoints.
Every figure it states carries a citation to the underlying transactions.

## AI OCR (§39)

Receipt/invoice image → OCR → extracted `{ vendor, date, amount, tax, suggestedAccount }`.
**The user confirms before anything posts.** Confidence scores shown; low-confidence fields flagged for review.

## Anomaly detection (§40)

Flags for review (not accusations): duplicate invoices/payments, unusual expenses/journals,
sudden margin changes, unusual supplier payments, unusual transaction timing. Each flag links to the
records and can be dismissed with a reason (audited). Flags raise notifications/tasks, never auto-reversals.

## AI month-end assistant (§41)

Reads the month-end checklist state, explains unresolved items, and suggests next steps.
It does not close the period.

## AI reporting (§42)

Generates management commentary, monthly summaries, variance explanations, collection summaries,
expense analysis, cash-flow commentary. **All claims grounded in system data**; generated text is
labelled as AI-assisted and is editable before use.

## Guardrails (enforced)

- **Capability boundary:** AI tools are a read-only subset of the API, scoped to the user's permissions and companies.
- **No auto-posting / no auto-reversal / no auto-close.**
- **Provenance:** every AI-stated number links to its source; unsupported claims are suppressed.
- **Auditability:** AI actions (queries run, suggestions accepted) are logged.
- **PII / data handling:** follows the security model in [14](14-nonfunctional.md); financial data is not sent to third parties without explicit configuration.
