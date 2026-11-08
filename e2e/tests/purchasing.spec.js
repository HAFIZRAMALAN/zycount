// Phase 3.3 in a real browser: purchase order → receive goods → supplier invoice with a price
// difference → stock, GRNI and the three-way match all agree.
const { test, expect } = require("@playwright/test");
const { useLocalSupabase, unique, strongPassword } = require("./env");

const modal = (page) => page.locator(".zl-modal").last();
const primary = (page) => modal(page).locator("footer .zl-btn.primary");
const shot = (page, name) => page.screenshot({ path: `screens/${name}.png`, fullPage: true });

test("purchase order → goods received → invoice, three-way match", async ({ page }) => {
  const errors = await useLocalSupabase(page);
  await page.goto("/login.html");
  await page.click("#tab-register");
  await page.fill("#r-company", "E2E Purchasing Sdn Bhd");
  await page.fill("#r-name", "Buyer Tester");
  await page.fill("#r-email", `${unique("buy")}@example.com`);
  await page.fill("#r-password", strongPassword());
  await page.click("#register-btn");
  await page.waitForURL(/app\.html#dashboard/);
  await page.waitForFunction(() => window.ZL && ZL.company && ZL.company.company_id);
  await page.evaluate(async () => {
    const c = ZL.company.company_id;
    await ZL.rpc("save_contact", { p_company: c, p_id: null, p_data: { kind: "SUPPLIER", name: "Pembekal Ujian" } });
    await ZL.rpc("save_item", { p_company: c, p_id: null, p_data: { code: "BOLT-1", description: "Steel bolt", buy_price: 5, track_stock: true } });
  });

  // ── Purchase order: 10 bolts at 5.00, issued ─────────────────────────────
  await page.goto("/app.html#purchases");
  await page.locator('button[data-new="PURCHASE_ORDER"]').first().click();
  await expect(modal(page)).toBeVisible();
  const sup = modal(page).locator('select[name="contact"]');
  await sup.selectOption(await sup.locator("option", { hasText: "Pembekal Ujian" }).getAttribute("value"));
  const line = modal(page).locator("#zl-dl [data-ln]").first();
  const item = line.locator('[data-f="item_id"]');
  await item.selectOption(await item.locator("option", { hasText: "BOLT-1" }).getAttribute("value"));
  await line.locator('[data-f="qty"]').fill("10");
  await line.locator('[data-f="unit_price"]').fill("5");
  await sup.focus();
  await primary(page).click();                                   // Save & issue
  await expect(page.locator(".zl-modal")).toHaveCount(0);

  // ── Receive 6 of 10 ──────────────────────────────────────────────────────
  await page.locator("button[data-grn]").click();
  await expect(modal(page)).toBeVisible();
  await modal(page).locator('[name="ref"]').fill("DO-7781");
  await modal(page).locator("[data-pl]").first().fill("6");
  await shot(page, "p1-receive-goods");
  await primary(page).click();
  await expect(page.locator(".zl-modal")).toHaveCount(0);
  await expect(page.getByText("Received and invoiced")).toBeVisible();
  await shot(page, "p2-po-progress");

  // ── Supplier invoice from the delivery, at 5.50 instead of 5.00 ──────────
  await page.goto("/app.html#grns");
  await expect(page.getByText("matches the list below")).toBeVisible();
  await shot(page, "p3-goods-received");
  await page.locator("button[data-ginv]").first().click();
  await expect(modal(page)).toBeVisible();
  const bl = modal(page).locator("#zl-dl [data-ln]").first();
  await expect(bl.locator('[data-f="qty"]')).toHaveValue("6");
  await bl.locator('[data-f="unit_price"]').fill("5.50");
  await modal(page).locator('[name="reference"]').fill("INV-PU-1");
  await modal(page).locator('[name="reference"]').focus();
  await primary(page).click();                                   // Save & post → price differs
  await expect(page.getByText("Price differs from the order")).toBeVisible();
  await shot(page, "p4-price-difference");
  await primary(page).click();                                   // Post with the difference
  await expect(page.locator(".zl-modal")).toHaveCount(0);
  await expect(page.locator("button[data-pay]")).toBeVisible();

  // ── Stock 6 worth 33.00 (30 + 3 difference); GRNI cleared; ledger agrees ─
  const r = await page.evaluate(async () => {
    const c = ZL.company.company_id;
    const [s] = await ZL.rpc("stock_on_hand", { p_company: c, p_warehouse: null });
    return { qty: Number(s.qty), value: Number(s.value), grni: await ZL.rpc("grni_check", { p_company: c }), gl: await ZL.rpc("stock_gl_check", { p_company: c }) };
  });
  expect(r.qty).toBe(6);
  expect(r.value).toBe(33);
  expect(Number(r.grni.gl_balance)).toBe(0);
  expect(r.grni.in_balance).toBe(true);
  expect(r.gl.in_balance).toBe(true);
  await page.goto("/app.html#grns");
  await expect(page.getByText("Nothing waiting")).toBeVisible();

  expect(errors, `uncaught errors in the app: ${errors.join(" | ")}`).toEqual([]);
});
