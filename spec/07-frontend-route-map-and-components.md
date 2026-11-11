# 07 — Frontend Route Map & Components (§44–§47, §62)

Next.js App Router. Authenticated app lives under a company context; the sidebar mirrors §62.

## Layout (§44)

```
┌────────────────────────────────────────────────────────────┐
│ Topbar:  Search (/)   ·   🔔 Notifications   ·  + New  ·  User │
├──────────┬─────────────────────────────────────────────────┤
│ Sidebar  │  Contextual content area                          │
│ (§62)    │                                                   │
└──────────┴─────────────────────────────────────────────────┘
```

## Route map

```
/login                         /mfa
/                              → Dashboard (§18)
/accounting
  /chart-of-accounts           /journals   /journals/:id   /journals/new
  /general-ledger              /trial-balance   /periods
/sales
  /customers   /customers/:id (Customer 360, §5)
  /quotations  /sales-orders   /invoices   /invoices/:id   /credit-notes   /receipts   /ar-aging
/purchases
  /suppliers   /purchase-orders   /grn   /bills   /bills/:id   /debit-notes   /payments   /ap-aging
/inventory
  /products   /warehouses   /stock   /transfers   /adjustments   /valuation
/banking
  /accounts   /transactions   /reconciliation   /rules
/assets
  /register   /depreciation   /disposal   /reports
/payroll
  /employees   /runs   /statutory (EPF/SOCSO/EIS/PCB)
/reports
  /profit-loss   /balance-sheet   /cash-flow   /trial-balance   /general-ledger
  /ar-aging   /ap-aging   /tax   /budget   /builder (§36)
/projects   /multi-currency   /companies (§24)
/documents (§25)   /notifications (§29)   /ai (§38)
/admin
  /users   /roles   /settings   /audit-log
```

## Component hierarchy (shared)

- `AppShell` → `Sidebar`, `Topbar`, `CommandPalette`, content `<main>`.
- **Data primitives:** `DataTable` (search, filter, sort, column resize/hide, saved views, bulk actions, pagination, keyboard nav, export — §47), `DetailPage` (header + tabs Overview/Transactions/Payments/Documents/Activity/Audit + context sidebar — §48), `StatusBadge` (§49), `KpiTile`, `Chart` (Recharts), `MoneyInput`, `AccountPicker`, `DatePeriodPicker`, `AttachmentPanel`, `ApprovalTimeline`.
- **Forms:** React Hook Form + Zod (client) mirroring server validation ([09](09-status-validation-errors.md)).

## State management

- **Server state:** TanStack Query (fetch/cache/invalidate) against the REST API — the single source of truth.
- **Client/UI state:** React state + lightweight store (Zustand) for palette, theme, sidebar, saved-view selection.
- **No global mutable accounting state** in the client; the API owns all writes.

## Command palette (§45) — ⌘/Ctrl + K

Commands: Create invoice · Create journal · Record payment · Add customer · Reconcile bank ·
View P&L · View Trial Balance · Export report · Open settings · jump-to-record (global search).

## Keyboard shortcuts (§46)

`N` new transaction · `I` invoice · `P` payment · `J` journal · `/` search · `K` command palette ·
`G then D` dashboard · `G then S` sales · `G then P` purchases.

## Design system (§44)

Modern, minimal, premium, professional, dense-when-needed, high readability, **light + dark**,
responsive, accessible (WCAG AA). Built on Tailwind + shadcn/ui with brand tokens defined in
`apps/web/tailwind.config.ts`. High-fidelity visual design is produced in Phase 0 before Phase-1 screens are built.
