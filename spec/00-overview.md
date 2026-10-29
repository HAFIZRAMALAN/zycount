# 00 — Overview

## Vision (§1, §63)

Zycount is a **financial operating system**, not merely an application that records transactions.
The defining principle: every business transaction automatically produces the correct accounting
impact while staying traceable back to its source document.

```
SOURCE DOCUMENT → BUSINESS TRANSACTION → ACCOUNTING POSTING → JOURNAL → GENERAL LEDGER → FINANCIAL REPORT
```

Traditional accounting: `Transaction → Report`.
Zycount: `Transaction → Accounting Engine → Real-time Financial Data → Analysis → Automation → AI-assisted decision support`.

## Core pillars

1. **Accounting** — double-entry engine, GL, reporting
2. **Business Operations** — sales, purchasing, inventory, projects
3. **Finance** — banking, assets, tax, budgeting, multi-currency
4. **People / Payroll** — employees, Malaysian statutory payroll
5. **Intelligence / AI** — copilot, OCR, anomaly detection, reporting
6. **Automation** — WHEN→IF→THEN engine, approvals, tasks
7. **Platform** — REST API, OAuth, webhooks, integrations

## Target context

Malaysia-first: base currency **MYR**, statutory payroll (**EPF/KWSP, SOCSO/PERKESO, EIS, PCB/MTD, EA, CP8D**),
and **SST** tax. All statutory figures are configuration, verified before production. Multi-currency and
multi-company are first-class so the product is not locked to a single jurisdiction.

## Scope

The specification covers all 64 blueprint areas. Delivery is phased (see
[16 — Phase Roadmap](16-phase-roadmap-and-launch-checklist.md)):

| Phase | Theme | Headline modules |
|---|---|---|
| 0 | Foundation | Spec, design system, DB schema, architecture, accounting rules |
| 1 | Core accounting | Auth, Company, Users/RBAC, COA, Journal, GL, Trial Balance, P&L, Balance Sheet |
| 2 | Commercial | AR (invoices), AP (bills), Payments, Banking + reconciliation |
| 3 | Operations | Inventory, Purchasing (PO/GRN/3-way match), Fixed Assets, Expenses, Projects |
| 4 | Advanced finance | Payroll, Tax, Budget, Multi-currency + FX, Multi-company/consolidation |
| 5 | Intelligence | AI copilot, OCR, automation, anomaly detection, AI reporting |
| 6 | Enterprise | SSO, advanced permissions, API marketplace, advanced audit, data warehouse |

## Non-negotiable product rules

- Never allow an unbalanced journal.
- Posted transactions are **reversed, not deleted or silently edited**.
- Locked periods cannot be changed without an audited reopening.
- Every report is traceable to the GL; every GL entry to its source document.
- The AI **suggests** actions and **grounds every claim in real data** — it never silently posts.
- Users must always know whether a transaction was posted (see [09 — Errors](09-status-validation-errors.md)).
