# 03 — Data Dictionary

Column-level definition of the schema. **Phase 1 is fully specified** (and implemented in
[`schema.prisma`](../../packages/db/prisma/schema.prisma)); **Phase 2** commercial tables are
specified here; later-phase tables are outlined and completed as each phase begins.

**Conventions**

- PK `id` is `UUID` unless noted. `createdAt`/`updatedAt` are `TIMESTAMPTZ`.
- Money is `DECIMAL(18,2)` in company base currency.
- Every company-scoped table has `companyId UUID FK → Company`, indexed.
- `⚡` marks an index; `🔑` a foreign key; `∙U` a unique constraint.

---

## Phase 1 — Core accounting

### Organization
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| name | TEXT | |
| createdAt / updatedAt | TIMESTAMPTZ | |

### Company
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| organizationId | UUID | 🔑 Organization ⚡ |
| name | TEXT | |
| registrationNo | TEXT? | company registration number |
| baseCurrency | CHAR(3) | default `MYR` |
| address | TEXT? | |

### Branch
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| companyId | UUID | 🔑 Company ⚡ |
| code | TEXT | ∙U (companyId, code) |
| name | TEXT | |

### User
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| organizationId | UUID | 🔑 ⚡ |
| email | TEXT | ∙U |
| passwordHash | TEXT | Argon2id |
| name | TEXT | |
| isActive | BOOL | default true |
| mfaEnabled | BOOL | default false |

### Role / Permission / UserRole / RolePermission
| Table | Columns |
|---|---|
| Role | id, name ∙U, description? |
| Permission | id, code ∙U (e.g. `journal.post`) |
| UserRole | (userId 🔑, roleId 🔑) composite PK |
| RolePermission | (roleId 🔑, permissionId 🔑) composite PK |

### Account (Chart of Accounts)
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| companyId | UUID | 🔑 ⚡(companyId, type) |
| code | TEXT | ∙U (companyId, code) e.g. `1300` |
| name | TEXT | |
| type | ENUM | ASSET / LIABILITY / EQUITY / REVENUE / EXPENSE / COST_OF_SALES |
| parentId | UUID? | 🔑 self (tree) |
| isPostable | BOOL | only leaf accounts accept postings |
| isActive | BOOL | |

### FiscalPeriod
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| companyId | UUID | 🔑 ⚡(companyId, status) |
| name | TEXT | "January 2026" |
| startDate / endDate | DATE | ∙U (companyId, startDate, endDate) |
| status | ENUM | OPEN / CLOSED |
| closedAt | TIMESTAMPTZ? | |
| closedBy | UUID? | |

### JournalEntry
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| companyId | UUID | 🔑 ⚡(companyId, date), ⚡(companyId, status) |
| fiscalPeriodId | UUID | 🔑 |
| reference | TEXT | ∙U (companyId, reference) e.g. `JV-2026-000001` |
| date | DATE | |
| description | TEXT? | |
| status | ENUM | DRAFT / POSTED / REVERSED |
| source | ENUM | MANUAL / INVOICE / BILL / PAYMENT / PAYROLL / ASSET / INVENTORY / BANK / SYSTEM |
| sourceId | UUID? | ⚡(source, sourceId) — link to originating document |
| reversalOfId | UUID? | ∙U 🔑 self — the entry this reverses |
| postedAt / postedBy | TIMESTAMPTZ? / UUID? | |

### JournalLine
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| journalEntryId | UUID | 🔑 ⚡ (ON DELETE CASCADE for drafts only) |
| accountId | UUID | 🔑 ⚡ |
| debit | DECIMAL(18,2) | default 0 |
| credit | DECIMAL(18,2) | default 0 |
| description | TEXT? | |
| lineNo | INT | ordering |

*Constraint:* per line, exactly one of `debit`/`credit` is non-zero; per entry, `Σdebit = Σcredit`.

### AuditLog
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| userId | UUID? | 🔑 |
| action | TEXT | `journal.post`, `period.close`, … |
| entityType / entityId | TEXT / TEXT? | ⚡(entityType, entityId) |
| metadata | JSONB? | before/after snapshot |
| ipAddress | TEXT? | |
| createdAt | TIMESTAMPTZ | ⚡ |

---

## Phase 2 — Commercial (specified)

### Customer / Supplier (master data)
Shared shape: `id, companyId 🔑, code ∙U, name, billingAddress?, shippingAddress?, contactPerson?,
email?, phone?, creditLimit DECIMAL, paymentTermsDays INT, currency CHAR(3), taxNo?, bankDetails JSONB?, isActive`.

### Invoice
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| companyId | UUID | 🔑 ⚡ |
| customerId | UUID | 🔑 ⚡ |
| number | TEXT | ∙U (companyId, number) `INV-2026-000001` |
| issueDate / dueDate | DATE | ⚡(companyId, dueDate) for aging |
| status | ENUM | DRAFT/PENDING/APPROVED/POSTED/PARTIALLY_PAID/PAID/OVERDUE/CANCELLED |
| currency | CHAR(3) | + exchangeRate DECIMAL (Phase 4) |
| subtotal / taxTotal / total | DECIMAL(18,2) | |
| amountPaid | DECIMAL(18,2) | |
| journalEntryId | UUID? | 🔑 → GL posting |

### InvoiceLine
`id, invoiceId 🔑 ⚡, productId? 🔑, description, qty DECIMAL, unitPrice DECIMAL, taxCodeId? 🔑, lineTotal DECIMAL, revenueAccountId 🔑`.

### CreditNote / DebitNote
Mirror Invoice/Bill with `type`, optional `originalInvoiceId`/`originalBillId`, and a reversing-natured posting.

### CustomerReceipt / SupplierPayment
`id, companyId 🔑, party 🔑, date, method (CASH/BANK/CARD/…), bankAccountId 🔑, amount DECIMAL, journalEntryId 🔑`.

### PaymentAllocation
Links a receipt/payment to the documents it settles: `id, paymentId 🔑 ⚡, invoiceId?/billId? 🔑, amountApplied DECIMAL`.

### Bill / BillLine
Symmetric to Invoice/InvoiceLine on the AP side, with `supplierId`, `expenseAccountId`, and 3-way-match links (`purchaseOrderId?`, `grnId?`).

### BankAccount / BankTransaction / BankReconciliation / BankRule
- **BankAccount:** `id, companyId 🔑, name, glAccountId 🔑, currency, openingBalance`.
- **BankTransaction:** `id, bankAccountId 🔑 ⚡, date, description, amount (signed), reconciledAt?, journalLineId? 🔑`.
- **BankReconciliation:** `id, bankAccountId 🔑, statementDate, statementBalance, status`.
- **BankRule:** `id, companyId 🔑, matchType, pattern, accountId 🔑, taxCodeId?, priority`.

---

## Phases 3–6 — outlined (completed per phase)

- **Inventory:** Product, Warehouse, BinLocation, InventoryTransaction (movement ledger with cost method FIFO/WA/STD), StockAdjustment, StockTransfer, Batch, SerialNo, plus valuation snapshots.
- **Fixed assets:** Asset (cost, usefulLife, residualValue, method, glAccountId), Depreciation (run per period), AssetDisposal.
- **Payroll:** Employee, Payroll (run), PayrollItem (earning/deduction with statutory type EPF/SOCSO/EIS/PCB), LeaveRecord, AttendanceRecord. Statutory rates live in a versioned `PayrollConfig` (JSONB, effective-dated).
- **Tax:** TaxCode (rate, type SST/exempt/zero), TaxTransaction (input/output tax ledger).
- **Planning:** Budget, BudgetLine (by account × period × dimension).
- **Dimensions:** Department, CostCentre, Project — optional FK tags on JournalLine + documents for segment reporting.
- **Platform:** Attachment (polymorphic entityType/entityId + S3 key + version), Workflow, Approval, Task, Notification, Automation (trigger/condition/action JSONB), ApiKey, Webhook (event, url, secret).

Each of these tables is fully columned in this document at the start of its phase, following the
same conventions, before its code is written.
