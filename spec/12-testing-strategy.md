# 12 — Testing Strategy (§60)

Two tracks: **software tests** (does the code work) and **accounting invariant tests** (are the
books correct). The second is what makes an accounting system trustworthy.

## Software tests

| Level | Tooling | Scope |
|---|---|---|
| Unit | Jest / Vitest | posting-rule functions, validators (`@zycount/shared` Zod), pure logic |
| Integration | Jest + test Postgres (Testcontainers) | API endpoints against a real DB, transactions, permissions |
| End-to-end | Playwright | critical user journeys (login, create+post invoice, reconcile, close month) |
| Security | automated + manual | authz on every route, injection, XSS/CSRF, rate limits |
| Performance | k6 / autocannon | dashboard, search, reports against seeded large dataset |

## Accounting invariant tests (§60) — must always pass

Written as executable assertions, runnable on any company's data:

1. **Debit = Credit** on every posted journal.
2. **Trial balance balances:** `Σ debits = Σ credits` across the GL.
3. **Accounting equation:** `Assets = Liabilities + Equity`.
4. **Invoice → AR → GL → statements** ties out (a posted invoice increases AR and revenue by the right amounts and appears in P&L/BS).
5. **Bill → AP → GL → statements** ties out.
6. **Payment allocation** never exceeds the document balance; AR/AP reduce correctly.
7. **Depreciation** over an asset's life sums to depreciable cost, never below residual.
8. **FX:** realised/unrealised gain/loss computed correctly; revaluation reverses cleanly.
9. **Payroll:** gross = net + all statutory deductions; employer contributions posted; payable accounts reconcile.
10. **Tax:** output − input = net tax; tax report equals GL tax accounts.
11. **Period locking:** posting into a CLOSED period is rejected; reopening is audited.
12. **Reversal:** a reversed entry + its reversal net to zero and leave the GL balanced.

These become a regression suite: any change that breaks an invariant fails CI.

## Test data & environments

- Deterministic factories build companies, COA, and transactions for integration tests.
- A "large" seeded dataset (≈1M journal lines) backs performance tests against the [§57 targets](14-nonfunctional.md).
- CI runs unit + integration + invariants on every PR; e2e + performance on a schedule / pre-release.

## Coverage policy

Accounting engine, posting rules, and money math require **high coverage and mutation testing**;
UI presentational code is covered by e2e journeys rather than exhaustive unit tests.
