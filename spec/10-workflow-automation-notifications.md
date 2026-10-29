# 10 — Workflow, Automation & Notifications (§26–§29)

## Approval workflow (§26)

Configurable approval routing by **company, branch, amount, department, document type, user role**.

Example (purchase):
```
≤ RM500          → Manager
RM1,001–10,000   → Finance Manager
> RM10,000       → Director
```

**Model:** a `Workflow` defines ordered steps with conditions; an `Approval` instance tracks a
document through those steps (pending → approved/rejected at each). Documents in `Pending` cannot post
until fully approved. Every decision is audited and shown in the `ApprovalTimeline` component.

## Automation engine (§27)

Visual rule builder: **WHEN → IF → THEN**.

```
WHEN  invoice becomes overdue
IF    amount > RM5,000
THEN  send reminder  +  create task  +  notify Finance Manager
```

- **Triggers (WHEN):** domain events (see event catalog in [05](05-api-spec.md)) + scheduled (cron) + threshold checks (e.g. stock below reorder level).
- **Conditions (IF):** field comparisons on the event payload / related records.
- **Actions (THEN):** send notification/email, create task, create draft document (e.g. suggested PO), assign, tag, call webhook.
- Stored as `Automation { trigger, condition, actions }` (JSONB), evaluated by background workers (BullMQ). Actions that touch the ledger create **drafts for approval** — automation never silently posts.

Built-in automations: reorder stock, recurring invoices, recurring journals, payment reminders,
month-end task generation, approval routing, reconciliation rules.

## Task center (§28)

Tasks: invoice approvals, purchase approvals, bank reconciliation, month-end close, expense approvals, tax tasks.
Statuses: **Urgent / Pending / Completed**. Tasks are created by automations, approvals, and the
month-end center; each links to its source record.

## Notifications (§29)

- **Channels:** in-app, email, push (mobile).
- **Events:** invoice overdue, payment received, approval required, low stock, reconciliation mismatch, payroll ready, month-end issue, AI anomaly flag.
- **Model:** `Notification { userId, event, payload, channel, readAt }`; delivery handled by workers; per-user channel preferences in settings.

## Recurring & scheduled

Recurring journals/invoices and scheduled automations run via the BullMQ scheduler; each run is
idempotent and logged. Failures raise a notification and a task rather than silently dropping.
