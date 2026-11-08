# Backups and restore

Free daily backups of the live books — no paid Supabase plan needed.

| File | What it does |
|---|---|
| [`../../.github/workflows/backup.yml`](../../.github/workflows/backup.yml) | Every day 03:00 MYT (and on demand): dump → restore drill → encrypt → keep 90 days |
| [`dump.sh`](dump.sh) | `pg_dump` of `public`, `auth`, `storage`, `supabase_migrations` + row counts (+ uploaded files when the service key is set) |
| [`restore-check.sh`](restore-check.sh) | Loads a dump into a brand-new database and runs [`verify.sql`](verify.sql) and the row-count comparison |
| [`verify.sql`](verify.sql) | Every posted journal balances, the ledger balances, no line lost its entry or account, every company has a member who can sign in |
| [`backup-public-key.asc`](backup-public-key.asc) | Public key the backups are encrypted to. Safe to publish. |

The same scripts run on every pull request (CI `supabase` job), so the restore procedure is proved continuously,
not once.

## One-time set-up (owner)

1. **Database connection.** Supabase dashboard → *Connect* → **Session pooler** → copy the URI
   (`postgresql://postgres.qkrikvmkoelusyjjqdkd:[YOUR-PASSWORD]@aws-…pooler.supabase.com:5432/postgres`) and put
   the database password in it. (Forgot it? *Project Settings → Database → Reset database password*.)
2. GitHub → repository *Settings → Secrets and variables → Actions → New repository secret*:
   - `SUPABASE_DB_URL` = that URI (**required**)
   - `SUPABASE_SERVICE_ROLE_KEY` = *Project Settings → API keys → service_role* (**optional** — also backs up the
     uploaded receipts and bills)
3. *Actions → Daily backup → Run workflow* once. It should end green with an artifact
   `zycount-backup-YYYYMMDD-HHMM`.
4. **The private key** — `ZYCOUNT-BACKUP-PRIVATE-KEY.asc` was created on the owner's computer, outside the
   repository. Keep two copies somewhere only you control (USB drive + your own cloud drive). **Never commit it or
   paste it into GitHub.** Without it the backups cannot be opened; with it, anyone can.

Logs and artifacts of a public repository are public. The workflow prints counts only, and the artifact is
encrypted, so neither shows any data.

## Restore (disaster recovery)

```bash
# 1. Download the artifact from Actions → Daily backup → (a run) → Artifacts, unzip it.
gpg --import ZYCOUNT-BACKUP-PRIVATE-KEY.asc
gpg --output backup.tar --decrypt zycount-backup-YYYYMMDD-HHMM.tar.gpg
mkdir backup && tar -xf backup.tar -C backup        # zycount.dump, counts.tsv, manifest.txt, files/

# 2. Into a NEW Supabase project (Connect → Session pooler URI of the new project):
pg_restore --dbname "$NEW_DB_URL" --no-owner --no-privileges --schema=public --schema=storage backup/zycount.dump
#    auth.users comes back with: pg_restore --data-only --schema=auth --table=users --table=identities …

# 3. Prove it, on the new project:
psql "$NEW_DB_URL" -f supabase/backup/verify.sql      # must end with RESTORE VERIFIED
```

Then point the app at the new project (`SUPABASE_URL` / key in `docs/js/zy-live.js` and `docs/login.html`), redeploy
the edge functions, and re-enter the API keys in *Admin console → Keys & payments* — Vault secrets are encrypted
with the old project's key and are deliberately not in the backup. Uploaded files are in `files/<bucket>/…`;
upload them back to the `attachments` bucket at the same paths.
