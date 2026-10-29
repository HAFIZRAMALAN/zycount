# 08 — Screen Inventory & Wireframes (§43–§48)

Every screen maps to a route in [07](07-frontend-route-map-and-components.md). Below are the
screen inventory and lo-fi (text) wireframes for the key screens. High-fidelity visuals are
produced in the Phase-0 design pass.

## Screen inventory (by module)

- **Auth:** Login, MFA challenge, Forgot/Reset password, Onboarding wizard (§51).
- **Dashboard:** KPI overview, charts, business-health panel (§18, §19), custom dashboard builder (§37).
- **Accounting:** COA tree, Journal list, Journal editor, GL viewer, Trial Balance, Periods, Month-end close center (§31), Year-end close (§32).
- **Sales:** Customer list, Customer 360, Quotation/SO/Invoice/Credit note/Receipt editors + lists, AR aging.
- **Purchases:** Supplier list/360, PR/PO/GRN/Bill/Debit note/Payment editors + lists, AP aging, 3-way match review.
- **Inventory:** Product list/detail, Warehouses, Stock levels, Transfers, Adjustments, Valuation.
- **Banking:** Accounts, Transactions, Reconciliation workspace, Rules.
- **Assets:** Register, Depreciation run, Disposal, Reports.
- **Payroll:** Employees, Payroll run wizard, Payslip, Statutory reports.
- **Reports:** P&L, Balance Sheet, Cash Flow, Trial Balance, GL, AR/AP aging, Tax, Budget vs Actual, Report builder (§36).
- **Platform:** Documents center (§25), Notifications (§29), Task center (§28), AI copilot (§38), Automation builder (§27), Approvals.
- **Admin:** Users, Roles, Settings, Audit log, Companies, Import/Export (§35).
- **Mobile (§43):** Dashboard, Invoice, Expense, Approval, Payment, Receipt scan, Notifications, AI — designed natively, not a shrunk desktop.

## Wireframes (key screens)

### Dashboard (§18)
```
┌ Dashboard ─────────────────────────────────────────────┐
│ [Revenue] [Expenses] [Net Profit] [Cash] [AR] [AP]      │  ← KPI tiles
│ ┌ Revenue trend ─────┐ ┌ Cash flow ───────┐             │
│ │      ／＼           │ │   ▂▄▆█▆▄          │             │
│ └────────────────────┘ └──────────────────┘             │
│ ┌ Business Health ───────────────────────────────────┐  │
│ │ Cash runway 4.2mo · Collection 38d · GM 42% ▲       │  │
│ └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Invoice editor (§5)
```
┌ New Invoice ────────────────────────────  [Save Draft] [Post] │
│ Customer [▼ Acme Sdn Bhd]     Invoice # INV-2026-000001        │
│ Issue [2026-01-15]  Due [2026-02-14]  Currency [MYR]          │
├───────────────────────────────────────────────────────────────┤
│ # │ Item        │ Qty │ Unit Price │ Tax │ Amount               │
│ 1 │ Consulting  │  10 │   100.00   │ SST │ 1,000.00             │
│ + Add line                                                     │
├───────────────────────────────────────────────────────────────┤
│                              Subtotal 1,000.00                 │
│                              Tax        60.00                  │
│                              Total   1,060.00                  │
│ Attachments ▢  Notes ▢                                         │
└───────────────────────────────────────────────────────────────┘
```
On **Post**: preview the resulting Dr/Cr (from [04](04-accounting-posting-rules.md)) before confirming.

### Detail page shell (§48)
```
┌ INV-2026-000001 · Acme Sdn Bhd · RM1,060.00 · [POSTED] · [Actions ▼] ┐
│ [Overview][Transactions][Payments][Documents][Activity][Audit]        │
├───────────────────────────────────────────┬───────────────────────────┤
│  (tab content)                             │ Created by  Ali (§48)      │
│                                            │ Created     2026-01-15     │
│                                            │ Terms       Net 30         │
│                                            │ Currency    MYR            │
│                                            │ Project     —              │
└────────────────────────────────────────────┴───────────────────────────┘
```

### General Ledger (§16)
```
┌ General Ledger · Account [1300 Accounts Receivable ▼] · Period [Jan 2026 ▼] ┐
│ Date       │ Reference        │ Source  │ Debit  │ Credit │ Balance         │
│ 2026-01-15 │ INV-2026-000001  │ Invoice │1,060.00│        │ 1,060.00        │
│ 2026-01-20 │ RCP-2026-000004  │ Payment │        │1,060.00│     0.00        │
│  (click any row → Journal → Source document → Audit trail)                 │
└────────────────────────────────────────────────────────────────────────────┘
```

### Bank reconciliation (§8)
```
┌ Reconciliation · Maybank ····· Statement bal 12,340.00 · Book bal 12,340.00 ✓ ┐
│ Statement lines            │ ⇄ │ Book transactions                            │
│ 2026-01-18  TNB  -320.00   │ ✓ │ 2026-01-18  Utilities  -320.00 (rule matched)│
│ 2026-01-20  DEP +1,060.00  │ ? │ (suggest: RCP-2026-000004)                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Month-end close center (§31)
```
┌ Month-End Close · January 2026 · 90% complete ───────────────┐
│ ☑ Bank reconciliation   ☑ AR recon   ☑ AP recon              │
│ ☑ Inventory recon       ☑ Depreciation   ☐ Accruals          │
│ ☑ Prepayments           ☐ Tax reconciliation                 │
│ ⚠ 2 unresolved items must be cleared before closing.  [Close]│
└──────────────────────────────────────────────────────────────┘
```
