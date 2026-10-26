# Zycount — Phase 1 engineering audit and hardening

**Date:** 24 October 2026  
**Scope:** repository `gostatementnssitsolution/zycount` at `c689cb1` (main), the hosted Supabase project `qkrikvmkoelusyjjqdkd`, and the GitHub Actions workflows.  
**Method:** read-only inspection first, then live probes inside rolled-back transactions (no production data was changed), then small fixes, each with a regression test where one could be written.

---

## 1. What is actually in the repository

The external evaluation (*ZCOUNT NEED TO STUDY*) treated the repository as one product: Next.js + NestJS + Prisma, Phase 1 complete, other modules on sample data. In fact the repository holds **two implementations**:

| | Live product | Reference monorepo |
|---|---|---|
| Code | `docs/` static app, `supabase/` migrations, SQL functions and edge functions | `apps/web`, `apps/api`, `packages/*` |
| Runs at | GitHub Pages + Supabase `qkrikvmkoelusyjjqdkd` | Nowhere — no hosting target is configured |
| Modules on real books | Core ledger, periods, reports, bank reconciliation, statement import, sales and purchases (quotation → invoice → receipt, bills, payments, CN/DN, knock-off, contra, aging, statements), cash book, receipt capture, LHDN MyInvois | Phase 1 core; other screens on `apps/web/src/lib/demo` |

The README only described the reference monorepo, so the evaluation's main limitation ("Phase 2 modules not wired") is **out of date for the live product**. The README now says which code is live (finding M11).

Both implementations were audited. Findings are tagged **[live]** or **[monorepo]**.

---

## 2. Findings

Severity: **Critical** — books or data can be corrupted or exposed now. **High** — exploitable or misleading in a way that matters before a pilot. **Medium** — weakens a control or blocks safe operation. **Low** — hygiene.

Status: **Fixed** (change made and verified), **Fixed — unverified** (change made; its test runs in CI on the pull request), **Open** (plan in §4).

No Critical defects were found.

### High

| ID | Finding | Evidence | Status |
|---|---|---|---|
| H1 [monorepo] | **Refresh-token rotation race.** `rotateRefreshToken` read the token, checked `revokedAt`, issued a successor, then revoked the old one. Two concurrent requests with the same token both passed the check and both received a valid successor, and reuse detection never fired. A stolen refresh token used at the same moment as the real one would fork the session. | `apps/api/src/modules/auth/token.service.ts` `rotateRefreshToken` | Fixed — unverified. The token is now claimed with a conditional `updateMany(... revokedAt: null)` **before** a successor is issued; a losing request is treated as a replay and revokes the family. Regression tests: *refuses a replayed refresh token and ends the whole family*, *lets only one of two simultaneous refreshes with the same token through*. |
| H2 [both] | **Deploy workflow reported success without deploying.** On every push to `main`, `Deploy` skipped migrations when `DATABASE_URL` was empty (`exit 0`), ran `echo "Configure the deployment target"` as the deploy step, and skipped the health check — a green "Deploy" for a release that never happened. | `.github/workflows/deploy.yml` (runs 39219097218 and earlier all "success") | Fixed. Deploy now runs only by hand, fails first if `DATABASE_URL`, `HEALTH_URL` or `DEPLOY_HOOK_URL` is missing, calls the deploy hook, and fails if the health check never passes. |
| H3 [live] | **Public sign-up creates already-confirmed accounts, and its rate limit was per function instance.** The `signup` edge function (no JWT, by design) calls `auth.admin.createUser({ email_confirm: true })`, so no one proves they own the email address. The 5-per-hour limit lived in one instance's memory, so a script could create accounts and books without limit. | `supabase/functions/signup/index.ts` | **Partly fixed.** The limit is now in the database (`_signup_allowed`: 5 an hour per hashed address, 60 an hour overall), deployed as function v4 and tested. **Open:** email confirmation needs custom SMTP first (Supabase's built-in mailer allows only a few emails an hour). |
| H4 [monorepo] | **The demo seed had no production guard.** `pnpm --filter @zycount/db seed` against any `DATABASE_URL` creates `admin@zycount.test` (SuperAdmin) with the password published in the README. | `packages/db/prisma/seed.ts` `main` | Fixed. `assertDemoTarget()` refuses when `NODE_ENV=production`, or when the host is not local unless `ZYCOUNT_ALLOW_DEMO_SEED=1`. CI (localhost) is unaffected. |

### Medium

| ID | Finding | Evidence | Status |
|---|---|---|---|
| M1 [monorepo] | **Second-factor guesses were not counted.** Wrong TOTP or recovery codes were logged but never added to the lockout count. A correct password also reset the count *before* the second factor, so anyone holding the password could reset the lockout between guesses. The failure counter was read-modify-write, so parallel failures under-counted. | `apps/api/src/modules/auth/auth.service.ts` `login`, `verifyMfa`, `registerFailedAttempt` | Fixed — unverified. MFA failures now count toward the same lockout, and a locked account is refused at the MFA step. For MFA accounts the counter is cleared only after the second factor passes. The increment is atomic (`{ increment: 1 }`). |
| M2 [monorepo] | **Recovery codes could be spent twice.** The used code was removed with a read-modify-write, so two simultaneous requests with the same code both succeeded. | same file, `verifyMfa` | Fixed — unverified. Conditional `updateMany` on the unchanged list; the losing request is refused. No regression test yet: the harness has no MFA-enrolled user (gap G3). |
| M3 [live] | **API roles held write privileges on every table.** `anon` and `authenticated` kept Supabase's default INSERT/UPDATE/DELETE/**TRUNCATE**/TRIGGER/REFERENCES on all 30 public tables. Row-level security blocked the row writes (verified), but TRUNCATE is not subject to row-level security. PostgREST does not expose TRUNCATE today, but one exposure path would empty the books. | `has_table_privilege('authenticated','public.journal_lines','TRUNCATE')` returned `true` | Fixed. Migration `20261024082748_hardening.sql` revokes those privileges (profiles keeps its `full_name` column grant) and changes default privileges so future tables start without them. Verified: app paths still work as `authenticated`; TRUNCATE and direct INSERT are refused. |
| M4 [live] | **Migration history drift.** The repository's migration files were numbered `…000100`–`…002100`, while the database recorded each one under the timestamp it was applied with. `supabase db push` or `migration list` would have seen 21 unapplied migrations and tried to re-run them. | `supabase/migrations/*` vs `supabase_migrations.schema_migrations` | Fixed. Files renamed to their applied versions; names and order unchanged. |
| M5 [live] | **No automated tests for the live backend.** CI tested only the monorepo. Nothing checked that the live migrations apply cleanly, that the ledger stays balanced, or that one company cannot reach another. | `.github/workflows/ci.yml` | Fixed — unverified in CI. New `supabase` job: every migration on a fresh local Supabase, then `supabase/tests/invariants.sql` (36 checks). **The same suite passed against the hosted database** in a rolled-back transaction. |
| M6 [live] | **No idempotency on money-moving calls.** `record_transaction`, `save_trade_doc(p_post)`, `record_cash_entry` and `post_contra` have no idempotency key. A double submit (two tabs, or a retry after a timeout) creates two entries. Partial guards exist: a supplier invoice reference cannot be recorded twice, a bank line settles once, and every call is one transaction, so partial failure leaves nothing behind. | functions listed | Open (§4, R3). |
| M7 [live] | **Leaked-password protection is off** in Supabase Auth. | Supabase security advisor `auth_leaked_password_protection` | Open — a dashboard switch for the owner (§4, R1). |
| M8 [live] | **No backup or restore procedure.** The project is on the free plan: no point-in-time recovery, and no documented export. | project settings | Open (§4, R2). |
| M9 [monorepo] | **TOTP secrets are stored in clear text** (`User.mfaSecret`). A database leak exposes every second factor. | `apps/api/src/modules/auth/auth.service.ts` `mfa/enrol` | Open — encrypt at rest before the monorepo is deployed. |
| M10 [monorepo] | **Access tokens carry permissions and company list for 15 minutes.** Removing a role or company access takes effect only when the token expires. (The live product checks membership on every call, so revocation there is immediate.) | `token.service.ts` `signAccessToken`; claims built in `completeLogin` | Open — re-check membership on company-scoped routes, or revoke sessions on role change. |
| M11 [both] | **README misdescribed the product,** which led the external evaluation to report Phase 2 as missing. | `README.md` | Fixed — new "What is live today" section. |

### Low

| ID | Finding | Status |
|---|---|---|
| L1 [live] | `save_journal` silently rounds sub-cent amounts (0.005 → 0.01) instead of refusing them. Both sides round the same way, so the books stay balanced. | Open |
| L2 [live] | `signup` answers 409 for an existing email, which reveals that an address is registered. This is a deliberate trade-off for UX. | Open — accept, or return one generic answer once email confirmation is on |
| L3 [monorepo] | The test named *rotates the refresh token and refuses a replayed one* never presented a replayed token. | Fixed — split into a real rotation test and a real replay test |
| L4 [live] | Supabase advisor lists 87 SECURITY DEFINER functions executable by `authenticated`. This is by design: each one checks the caller's permission (`_require_perm`). Sampled 9 of them cross-tenant; all refused. | Accepted |
| L5 [live] | MyInvois e-Invoice is unproven against the real LHDN sandbox (no credentials yet) and sends document v1.0 without a digital signature. LHDN still accepts v1.0 until it announces retirement. | Open (§4, R5) |

---

## 3. Verified as correct (live product)

Every row below was **executed** against the hosted database inside a rolled-back transaction, and is now encoded in `supabase/tests/invariants.sql` unless marked †.

| Control | Result |
|---|---|
| A journal posts only when Σ debit = Σ credit to the cent (100.00 vs 99.99 refused) | ✔ |
| 0.1 + 0.2 posts as exactly 0.3 (`numeric(18,2)` throughout) | ✔ |
| Posted journals cannot be edited or deleted — by RPC **and** by direct SQL as table owner (triggers `_guard_journal_entry`, `_guard_journal_line`)† | ✔ |
| A journal cannot be reversed twice | ✔ |
| No posting into a closed period, or a date with no period | ✔ |
| Gap-free numbering under concurrency: `_series_next` increments with `INSERT … ON CONFLICT DO UPDATE` (row-locked, rolled back with the transaction); posting locks the draft `FOR UPDATE`† | ✔ by design; not stress-tested |
| All companies: trial balance balances, 0 unbalanced entries, 0 numbering gaps, subledger = control accounts† | ✔ |
| Invoice → contra → bank receipt knocks off to zero; duplicate supplier invoice refused | ✔ |
| Tenant isolation: a user of company B refused on 9 of company A's functions (reports, ledger, proof, journal, transaction, invite, e-Invoice settings, open documents, void); row-level security shows B none of A's rows | ✔ |
| `anon` sees no rows and cannot call `my_companies`/`has_perm` | ✔ |
| e-Invoice secrets: `einvoice_settings`, `einvoice_tokens`, `vault`, `_einvoice_credentials` all refused to `authenticated` | ✔ |
| After hardening: TRUNCATE / direct INSERT refused; `record_transaction`, `save_contact`, profile rename still work | ✔ |

---

## 4. Remediation plan

| # | Action | Owner | Acceptance criteria |
|---|---|---|---|
| R1 | Turn on leaked-password protection | Owner (Supabase → Auth → Providers → Email) | Advisor `auth_leaked_password_protection` clears |
| R2 | Backups: upgrade to a plan with daily backups/PITR, **or** run a scheduled `pg_dump` to private storage; restore once into a scratch project | Owner + engineering | A restore drill is documented, with its date and row counts |
| R3 | Idempotency: optional `p_request_id uuid` on money-moving RPCs, backed by a unique `(company_id, request_id)` table; the browser sends one per form open | Engineering | Calling twice with the same id returns the first result; a new test in `invariants.sql` |
| R4 | Custom SMTP, then `email_confirm: false` in `signup` plus a confirm page | Owner (SMTP credentials) + engineering | A new account cannot sign in until it confirms; existing accounts are unaffected |
| R5 | Live MyInvois sandbox run with the owner's own credentials: one invoice, one credit note, one cancellation | Owner + engineering | Three documents validated in preprod; any LHDN rule errors fixed |
| R6 | Monorepo before any deployment: encrypt TOTP secrets (M9), re-check membership per request or revoke on role change (M10), MFA e2e fixture (G3) | Engineering | Tests for each; deploy.yml configured with real secrets |
| R7 | Browser end-to-end test of the live app's main flow (sign in → invoice → receive → reconcile → reports) in CI | Engineering | Playwright job green on every PR |
| R8 | Load test: 50 concurrent users posting for 10 minutes against a staging Supabase project | Engineering | p95 RPC < 500 ms; 0 numbering gaps; 0 unbalanced entries |

---

## 5. Test coverage

**What exists and what it proves**

- `apps/api` unit tests (39): error envelope, guards, utilities. They pass locally and in CI.
- `apps/api` integration (`test:int`): auth and permissions, accounting invariants on seeded demo data. These run in CI against Postgres. They cover **only the monorepo**.
- `supabase/tests/invariants.sql` (new, 36 checks): the live backend's accounting invariants, document flows, tenant isolation and privileges.

**Gaps**

| ID | Gap |
|---|---|
| G1 | No browser end-to-end test of the live app (R7). Its UI is checked by hand against a local stub harness. |
| G2 | No stress test of concurrent posting (R8). Concurrency safety is by design and was not measured. |
| G3 | No MFA-enrolled fixture in the monorepo e2e harness, so M1 and M2 have no regression test. |
| G4 | Edge functions (`signup`, `scan-document`, `myinvois`) have no automated tests. Each was exercised by hand. |
| G5 | Report reconciliation (P&L result = balance-sheet current-year earnings, period by period) is checked through `books_proof` totals, not per period. |

---

## 6. Changes made

| File | Change |
|---|---|
| `apps/api/src/modules/auth/token.service.ts` | Atomic claim of the refresh token before rotation (H1) |
| `apps/api/src/modules/auth/auth.service.ts` | MFA failures count toward lockout; atomic counter; single-spend recovery codes (M1, M2) |
| `apps/api/test/auth-and-permissions.e2e-spec.ts` | Real replay test and a concurrent-refresh test (H1, L3) |
| `packages/db/prisma/seed.ts` | Refuses to seed demo users into a non-local or production database (H4) |
| `.github/workflows/deploy.yml` | Manual only; fails when not configured; real deploy hook and health check (H2) |
| `.github/workflows/ci.yml` | New `supabase` job (M5) |
| `supabase/config.toml`, `supabase/tests/invariants.sql` | Local Supabase for CI; the invariant suite (M5) |
| `supabase/migrations/*` | Renamed to their applied versions (M4); new `20261024082748_hardening.sql` (M3, H3), **applied to the hosted project** |
| `supabase/functions/signup/index.ts` | Database-backed throttle (H3), **deployed as v4** |
| `README.md` | What is live (M11) |

## 7. Tests executed / not executed

**Executed**

- Live, rolled back:
  - accounting probes (12)
  - tenant-isolation probes (19)
  - privilege inventory of all 30 tables
  - post-hardening smoke test
  - the full `invariants.sql` suite — **36/36 passed**
- `_signup_allowed`: 5 allowed, the 6th refused, a malformed hash refused.
- `signup` v4 with an invalid body returned 400.
- `apps/api`: `tsc --noEmit` clean, `eslint` clean, unit tests 39/39 passed.

**Not executed locally** (no Docker or Postgres on this machine; they run in CI on the pull request)

- `apps/api` integration suite, including the three new and changed refresh-token tests
- the new `supabase` CI job

**Not executed at all**

- load test (R8)
- penetration test
- browser end-to-end test (R7)
- MFA regression tests (G3)
- live MyInvois sandbox (R5)

---

## 8. Go / no-go

**Live product (docs + Supabase): GO for a controlled pilot** — a small number of known businesses, invited by you, with bookkeeping you can check. The accounting engine's invariants, period locks, immutability and tenant isolation were each verified against the live database, not inferred from code.

Conditions, before the first pilot user:

1. R1 — leaked-password protection on (5 minutes).
2. R2 — a backup you have restored once.
3. The `supabase` CI job green on this pull request.

Before **open public sign-up**: R3 (idempotency) and R4 (email confirmation).

**Reference monorepo (apps/): NO-GO for production as it stands.** It is not deployed, which is correct. Do not deploy it until R6 is done and H1/M1/M2 are confirmed by the CI integration suite.
