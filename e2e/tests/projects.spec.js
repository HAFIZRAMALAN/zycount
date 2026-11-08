// Phase 3.5 in a real browser: create a project, invoice it from the sales editor, book a cost to it,
// and read its profit on the Projects page and in P&L by project.
const { test, expect } = require("@playwright/test");
const { useLocalSupabase, unique, strongPassword } = require("./env");

const modal = (page) => page.locator(".zl-modal").last();
const primary = (page) => modal(page).locator("footer .zl-btn.primary");
const shot = (page, name) => page.screenshot({ path: `screens/${name}.png`, fullPage: true });

test("projects: tag an invoice and a cost, P&L by project", async ({ page }) => {
  const errors = await useLocalSupabase(page);
  await page.goto("/login.html");
  await page.click("#tab-register");
  await page.fill("#r-company", "E2E Projek Sdn Bhd");
  await page.fill("#r-name", "Project Tester");
  await page.fill("#r-email", `${unique("pj")}@example.com`);
  await page.fill("#r-password", strongPassword());
  await page.click("#register-btn");
  await page.waitForURL(/app\.html#dashboard/);
  await page.waitForFunction(() => window.ZL && ZL.company && ZL.company.company_id);
  await page.evaluate(async () => {
    await ZL.rpc("save_contact", { p_company: ZL.company.company_id, p_id: null, p_data: { kind: "CUSTOMER", name: "Pelanggan Projek" } });
  });

  // ── New project ──────────────────────────────────────────────────────────
  await page.goto("/app.html#projects");
  await expect(page.getByText("No projects yet")).toBeVisible();
  await page.click("#zl-pjadd");
  await modal(page).locator('[name="code"]').fill("RENO-01");
  await modal(page).locator('[name="name"]').fill("Renovation Ampang");
  await shot(page, "j1-new-project");
  await primary(page).click();
  await expect(page.locator(".zl-modal")).toHaveCount(0);
  await expect(page.locator("[data-pj]")).toHaveCount(1);

  // ── An invoice for the project, from the sales editor ────────────────────
  await page.goto("/app.html#sales");
  await page.locator('button[data-new="INVOICE"]').first().click();
  await expect(modal(page)).toBeVisible();
  const cust = modal(page).locator('select[name="contact"]');
  await cust.selectOption(await cust.locator("option", { hasText: "Pelanggan Projek" }).getAttribute("value"));
  const proj = modal(page).locator('select[name="project"]');
  await proj.selectOption(await proj.locator("option", { hasText: "RENO-01" }).getAttribute("value"));
  const line = modal(page).locator("#zl-dl [data-ln]").first();
  await line.locator('[data-f="description"]').fill("Design and supervision");
  await line.locator('[data-f="unit_price"]').fill("5000");
  await cust.focus();
  await shot(page, "j2-invoice-with-project");
  await primary(page).click();                                      // Save & post
  await expect(page.locator(".zl-modal")).toHaveCount(0);

  // ── A cost booked to the project on a journal line ───────────────────────
  await page.evaluate(async () => {
    const c = ZL.company.company_id;
    const accs = await ZL.accounts(true);
    const ex = accs.find((a) => a.type === "EXPENSE" && a.is_postable && !a.is_control && a.code.startsWith("6"));
    const cash = accs.find((a) => a.is_cash && a.is_postable);
    const [p] = await ZL.select("projects", "id", (q) => q.eq("company_id", c));
    const j = await ZL.rpc("save_journal", { p_company: c, p_id: null, p_date: ZL.today(), p_description: "Site labour", p_memo: null, p_version: null,
      p_lines: [{ account_id: ex.id, debit: 1200, credit: 0, project_id: p.id }, { account_id: cash.id, debit: 0, credit: 1200 }] });
    await ZL.rpc("post_journal", { p_id: j.id });
  });

  // ── Profit 5,000 − 1,200 = 3,800 on the list and in the report ───────────
  await page.goto("/app.html#projects");
  await expect(page.locator("[data-pj]")).toContainText("3,800.00");
  await shot(page, "j3-projects");
  await page.goto("/app.html#projectpl");
  await expect(page.locator("thead")).toContainText("RENO-01");
  await expect(page.locator("tfoot")).toContainText("3,800.00");
  await shot(page, "j4-pl-by-project");

  // ── The journal editor offers a project on each line ─────────────────────
  await page.evaluate(() => ZL.open("journal", { isNew: true }));
  await expect(page.locator('[data-f="project"]').first()).toBeVisible();

  expect(errors, `uncaught errors in the app: ${errors.join(" | ")}`).toEqual([]);
});
