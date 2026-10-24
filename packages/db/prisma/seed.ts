/**
 * Seed script (docs/spec/13-seed-and-demo-data.md §51, §52).
 *
 * Phase 1 seeds: roles, the permission catalogue, demo users, three demo
 * companies (trading / services / retail), the standard Malaysian chart of
 * accounts, a full year of fiscal periods with one closed, and posted journals
 * that exercise every Phase-1 report.
 *
 * The script is **idempotent** — re-running it upserts rather than duplicating.
 * Run with `pnpm --filter @zycount/db seed`.
 */
import { hash } from "@node-rs/argon2";
import {
  AccountSubType,
  AccountType,
  JournalSource,
  JournalStatus,
  PeriodStatus,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import {
  ALL_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  ROLE_DESCRIPTIONS,
  ROLE_PERMISSIONS,
  ROLES,
  checkBalance,
  parsePermission,
  type RoleName,
} from "@zycount/shared";
import { MY_CHART_OF_ACCOUNTS } from "../src/coa";
import {
  DEMO_PROFILES,
  buildMonthJournals,
  buildOpeningJournal,
  type DemoProfile,
  type SeedJournal,
} from "./seed/transactions";

const prisma = new PrismaClient();

/** Demo password. Every seeded account shares it; never used outside demos. */
const DEMO_PASSWORD = "Zycount!Demo2026";

/** The fiscal year the demo books cover. */
const SEED_YEAR = 2026;
/** Periods 1–8 carry transactions; January is closed to demonstrate locking. */
const TRANSACTING_MONTHS = 8;
const CLOSED_MONTHS = 1;

const argonOptions = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function decimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value.toFixed(2));
}

// ─────────────────────────────────────────────────────────────
// RBAC
// ─────────────────────────────────────────────────────────────

async function seedPermissions(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const code of ALL_PERMISSIONS) {
    const { module, action } = parsePermission(code);
    const permission = await prisma.permission.upsert({
      where: { code },
      update: { module, action, description: PERMISSION_DESCRIPTIONS[code] },
      create: { code, module, action, description: PERMISSION_DESCRIPTIONS[code] },
    });
    ids.set(code, permission.id);
  }

  return ids;
}

async function seedRoles(permissionIds: Map<string, string>): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const name of ROLES) {
    const role = await prisma.role.upsert({
      where: { name },
      update: { description: ROLE_DESCRIPTIONS[name] },
      create: { name, description: ROLE_DESCRIPTIONS[name], isSystem: true },
    });
    ids.set(name, role.id);

    // Re-grant from the matrix so a changed matrix is reflected on re-seed.
    const wanted = ROLE_PERMISSIONS[name as RoleName] ?? [];
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    if (wanted.length > 0) {
      await prisma.rolePermission.createMany({
        data: wanted.map((code) => ({ roleId: role.id, permissionId: permissionIds.get(code)! })),
        skipDuplicates: true,
      });
    }
  }

  return ids;
}

// ─────────────────────────────────────────────────────────────
// Chart of accounts
// ─────────────────────────────────────────────────────────────

async function seedChartOfAccounts(companyId: string): Promise<Map<string, string>> {
  const idByCode = new Map<string, string>();

  // Parents are created before children because the template is ordered
  // top-down; `parentId` is resolved from the map as we go.
  for (const template of MY_CHART_OF_ACCOUNTS) {
    const parentId = template.parent ? idByCode.get(template.parent) ?? null : null;

    const account = await prisma.account.upsert({
      where: { companyId_code: { companyId, code: template.code } },
      update: {
        name: template.name,
        type: template.type as AccountType,
        subType: (template.subType ?? null) as AccountSubType | null,
        parentId,
        description: template.description ?? null,
        isPostable: template.postable ?? true,
        isSystem: template.system ?? false,
      },
      create: {
        companyId,
        code: template.code,
        name: template.name,
        type: template.type as AccountType,
        subType: (template.subType ?? null) as AccountSubType | null,
        parentId,
        description: template.description ?? null,
        isPostable: template.postable ?? true,
        isSystem: template.system ?? false,
      },
    });

    idByCode.set(template.code, account.id);
  }

  return idByCode;
}

// ─────────────────────────────────────────────────────────────
// Fiscal periods
// ─────────────────────────────────────────────────────────────

interface SeededPeriod {
  id: string;
  periodNo: number;
  start: Date;
  end: Date;
  status: PeriodStatus;
}

async function seedFiscalPeriods(companyId: string): Promise<SeededPeriod[]> {
  const periods: SeededPeriod[] = [];

  for (let month = 1; month <= 12; month += 1) {
    const start = utcDate(SEED_YEAR, month, 1);
    const end = utcDate(SEED_YEAR, month, daysInMonth(SEED_YEAR, month));
    const name = `${MONTH_NAMES[month - 1]} ${SEED_YEAR}`;

    const period = await prisma.fiscalPeriod.upsert({
      where: { companyId_year_periodNo: { companyId, year: SEED_YEAR, periodNo: month } },
      update: { name, startDate: start, endDate: end },
      create: {
        companyId,
        name,
        year: SEED_YEAR,
        periodNo: month,
        startDate: start,
        endDate: end,
        status: PeriodStatus.OPEN,
      },
    });

    periods.push({
      id: period.id,
      periodNo: month,
      start,
      end,
      status: period.status,
    });
  }

  return periods;
}

// ─────────────────────────────────────────────────────────────
// Journals
// ─────────────────────────────────────────────────────────────

interface PostContext {
  companyId: string;
  accountIds: Map<string, string>;
  periods: SeededPeriod[];
  postedBy: string;
}

function periodForMonth(periods: SeededPeriod[], month: number): SeededPeriod {
  const period = periods.find((p) => p.periodNo === month);
  if (!period) throw new Error(`No fiscal period seeded for month ${month}`);
  return period;
}

async function postSeedJournal(
  ctx: PostContext,
  journal: SeedJournal,
  month: number,
  sequence: number,
): Promise<void> {
  const period = periodForMonth(ctx.periods, month);
  const reference = `JV-${SEED_YEAR}-${String(sequence).padStart(6, "0")}`;

  // Already seeded — leave the posted entry untouched (posted journals are
  // immutable, so re-seeding must never rewrite one).
  const existing = await prisma.journalEntry.findUnique({
    where: { companyId_reference: { companyId: ctx.companyId, reference } },
    select: { id: true },
  });
  if (existing) return;

  const lines = journal.lines.map((line, index) => {
    const accountId = ctx.accountIds.get(line.code);
    if (!accountId) throw new Error(`Seed journal references unknown account ${line.code}`);
    return {
      accountId,
      debit: decimal(line.debit ?? 0),
      credit: decimal(line.credit ?? 0),
      description: line.description ?? null,
      lineNo: index + 1,
    };
  });

  // Guard the seed against itself: an unbalanced demo entry would poison every
  // report and every invariant test downstream.
  const balance = checkBalance(
    lines.map((l) => ({ accountId: l.accountId, debit: l.debit.toString(), credit: l.credit.toString() })),
  );
  if (!balance.balanced) {
    throw new Error(
      `Seed journal "${journal.description}" does not balance: ` +
        `debit ${balance.totalDebit} vs credit ${balance.totalCredit}`,
    );
  }

  const date = utcDate(SEED_YEAR, month, Math.min(journal.day, daysInMonth(SEED_YEAR, month)));

  await prisma.journalEntry.create({
    data: {
      companyId: ctx.companyId,
      fiscalPeriodId: period.id,
      reference,
      date,
      description: journal.description,
      status: JournalStatus.POSTED,
      source: journal.source as JournalSource,
      totalDebit: decimal(Number(balance.totalDebit)),
      totalCredit: decimal(Number(balance.totalCredit)),
      createdBy: ctx.postedBy,
      postedAt: new Date(),
      postedBy: ctx.postedBy,
      lines: { create: lines },
    },
  });

  // Keep the pre-aggregated balances in step with the ledger.
  for (const line of lines) {
    await prisma.accountBalance.upsert({
      where: { accountId_fiscalPeriodId: { accountId: line.accountId, fiscalPeriodId: period.id } },
      update: { debit: { increment: line.debit }, credit: { increment: line.credit } },
      create: {
        companyId: ctx.companyId,
        accountId: line.accountId,
        fiscalPeriodId: period.id,
        debit: line.debit,
        credit: line.credit,
      },
    });
  }
}

async function seedJournals(ctx: PostContext, profile: DemoProfile): Promise<number> {
  let sequence = 0;

  sequence += 1;
  await postSeedJournal(ctx, buildOpeningJournal(profile), 1, sequence);

  // Arrears roll forward month to month, so receivables behave like a real
  // ledger rather than compounding into an ever-growing balance.
  let carried = 0;

  for (let month = 1; month <= TRANSACTING_MONTHS; month += 1) {
    const { journals, carriedReceivables } = buildMonthJournals(
      profile,
      month - 1,
      daysInMonth(SEED_YEAR, month),
      carried,
    );

    for (const journal of journals) {
      sequence += 1;
      await postSeedJournal(ctx, journal, month, sequence);
    }

    carried = carriedReceivables;
  }

  // The number sequence continues where the seed left off, so the first journal
  // a user creates does not collide with seeded references.
  await prisma.numberSequence.upsert({
    where: { companyId_docType_year: { companyId: ctx.companyId, docType: "JV", year: SEED_YEAR } },
    update: { next: sequence + 1 },
    create: {
      companyId: ctx.companyId,
      docType: "JV",
      year: SEED_YEAR,
      prefix: "JV",
      padding: 6,
      next: sequence + 1,
    },
  });

  return sequence;
}

/** Close the opening months so period locking is demonstrable out of the box. */
async function closeEarlyPeriods(companyId: string, periods: SeededPeriod[], userId: string): Promise<void> {
  for (const period of periods.slice(0, CLOSED_MONTHS)) {
    await prisma.fiscalPeriod.update({
      where: { id: period.id },
      data: { status: PeriodStatus.CLOSED, closedAt: new Date(), closedBy: userId },
    });
    await prisma.auditLog.create({
      data: {
        userId,
        companyId,
        action: "period.close",
        entityType: "FiscalPeriod",
        entityId: period.id,
        metadata: { seeded: true, reason: "Seeded closed period for demonstration" },
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Companies & users
// ─────────────────────────────────────────────────────────────

interface DemoCompanySpec {
  key: DemoProfile["key"];
  name: string;
  registrationNo: string;
  address: string;
  phone: string;
  email: string;
}

const DEMO_COMPANIES: DemoCompanySpec[] = [
  {
    key: "trading",
    name: "Zycount Demo Trading Sdn Bhd",
    registrationNo: "202301000123 (1494821-K)",
    address: "Level 12, Menara Zycount, Jalan Ampang, 50450 Kuala Lumpur, Malaysia",
    phone: "+60 3-2181 8800",
    email: "accounts@demo-trading.zycount.test",
  },
  {
    key: "services",
    name: "Zycount Demo Services Sdn Bhd",
    registrationNo: "202301000456 (1494822-M)",
    address: "Unit 8-3, Oasis Square, Ara Damansara, 47301 Petaling Jaya, Selangor, Malaysia",
    phone: "+60 3-7832 4400",
    email: "accounts@demo-services.zycount.test",
  },
  {
    key: "retail",
    name: "Zycount Demo Retail Sdn Bhd",
    registrationNo: "202301000789 (1494823-T)",
    address: "Lot G-22, Pavilion Retail Centre, Bukit Bintang, 55100 Kuala Lumpur, Malaysia",
    phone: "+60 3-2110 6600",
    email: "accounts@demo-retail.zycount.test",
  },
];

interface DemoUserSpec {
  email: string;
  name: string;
  roles: RoleName[];
}

const DEMO_USERS: DemoUserSpec[] = [
  { email: "admin@zycount.test", name: "Aisyah Rahman", roles: ["SuperAdmin"] },
  { email: "accountant@zycount.test", name: "Lim Wei Jian", roles: ["Accountant"] },
  { email: "manager@zycount.test", name: "Nurul Hidayah", roles: ["FinanceManager"] },
  { email: "auditor@zycount.test", name: "Ravi Chandran", roles: ["Auditor"] },
  { email: "viewer@zycount.test", name: "Tan Mei Ling", roles: ["ReadOnly"] },
];

/**
 * The seed creates a SuperAdmin with a password printed in the README, so it
 * must never reach a real database. It runs against a local host unless
 * ZYCOUNT_ALLOW_DEMO_SEED=1 says the target is a disposable demo, and never
 * when NODE_ENV is production.
 */
function assertDemoTarget(): void {
  const url = process.env.DATABASE_URL ?? "";
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  const local = ["localhost", "127.0.0.1", "::1", "postgres", "db"].includes(host);
  const allowed = process.env.ZYCOUNT_ALLOW_DEMO_SEED === "1";
  if (process.env.NODE_ENV === "production" || (!local && !allowed)) {
    throw new Error(
      `Refusing to seed demo users (known password) into ${host || "an unknown database"}. ` +
        "The seed is for local and disposable demo databases only; set ZYCOUNT_ALLOW_DEMO_SEED=1 for a demo host.",
    );
  }
}

async function main(): Promise<void> {
  assertDemoTarget();
  const started = Date.now();
  console.log("→ Seeding Zycount Phase 1 data…\n");

  const permissionIds = await seedPermissions();
  console.log(`  ✓ ${permissionIds.size} permissions`);

  const roleIds = await seedRoles(permissionIds);
  console.log(`  ✓ ${roleIds.size} roles with their permission grants`);

  const organization =
    (await prisma.organization.findFirst({ where: { name: "Zycount Demo Group" } })) ??
    (await prisma.organization.create({ data: { name: "Zycount Demo Group" } }));
  console.log(`  ✓ organisation "${organization.name}"`);

  const passwordHash = await hash(DEMO_PASSWORD, argonOptions);

  const users = [];
  for (const spec of DEMO_USERS) {
    const user = await prisma.user.upsert({
      where: { email: spec.email },
      update: { name: spec.name, organizationId: organization.id, isActive: true },
      create: {
        organizationId: organization.id,
        email: spec.email,
        name: spec.name,
        passwordHash,
        isActive: true,
      },
    });

    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    await prisma.userRole.createMany({
      data: spec.roles.map((role) => ({ userId: user.id, roleId: roleIds.get(role)! })),
      skipDuplicates: true,
    });

    users.push(user);
  }
  console.log(`  ✓ ${users.length} demo users (password: ${DEMO_PASSWORD})`);

  const admin = users[0];

  for (const spec of DEMO_COMPANIES) {
    const existing = await prisma.company.findFirst({
      where: { organizationId: organization.id, name: spec.name },
    });

    const company =
      existing ??
      (await prisma.company.create({
        data: {
          organizationId: organization.id,
          name: spec.name,
          registrationNo: spec.registrationNo,
          address: spec.address,
          phone: spec.phone,
          email: spec.email,
          baseCurrency: "MYR",
          fiscalYearStartMonth: 1,
          isDemo: true,
        },
      }));

    await prisma.branch.upsert({
      where: { companyId_code: { companyId: company.id, code: "HQ" } },
      update: { name: "Head Office" },
      create: { companyId: company.id, code: "HQ", name: "Head Office", address: spec.address },
    });

    // Everyone in the demo org can see every demo company.
    for (const user of users) {
      await prisma.userCompany.upsert({
        where: { userId_companyId: { userId: user.id, companyId: company.id } },
        update: {},
        create: {
          userId: user.id,
          companyId: company.id,
          isDefault: spec.key === "trading",
        },
      });
    }

    const accountIds = await seedChartOfAccounts(company.id);
    const periods = await seedFiscalPeriods(company.id);

    const count = await seedJournals(
      { companyId: company.id, accountIds, periods, postedBy: admin.id },
      DEMO_PROFILES[spec.key],
    );

    await closeEarlyPeriods(company.id, periods, admin.id);

    console.log(
      `  ✓ ${spec.name}\n` +
        `      ${accountIds.size} accounts · ${periods.length} periods ` +
        `(${CLOSED_MONTHS} closed) · ${count} posted journals`,
    );
  }

  console.log(`\n✓ Seed complete in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`\n  Sign in at http://localhost:3000/login`);
  for (const spec of DEMO_USERS) {
    console.log(`    ${spec.email.padEnd(28)} ${spec.roles.join(", ")}`);
  }
  console.log(`\n  Password for every demo account: ${DEMO_PASSWORD}\n`);
}

main()
  .catch((error) => {
    console.error("\n✗ Seed failed:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
