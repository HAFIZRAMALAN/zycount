# Zycount — Modern Intelligent Accounting & Business OS

Zycount is a Malaysia-oriented **financial operating system**: every business transaction
automatically produces the correct accounting impact while remaining traceable back to its
source document.

```
SOURCE DOCUMENT -> BUSINESS TRANSACTION -> ACCOUNTING POSTING -> JOURNAL -> GENERAL LEDGER -> FINANCIAL REPORT
```

## What is live today

This repository holds two implementations. Only the first one is deployed.

| | Live product | Reference monorepo |
|---|---|---|
| **Where** | `docs/` (static app) + `supabase/` (Postgres, row-level security, SQL functions, edge functions) | `apps/web` (Next.js) + `apps/api` (NestJS) + `packages/` (Prisma) |
| **Deployed** | GitHub Pages ([pages.yml](.github/workflows/pages.yml)) on Supabase project `qkrikvmkoelusyjjqdkd` | Not deployed — [deploy.yml](.github/workflows/deploy.yml) runs by hand only and fails until a hosting target is configured |
| **Modules working on real books** | Accounts, journals, periods, reports, bank reconciliation and statement import, sales and purchases (quotation → invoice → receipt, bills, payments, credit/debit notes, knock-off, contra, aging, statements), cash book, receipt capture, LHDN MyInvois e-Invoice | Phase 1 core; other screens render sample data |
| **Tested in CI** | `supabase` job — every migration on a fresh database, then [supabase/tests/invariants.sql](supabase/tests/invariants.sql) (accounting invariants, tenant isolation, API-role privileges) | `static` and `accounting-invariants` jobs |

The audit of both is in [audit/2026-10-phase1-audit.md](audit/2026-10-phase1-audit.md).

## Status of the reference monorepo

**Phase 1 — Core Accounting: complete.**

| Area | What works today |
|---|---|
| **Authentication** | Argon2id passwords, TOTP two-factor with single-use recovery codes, rotating refresh tokens with reuse detection, login history, account lockout, rate limiting |
| **Companies** | Multi-company with per-user access scope, company switcher, settings, automatic chart of accounts on creation |
| **Users & RBAC** | 10 roles, 28 permissions, enforced on every route and mirrored in the UI |
| **Chart of accounts** | Full tree with headings and postable leaves, statement groups, archive-not-delete, system accounts protected |
| **Fiscal periods** | Generation by year, close with a month-end checklist, audited reopening |
| **Journals** | Draft → post → reverse, live balance checking, optimistic locking, duplication, gap-free numbering |
| **General ledger** | Every posted line with a running balance, filterable, drilling through to the journal |
| **Reports** | Trial balance, profit & loss, balance sheet — each with period comparison and CSV export |
| **Dashboard** | KPI tiles, revenue/expense/profit and cash charts, business-health panel |
| **Audit** | Append-only trail on every privileged action, filterable, and per-record on the detail pages |

**The rest of the portal — designed and navigable, not yet wired.**

Sales, purchases, inventory, banking, receipt capture, payroll, fixed assets, cash flow, the
insight screens and the finance copilot are all built and reachable from the sidebar. They
render from a sample data set in `apps/web/src/lib/demo` rather than from your books, and every
one of those screens says so, in a banner you cannot miss and a *Preview* mark in the navigation.
Each screen is built against the shape its endpoint will return, so connecting it in its phase is
a change of data source rather than a rewrite.

| Module | Screens | Live in |
|---|---|---|
| **Sales** | Customers, quotations, invoices (list and document), receipts, AR aging | Phase 2 |
| **Purchases** | Suppliers, purchase orders, bills, payments, AP aging | Phase 2–3 |
| **Banking** | Accounts against the ledger, and the reconciliation workbench | Phase 2 |
| **Receipt capture** | Upload, extracted fields with confidence, suggested coding, entry on approval | Phase 3 |
| **Inventory** | Items, stock movements, reorder planner | Phase 3 |
| **Payroll** | Employees, pay runs, EPF/SOCSO/EIS/PCB submissions | Phase 4 |
| **Fixed assets** | Register and the monthly depreciation run | Phase 4 |
| **Insights** | Business health, analytics, cash flow statement | Phase 5 |
| **Copilot** | Ask the ledger a question; every figure cites its record | Phase 6 |

What ties them together is the same chain the engine enforces: every source document shows the
entry it will produce — account by account, debit and credit, proved to balance — *before*
anything posts, and links on to the journal, the ledger and the report once it has.

The [engineering specification](docs/spec/) remains the source of truth; delivery follows the
[phased roadmap](docs/spec/16-phase-roadmap-and-launch-checklist.md).

### The rules the engine guarantees

Enforced in code and asserted by the test suite ([12 — Testing](docs/spec/12-testing-strategy.md)):

1. A journal can only be posted when `Σ debit = Σ credit`, to the cent.
2. A posted entry is never edited or deleted — corrections are reversals that net to zero.
3. Nothing posts into a closed period; reopening is authorised and audited.
4. `Assets = Liabilities + Equity` holds at every date.
5. Every report figure drills down to the ledger, the journal and the audit trail.
6. Money never passes through a floating-point number, anywhere.

## Tech stack

| Layer | Choice |
|---|---|
| Web | Next.js (App Router) + TypeScript + Tailwind + Radix + Recharts |
| API | NestJS + TypeScript |
| Database | PostgreSQL + Prisma ORM |
| Validation | Zod schemas shared by client and server |
| Cache / jobs | Redis + BullMQ *(Phase 2)* |
| Object storage | S3-compatible (MinIO locally) *(Phase 3)* |
| Local infra | Docker Compose |
| Monorepo | pnpm workspaces + Turborepo |

Everything above is open-source and free to run locally or self-host.

## Repository layout

```
zycount/
├─ apps/
│  ├─ web/          # Next.js frontend
│  │  └─ src/{app,components,hooks,lib,providers}
│  └─ api/          # NestJS backend
│     └─ src/{common,modules}
├─ packages/
│  ├─ db/           # Prisma schema, migrations, seed, chart-of-accounts template
│  └─ shared/       # Zod schemas, money maths, accounting invariants, permissions
├─ docs/spec/       # the engineering specification (start here)
├─ infra/           # docker-compose for postgres + redis + minio
└─ .github/workflows/
```

## Getting started

Prerequisites: **Node 20+**, **pnpm 9+**, **Docker** (or a local PostgreSQL 16).

```bash
# 1. install dependencies
pnpm install

# 2. start local infrastructure
docker compose -f infra/docker-compose.yml up -d

# 3. copy the environment file
cp .env.example .env

# 4. build the shared packages, apply the schema and seed the demo data
pnpm --filter @zycount/shared build
pnpm --filter @zycount/db build
pnpm db:migrate
pnpm db:seed

# 5. run web + api
pnpm dev
```

- Web: http://localhost:3000
- API: http://localhost:4000/health

### Demo sign-in

The seed creates three demo companies (trading, services and retail), each with a
121-account Malaysian chart of accounts, twelve fiscal periods with January closed, and
roughly 200 posted journals covering sales, purchases, payroll, overheads, depreciation and
loan servicing.

| Email | Role | Can do |
|---|---|---|
| `admin@zycount.test` | SuperAdmin | Everything |
| `accountant@zycount.test` | Accountant | Manage the COA, post and reverse journals |
| `manager@zycount.test` | FinanceManager | Post, reverse, close and reopen periods |
| `auditor@zycount.test` | Auditor | Read-only, plus the audit log |
| `viewer@zycount.test` | ReadOnly | Reports only |

Password for all of them: `Zycount!Demo2026`

Try signing in as the accountant and then as the auditor — the interface and the API both
change with the role.

## Testing

```bash
pnpm test                          # unit tests (money, invariants, schemas, permissions)
pnpm --filter @zycount/api test:int  # integration + the accounting invariant suite
pnpm typecheck
```

The integration suite boots the real application against a real database and asserts the
invariants above across every seeded company and period. It requires the database to be
migrated and seeded first.

## Documentation

Read the spec in order — [`docs/spec/00-overview.md`](docs/spec/00-overview.md) first.
