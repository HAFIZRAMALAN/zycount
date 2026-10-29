# Zycount Engineering Specification

This is the source of truth for building Zycount. It turns the product blueprint into
buildable engineering detail. Read in order.

| # | Document | Covers (blueprint §) |
|---|---|---|
| 00 | [Overview](00-overview.md) | Vision, pillars, transaction flow, scope, phases (§1, §63) |
| 01 | [Accounting Principles & Glossary](01-glossary-and-accounting-principles.md) | Double-entry invariants, immutability, period locking (§3) |
| 02 | [Data Model / ERD](02-data-model-erd.md) | Entities and relationships (§54) |
| 03 | [Data Dictionary](03-data-dictionary.md) | Every table, column, type, PK/FK, index |
| 04 | [Accounting Posting Rules](04-accounting-posting-rules.md) | Dr/Cr matrix per transaction type (§3–§15) |
| 05 | [API Specification](05-api-spec.md) | REST endpoints, OAuth, webhooks, events (§53) |
| 06 | [Auth & Permission Matrix](06-auth-and-permission-matrix.md) | Roles × permissions, RBAC, MFA (§2) |
| 07 | [Frontend Route Map & Components](07-frontend-route-map-and-components.md) | Routes, sidebar, state, ⌘K, shortcuts (§44–§47, §62) |
| 08 | [Screen Inventory & Wireframes](08-screen-inventory-and-wireframes.md) | Screens + lo-fi wireframes (§43–§48) |
| 09 | [Status, Validation & Errors](09-status-validation-errors.md) | Status system, validation, error model (§49, §50) |
| 10 | [Workflow, Automation & Notifications](10-workflow-automation-notifications.md) | Approvals, WHEN→IF→THEN, tasks, notifications (§26–§29) |
| 11 | [AI Boundaries](11-ai-boundaries.md) | Copilot/OCR/anomaly guardrails (§38–§42) |
| 12 | [Testing Strategy](12-testing-strategy.md) | Software + accounting invariant tests (§60) |
| 13 | [Seed & Demo Data](13-seed-and-demo-data.md) | Demo companies, onboarding (§51, §52) |
| 14 | [Non-Functional Requirements](14-nonfunctional.md) | Performance, security, backup/DR, offline (§57–§59) |
| 15 | [Repo Structure & DevOps](15-repo-structure-and-devops.md) | Layout, deployment, CI/CD (§55, §56) |
| 16 | [Phase Roadmap & Launch Checklist](16-phase-roadmap-and-launch-checklist.md) | 6-phase plan, launch checklist (§61, §64) |

## Conventions

- **Currency & money:** stored as `DECIMAL(18,2)` in the company base currency. Never use floats for money.
- **IDs:** UUID v4 primary keys.
- **Immutability:** posted journals are never edited or deleted — only reversed.
- **Traceability:** every GL line carries `source` + `sourceId` back to its originating document.
- **Malaysia specifics** (EPF/SOCSO/EIS/PCB, SST) are **versioned configuration**, verified against current statutory rates before production — never hard-coded.
