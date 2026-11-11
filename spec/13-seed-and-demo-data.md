# 13 — Seed & Demo Data (§51, §52)

## Onboarding wizard (§51)

First login walks the user through, with a progress indicator:

1. Company (profile, registration no., address)
2. Financial year & periods
3. Base currency
4. Chart of accounts (start from a template)
5. Tax settings
6. Bank accounts
7. Customers
8. Suppliers
9. Opening balances

Each step is skippable and resumable; opening balances post a dated opening journal that must balance.

## Demo companies (§52)

Users can explore the whole app without creating records manually. Ship three demo companies:

- **Trading company** — buys/sells stock: inventory, COGS, AR, AP, banking.
- **Service company** — service revenue, expenses, payroll, no inventory.
- **Retail company** — high transaction volume, multiple warehouses, daily sales.

Each demo company includes: a full COA, several open + one closed period, customers/suppliers,
posted invoices/bills/payments, bank transactions to reconcile, fixed assets with depreciation,
a payroll run, and budget figures — enough to exercise every report and dashboard.

## Seed script

`packages/db/prisma/seed.ts` seeds the baseline (roles, permissions, a demo org/company, the
standard MY chart of accounts, an open period). It is **idempotent** (upserts) and expands per phase:

| Phase | Seed adds |
|---|---|
| 1 | roles, permissions, demo company, COA, period, sample journals |
| 2 | customers, suppliers, invoices, bills, payments, bank transactions |
| 3 | products, warehouses, stock movements, assets, expenses |
| 4 | employees, a payroll run, tax codes, budgets, a 2nd-currency company |
| 5 | sample anomalies + receipts for OCR/AI demos |

Run with `pnpm --filter @zycount/db seed`.

## Data reset

A demo company can be reset to its seeded state without touching real companies, so sales demos and
QA start clean.
