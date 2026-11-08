# Zycount rules

## Project
Double-entry accounting software for Malaysian SMEs.
Repo: GitHub (HAFIZRAMALAN/zycount). Hosting: GitHub Pages now; Cloudflare Workers (static assets) when the
owner decides to move (repo stays on GitHub).

## Architecture (what is actually live)
- Frontend: static HTML/JS in `docs/` — no build step, must keep working on static hosting.
- Backend: Supabase project `qkrikvmkoelusyjjqdkd` — Postgres with row-level security, SECURITY DEFINER SQL
  functions (every one checks `_require_perm`), edge functions in `supabase/functions/`, Vault for keys.
- The accounting engine is the SQL functions. There is ONE engine: the `apps/` monorepo is frozen (README).
- Do not move the backend to another platform (e.g. Cloudflare D1) without a written reason and the owner's OK —
  that would be a second engine, the risk the external reviews flagged.

## Cost
- The project has no funding. Use free tiers only. Ask before anything that costs money
  (paid plans, add-ons, paid APIs, domains).

## Accounting rules
- Double-entry always: every journal must balance (debit = credit) or be rejected.
- Posted journals are immutable. Corrections use reversing entries, never edits.
- Money is never a float: `numeric(18,2)` in the database (exact decimal), integer sen in browser maths
  (`ZL.cents`). Amounts with a fraction of a sen are refused, not rounded.
- Currency MYR by default. SST/tax logic stays separate and configurable (`tax_codes`).
- Money-moving calls go through `idem_call` so a retry never posts twice.

## Code rules
- Small changes, one concern per commit. Explain before big refactors.
- No secrets or real customer data in the repo (the Supabase publishable key is public by design).
- Don't add dependencies without saying why.
- Keep it working on mobile.
- If unsure about an accounting or architecture decision, ask first.
- Every DB change: a migration in `supabase/migrations/` named with its applied version, plus a check in
  `supabase/tests/invariants.sql`. CI must stay green (invariants, backup drill, load test, browser e2e).
- Use one agent; no multi-agent workflows.
- Never touch the other Supabase projects. Never commit `.claude/`.

## Working with the owner
- Reply in short Malay (mixing English is fine).
- Before coding: summarise, list the files to change, flag anything that breaks these rules or won't work on
  the current hosting. Wait for an OK on anything touching accounting logic or architecture.
- After coding: what changed, how to test, any risks.
