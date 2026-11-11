# 15 — Repo Structure & DevOps (§55, §56)

## System architecture (§56)

```
        +--------------+
        |  Web (Next)  |
        +------+-------+
               | HTTPS / REST
        +------v-------+
        |  API (Nest)  |  Auth · Business services · Accounting services
        +------+-------+
   +-----------+---------------+---------------+
   v           v               v               v
Postgres     Redis         Object store     Background workers
(system of  (cache +      (documents,       (reports, automation,
 record)     queue)        S3/MinIO)          payroll, OCR — BullMQ)
```

Modular monolith: one deployable API composed of feature modules, plus a worker process for jobs.

## Repository layout

```
zycount/
├─ apps/
│  ├─ web/                 # Next.js (App Router)
│  │  └─ src/{app,components,lib,hooks}
│  └─ api/                 # NestJS
│     └─ src/
│        ├─ modules/       # auth, company, accounts, journals, ledger,
│        │                 #   reports, customers, invoices, … (per phase)
│        ├─ common/        # guards, interceptors, error envelope, permissions
│        └─ workers/       # BullMQ processors
├─ packages/
│  ├─ db/                  # Prisma schema, migrations, seed
│  └─ shared/              # types, Zod schemas, money utils, invariants
├─ docs/spec/              # this specification
├─ infra/                  # docker-compose, deploy manifests
├─ turbo.json  pnpm-workspace.yaml  package.json
```

**Module convention (API):** each feature module has `*.controller.ts`, `*.service.ts`, `*.dto.ts`
(re-exporting `@zycount/shared` Zod schemas), and `*.spec.ts`. Accounting-affecting services depend on a
central `PostingService` that enforces the invariants in [01](01-glossary-and-accounting-principles.md).

## Environments

`local` (Docker Compose) -> `staging` -> `production`. Config via environment variables ([`.env.example`](../../.env.example));
secrets from a manager in staging/production.

## CI/CD

- **CI (every PR):** install -> typecheck -> lint -> unit + integration tests -> **accounting invariant suite** -> build.
- **CD:** on merge to `main`, build images, run `prisma migrate deploy`, deploy API + workers + web; smoke-test `/health`.
- Migrations are **forward-only and reviewed**; destructive changes are gated and backed up first.
- e2e (Playwright) + performance (k6) run pre-release.

## Deployment options (free-friendly -> scale)

- **Start:** a single VPS running Docker Compose (Postgres, Redis, MinIO, API, worker, web) — near-zero cost.
- **Scale:** managed Postgres + Redis, object storage (S3), containers on a platform (Fly.io/Render/Railway/Kubernetes), web on Vercel or the same platform.
- Nothing in the design locks you to a paid vendor.

## Tooling

TypeScript everywhere, ESLint + Prettier, Turborepo caching, Prisma migrations, Husky pre-commit
(lint + typecheck), conventional commits.
