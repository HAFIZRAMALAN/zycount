# 04 — Accounting Posting Rules

The posting matrix: for each business transaction, the exact debits and credits the engine
produces. Every rule references accounts that exist in the COA ([03](03-data-dictionary.md)).
All entries must balance (`Σ Dr = Σ Cr`).

Notation: `Dr` = debit, `Cr` = credit. Amounts in base currency.

## Sales / AR

**Sales invoice** (§3, §5)
```
Dr Accounts Receivable      total (incl. tax)
   Cr Sales Revenue             net amount
   Cr Tax Payable (output)      tax amount
```

**Customer receipt** (payment against invoice)
```
Dr Bank                     amount received
   Cr Accounts Receivable       amount received
```

**Credit note** (sales return / reduction)
```
Dr Sales Revenue            net
Dr Tax Payable              tax
   Cr Accounts Receivable       total
```

**Bad debt write-off**
```
Dr Bad Debt Expense         amount
   Cr Accounts Receivable       amount
```

## Purchasing / AP

**Supplier bill** (§6)
```
Dr Expense / Inventory / Asset   net amount
Dr Tax Receivable (input)        tax amount
   Cr Accounts Payable               total
```

**Supplier payment**
```
Dr Accounts Payable         amount paid
   Cr Bank                       amount paid
```

**Debit note** (purchase return): reverse of the bill for the returned portion.

## Inventory (§7)

**Goods receipt (GRN) — perpetual**
```
Dr Inventory                cost of goods received
   Cr GRNI (Goods Received Not Invoiced)   cost
```
On bill matching, `Dr GRNI / Cr AP`.

**Cost of sales on shipment** (FIFO / weighted-average / standard)
```
Dr Cost of Sales            cost of goods sold
   Cr Inventory                  cost of goods sold
```

**Stock adjustment / write-down**
```
Dr Inventory Adjustment (expense)   loss  | Cr for a gain
   Cr Inventory                          loss
```

## Banking (§8)

**Bank transfer** between own accounts
```
Dr Bank (destination)       amount
   Cr Bank (source)             amount
```
**Bank charges:** `Dr Bank Charges / Cr Bank`. **Interest income:** `Dr Bank / Cr Interest Income`.

## Fixed assets (§10)

**Acquisition:** `Dr Fixed Asset / Cr Bank or AP`.
**Depreciation** (per period, straight-line / reducing-balance / units)
```
Dr Depreciation Expense     period depreciation
   Cr Accumulated Depreciation  period depreciation
```
**Disposal**
```
Dr Bank                         proceeds
Dr Accumulated Depreciation     accumulated
   Cr Fixed Asset                    original cost
   Cr Gain on Disposal   (or Dr Loss on Disposal)   balancing
```

## Expenses (§11)

**Expense claim → payment**
```
Dr Expense (category)       net
Dr Tax Receivable           tax (if claimable)
   Cr Employee Payable / Bank    total
```

## Accruals & prepayments (§12)

**Accrual:** `Dr Expense / Cr Accrued Expense`. Reverses next period or on actual bill.
**Prepayment:** `Dr Prepaid Expense / Cr Bank`; monthly recognition `Dr Expense / Cr Prepaid Expense`.

## Loans (§13)

**Drawdown:** `Dr Bank / Cr Loan Payable`.
**Instalment:**
```
Dr Loan Payable             principal portion
Dr Interest Expense         interest portion
   Cr Bank                       instalment amount
```

## Payroll (§14, Malaysia)

**Payroll run posting**
```
Dr Salary Expense           gross salary + employer contributions
   Cr EPF Payable               employee + employer EPF
   Cr SOCSO Payable             employee + employer SOCSO
   Cr EIS Payable               employee + employer EIS
   Cr PCB Payable               PCB/MTD withheld
   Cr Bank                       net pay to employees
```
Statutory amounts come from the effective-dated `PayrollConfig`; remittances later `Dr *Payable / Cr Bank`.

## Tax (§15)

**Period tax settlement (SST):** net output vs input tax
```
Dr Tax Payable (output)     output tax collected
   Cr Tax Receivable (input)    input tax paid
   Cr Bank                       net tax remitted   (or Dr Bank for a refund)
```

## Multi-currency (§23)

**Realised FX gain/loss** on settlement (invoice rate vs payment rate)
```
Dr/Cr FX Gain/Loss          difference
```
**Unrealised FX (period-end revaluation):** revalue open foreign balances at closing rate,
`Dr/Cr Unrealised FX Gain/Loss / Cr/Dr the monetary account`; typically reversed at next period start.

## Year-end close (§32)

Close revenue & expense to P&L, then to Retained Earnings:
```
Dr Revenue accounts        balances
   Cr Income Summary            total revenue
Dr Income Summary           total expenses
   Cr Expense accounts          balances
Dr/Cr Income Summary        net result
   Cr/Dr Retained Earnings      net profit / loss
```

## Rule engine notes

- Posting rules are **data-driven** where possible: a document type maps to a template that resolves
  account IDs from company configuration (e.g. a customer's revenue account, a product's inventory account).
- Every generated `JournalEntry` sets `source` + `sourceId` for traceability.
- If a rule cannot resolve a required account, the transaction is **blocked with a clear error**
  (see [09](09-status-validation-errors.md)) — never posted to a fallback.
