// Phase 3.2: a stock item in a real browser —
// create it → opening stock → sell it on an invoice → stock on hand, COGS and the ledger agree.
const { test, expect } = require("@playwright/test");
const { useLocalSupabase, unique, strongPassword } = require("./env");

const modal = (page) => page.locator(".zl-modal").last();
const primary = (page) => modal(page).locator("footer .zl-btn.primary");

test("stock item: opening stock, sale, average cost and COGS", async ({ page }) => {
  const errors = await useLocalSupabase(page);
  await page.goto("/login.html");
  await page.click("#tab-register");
  await page.fill("#r-company", "E2E Stock Sdn Bhd");
  await page.fill("#r-name", "Stock Tester");
  await page.fill("#r-email", `${unique("stock")}@example.com`);
  await page.fill("#r-password", strongPassword());
  await page.click("#register-btn");
  await page.waitForURL(/app\.html#dashboard/);
  await page.waitForFunction(() => window.ZL && ZL.company && ZL.company.company_id);

  // ── A stock item, created in the item form ───────────────────────────────
  await page.goto("/app.html#items");
  await page.click("#zl-inew");
  await expect(modal(page)).toBeVisible();
  await modal(page).locator('[name="code"]').fill("WID-1");
  await modal(page).locator('[name="description"]').fill("Widget");
  await modal(page).locator('[name="sell_price"]').fill("25");
  await modal(page).locator('[name="buy_price"]').fill("10");
  await modal(page).locator('[name="track_stock"]').check();
  await expect(modal(page).locator('[name="inventory_account_id"]')).toBeVisible();
  await primary(page).click();
  await expect(page.locator(".zl-modal")).toHaveCount(0);

  // ── Opening stock: 10 at 10.00 and 10 at 12.00 → average 11.00 ───────────
  await page.goto("/app.html#stock");
  await page.locator('button[data-sdoc="OPENING"]').first().click();
  await expect(modal(page)).toBeVisible();
  const rows = modal(page).locator("#zl-sl [data-sl]");
  const wid = await rows.nth(0).locator('[data-f="item"] option', { hasText: "WID-1" }).getAttribute("value");
  await rows.nth(0).locator('[data-f="item"]').selectOption(wid);
  await rows.nth(0).locator('[data-f="qty"]').fill("10");
  await rows.nth(0).locator('[data-f="cost"]').fill("10");
  await rows.nth(1).locator('[data-f="item"]').selectOption(wid);
  await rows.nth(1).locator('[data-f="qty"]').fill("10");
  await rows.nth(1).locator('[data-f="cost"]').fill("12");
  await primary(page).click();
  await expect(page.locator(".zl-modal")).toHaveCount(0);
  const row = page.locator("tr[data-card]", { hasText: "WID-1" });
  await expect(row).toContainText("20");
  await expect(row).toContainText("220.00");

  // ── Sell 4 on an invoice ─────────────────────────────────────────────────
  await page.evaluate(() => ZL.rpc("save_contact", { p_company: ZL.company.company_id, p_id: null, p_data: { kind: "CUSTOMER", name: "Kedai Stok" } }));
  await page.goto("/app.html#sales");
  await page.locator('button[data-new="INVOICE"]').first().click();
  await expect(modal(page)).toBeVisible();
  const contact = modal(page).locator('select[name="contact"]');
  await contact.selectOption(await contact.locator("option", { hasText: "Kedai Stok" }).getAttribute("value"));
  const line = modal(page).locator("#zl-dl [data-ln]").first();
  const item = line.locator('[data-f="item_id"]');
  await item.selectOption(await item.locator("option", { hasText: "WID-1" }).getAttribute("value"));
  await line.locator('[data-f="qty"]').fill("4");
  await contact.focus();
  await primary(page).click();
  await expect(page.locator(".zl-modal")).toHaveCount(0);
  await expect(page.locator("button[data-pay]")).toBeVisible();

  // ── Stock 16 worth 176.00; COGS 44.00; ledger agrees ─────────────────────
  await page.goto("/app.html#stock");
  await expect(row).toContainText("16");
  await expect(row).toContainText("176.00");
  await expect(page.getByText("Stock value agrees with the inventory account")).toBeVisible();
  const cogs = await page.evaluate(async () => {
    const [acc] = await ZL.select("accounts", "id", (q) => q.eq("company_id", ZL.company.company_id).eq("code", "5100"));
    const lines = await ZL.select("journal_lines", "debit,credit,journal_entries!inner(company_id,status)",
      (q) => q.eq("account_id", acc.id).eq("journal_entries.status", "POSTED"));
    return lines.reduce((s, l) => s + Math.round((Number(l.debit) - Number(l.credit)) * 100), 0) / 100;
  });
  expect(cogs).toBe(44);

  // The stock card shows both movements.
  await row.click();
  await expect(page.locator("td", { hasText: /^Opening stock$/ })).toHaveCount(2);
  await expect(page.locator("td", { hasText: /^Sale$/ })).toHaveCount(1);

  expect(errors, `uncaught errors in the app: ${errors.join(" | ")}`).toEqual([]);
});
