# 14 — Non-Functional Requirements (§57–§59)

## Performance targets (§57)

Architecture must scale toward: thousands of users, hundreds of companies, millions of transactions,
millions of journal lines.

| Operation | Target |
|---|---|
| Dashboard | < 2 s |
| Search | < 1 s |
| Invoice page | < 1 s |
| Normal reports | < 3 s |
| Large reports | background job → notify on completion |

**Techniques:** pagination everywhere; correct indexing (see [03](03-data-dictionary.md)); query-result
and reference-data caching in Redis; asynchronous report generation (BullMQ) for large outputs;
pre-aggregated balances per account × period to avoid scanning the full GL for reports; connection pooling.

## Scalability approach

- Modular monolith now; extract heavy modules (reporting, AI, OCR) to services only when needed.
- Postgres as the system of record; read replicas for reporting when volume demands.
- Stateless API instances behind a load balancer; sessions via JWT + Redis, so horizontal scaling is trivial.
- Background workers scale independently of the API.

## Security (§2)

TLS in transit + encryption at rest; RBAC + MFA ([06](06-auth-and-permission-matrix.md)); secure
sessions, password policy, login history, device/IP monitoring; rate limiting; CSRF/XSS/SQL-injection
protection; strict input validation; least-privilege DB accounts; secrets in a manager (not in code);
dependency scanning; audit logs on all privileged actions. A pre-production **security checklist**
gates launch ([16](16-phase-roadmap-and-launch-checklist.md)).

## Backup & disaster recovery (§58)

- **Backups:** daily, weekly, monthly; point-in-time recovery (WAL) for Postgres; object-storage backup for documents.
- **Verification:** backups are automatically verified, and **restore is tested on a schedule** — "a backup is only useful if restoration is tested."
- **DR plan:** documented RPO/RTO, off-region copies, runbook for full restore.

## Offline / resilience — mobile (§59)

`No internet → local save → connection returns → sync`.
Requires: a local queue of pending actions, visible sync status, conflict detection, and conflict
resolution. Accounting writes still go through server validation on sync; conflicts surface to the user
rather than overwriting silently.

## Observability

Structured logging (correlation IDs, the `ERR-…` reference from [09](09-status-validation-errors.md)),
metrics (latency, error rate, queue depth), tracing across API → workers, health checks, and alerting
on error-rate/latency/backup-failure. Every error reference is traceable end to end.
