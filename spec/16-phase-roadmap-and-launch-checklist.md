# 16 — Phase Roadmap & Launch Checklist (§61, §64)

## Roadmap (§61)

### Phase 0 — Foundation *(current)*
Requirements, UX, database, architecture, accounting rules, design system.
**Delivers:** this spec + runnable monorepo skeleton.
**Exit:** spec reviewed; skeleton boots (`docker compose up`, `pnpm dev`, `prisma migrate`); design tokens set.

### Phase 1 — Core accounting
Authentication, Company, Users/RBAC, COA, Journal, GL, Trial Balance, P&L, Balance Sheet.
**Exit:** a user can set up a company, define a COA, post balanced journals, and pull a Trial Balance,
P&L, and Balance Sheet that tie out — all [invariant tests](12-testing-strategy.md) green.

### Phase 2 — Commercial accounting
Customers, Invoices, AR; Suppliers, Bills, AP; Payments + allocation; Banking + reconciliation.
**Exit:** invoice→AR→GL→statements and bill→AP→GL→statements tie out; bank rec works; AR/AP aging correct.

### Phase 3 — Business operations
Inventory (FIFO/WA/std, multi-warehouse), Purchasing (PO/GRN/3-way match), Fixed Assets + depreciation, Expenses + OCR intake, Projects.
**Exit:** perpetual inventory posts COGS correctly; 3-way match blocks mismatches; depreciation runs post.

### Phase 4 — Advanced finance
Payroll (EPF/SOCSO/EIS/PCB, versioned config), Tax (SST), Budgeting, Multi-currency + FX revaluation, Multi-company / consolidation.
**Exit:** payroll posts and reconciles; tax report equals GL; FX gain/loss correct; consolidated statements produce.

### Phase 5 — Intelligence
AI Finance Copilot (grounded, read-only), OCR, Automation engine, Anomaly detection, AI reporting, Analytics.
**Exit:** copilot answers cite real transactions and cannot post; automations create drafts/tasks; anomalies flag for review.

### Phase 6 — Enterprise
SSO, advanced/custom permissions, API marketplace, advanced audit, data warehouse, enterprise reporting.
**Exit:** SSO works; custom roles enforce; public API + webhooks documented and rate-limited.

## Dependencies

```
Phase 0 ─▶ Phase 1 ─▶ Phase 2 ─▶ Phase 3 ─┐
                       └────────▶ Phase 4 ─┼─▶ Phase 5 ─▶ Phase 6
                                           ┘
```
Phase 4 needs Phase 2 (AR/AP) and parts of Phase 3; Phase 5 needs real data from 1–4.

## Next engineering specification (§64) — completion tracker

The blueprint's §64 checklist, mapped to where it lives:

| Item | Where | Status |
|---|---|---|
| Complete ERD | [02](02-data-model-erd.md) | ✅ groups + core; extends per phase |
| Every table / column / types / PK / FK / indexes | [03](03-data-dictionary.md) | ✅ Phase 1–2; outlined 3–6 |
| Accounting posting rules | [04](04-accounting-posting-rules.md) | ✅ |
| API endpoints | [05](05-api-spec.md) | ✅ Phase 1–2; catalog for rest |
| Authentication flow | [06](06-auth-and-permission-matrix.md) | ✅ |
| Permission matrix | [06](06-auth-and-permission-matrix.md) | ✅ |
| Frontend route map | [07](07-frontend-route-map-and-components.md) | ✅ |
| Component hierarchy | [07](07-frontend-route-map-and-components.md) | ✅ |
| UI wireframes | [08](08-screen-inventory-and-wireframes.md) | ✅ key screens (lo-fi); hi-fi in Phase 0 design |
| State management | [07](07-frontend-route-map-and-components.md) | ✅ |
| Validation rules / error states | [09](09-status-validation-errors.md) | ✅ |
| Notification events | [10](10-workflow-automation-notifications.md) | ✅ |
| Workflow engine / automation engine | [10](10-workflow-automation-notifications.md) | ✅ |
| AI tool/data-access boundaries | [11](11-ai-boundaries.md) | ✅ |
| Test cases | [12](12-testing-strategy.md) | ✅ strategy + invariants |
| Seed / demo data | [13](13-seed-and-demo-data.md) | ✅ |
| File/folder structure | [15](15-repo-structure-and-devops.md) | ✅ |
| Deployment architecture / CI-CD | [15](15-repo-structure-and-devops.md) | ✅ |
| Backup / recovery | [14](14-nonfunctional.md) | ✅ |
| Observability / logging | [14](14-nonfunctional.md) | ✅ |
| Security checklist | below + [14](14-nonfunctional.md) | ✅ |
| Production launch checklist | below | ✅ |

## Production launch checklist

- [ ] All accounting invariant tests green on production-like data.
- [ ] Security: authz verified on every route; pen-test/security review passed; secrets in a manager; TLS + headers set.
- [ ] Backups running **and a restore has been successfully tested**.
- [ ] Observability: logging, metrics, alerting live; error references traceable.
- [ ] Performance targets met on the large seeded dataset.
- [ ] Period-locking, reversal, and audit trails verified end to end.
- [ ] Malaysian statutory rates (EPF/SOCSO/EIS/PCB, SST) verified current for go-live.
- [ ] Data migration/import validated; opening balances tie out.
- [ ] Rollback plan and runbooks documented.
- [ ] Legal/compliance review (data protection, record retention).
