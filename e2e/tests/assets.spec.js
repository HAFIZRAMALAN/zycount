// Phase 3.4 in a real browser: register an asset, run monthly depreciation, register one bought
// on a purchase invoice, then sell an asset at a loss — and the register agrees with the ledger.
const { test, expect } = require("@playwright/test");
const { useLocalSupabase, unique, strongPassword } = require("./env");

const modal = (page) => page.locator(".zl-modal").last();
const primary = (page) => modal(page).locator("footer .zl-btn.primary");
const shot = (page, name) => page.screenshot({ path: `screens/${name}.png`, fullPage: true });

test("fixed assets: register → depreciation → from a bill → disposal", async ({ page }) => {
  const errors = await useLocalSupabase(page);
  const y = new Date().getFullYear();
  await page.goto("/login.html");
  await page.click("#tab-register");
  await page.fill("#r-company", "E2E Aset Sdn Bhd");
  await page.fill("#r-name", "Asset Tester");
  await page.fill("#r-email", `${unique("fa")}@example.com`);
  await page.fill("#r-password", strongPassword());
  await page.click("#register-btn");
  await page.waitForURL(/app\.html#dashboard/);
  await page.waitForFunction(() => window.ZL && ZL.company && ZL.company.company_id);

  // ── Register a photocopier bought in January, paid from the bank ─────────
  await page.goto("/app.html#assets");
  await expect(page.getByText("No fixed assets yet")).toBeVisible();
  await page.click("#zl-fadd");
  await expect(modal(page)).toBeVisible();
  await modal(page).locator('[name="name"]').fill("Photocopier");
  await modal(page).locator('[name="acquired_on"]').fill(`${y}-01-15`);
  await modal(page).locator('[name="cost"]').fill("12000");
  await modal(page).locator('[name="paid"]').selectOption({ index: 1 });
  await modal(page).locator('[name="life_months"]').fill("60");
  await shot(page, "f1-register-asset");
  await primary(page).click();
  await expect(page.locator(".zl-modal")).toHaveCount(0);
  await expect(page.locator("[data-fa]")).toHaveCount(1);

  // ── Depreciation to March: 3 × 200 ───────────────────────────────────────
  await page.click("#zl-frun");
  await modal(page).locator('[name="month"]').fill(`${y}-03`);
  await primary(page).click();                                      // Preview
  await expect(modal(page).getByText("600.00").first()).toBeVisible();
  await shot(page, "f2-depreciation-preview");
  await primary(page).click();                                      // Post depreciation
  await expect(page.locator(".zl-modal")).toHaveCount(0);
  await expect(page.getByText(/Depreciation RM 600\.00 posted/)).toBeVisible();

  // ── A laptop bought on a purchase invoice shows up to be registered ──────
  await page.evaluate(async () => {
    const c = ZL.company.company_id;
    await ZL.rpc("save_contact", { p_company: c, p_id: null, p_data: { kind: "SUPPLIER", name: "Kedai Komputer" } });
    const [su] = await ZL.select("contacts", "id", (q) => q.eq("company_id", c).eq("kind", "SUPPLIER"));
    const acc = (await ZL.accounts(true)).find((a) => a.code === "1560");
    await ZL.rpc("save_trade_doc", { p_company: c, p_id: null, p_doc: { doc_type: "BILL", contact_id: su.id, date: ZL.today(), reference: "KK-88" },
      p_lines: [{ description: "Laptop", qty: 1, unit_price: 3000, account_id: acc.id }], p_post: true });
  });
  await page.goto("/app.html#dashboard");
  await page.goto("/app.html#assets");
  await expect(page.getByText("not in the register yet")).toBeVisible();
  await expect(page.getByText("The register and the ledger differ")).toBeVisible();
  await page.locator("button[data-freg]").first().click();
  await modal(page).locator('[name="life_months"]').fill("36");
  await primary(page).click();
  await expect(page.locator(".zl-modal")).toHaveCount(0);
  await expect(page.getByText("The register agrees with the ledger")).toBeVisible();
  await expect(page.locator("[data-fa]")).toHaveCount(2);
  await shot(page, "f3-register");

  // ── Sell the photocopier in April for 11,000: April's 200, then a loss of 200 ─
  await page.locator("[data-fa]", { hasText: "Photocopier" }).click();
  await expect(modal(page)).toBeVisible();
  await shot(page, "f4-asset-detail");
  await primary(page).click();                                      // Sell or write off
  await modal(page).locator('[name="date"]').fill(`${y}-04-10`);
  await modal(page).locator('[name="proceeds"]').fill("11000");
  await primary(page).click();                                      // Post disposal
  await expect(page.locator(".zl-modal")).toHaveCount(0);
  await expect(page.getByText(/loss RM 200\.00/)).toBeVisible();

  const r = await page.evaluate(async () => ZL.rpc("fixed_asset_gl_check", { p_company: ZL.company.company_id }));
  expect(r.in_balance).toBe(true);
  await expect(page.getByText("The register agrees with the ledger")).toBeVisible();
  await shot(page, "f5-after-disposal");

  expect(errors, `uncaught errors in the app: ${errors.join(" | ")}`).toEqual([]);
});
