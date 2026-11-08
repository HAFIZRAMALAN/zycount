// Audit R7: the live app's main flow in a real browser —
// sign up → invoice → receive payment → money in → reports → sign out and back in.
const { test, expect } = require("@playwright/test");
const { useLocalSupabase, unique, strongPassword } = require("./env");

const modal = (page) => page.locator(".zl-modal").last();
const primary = (page) => modal(page).locator("footer .zl-btn.primary");
const money = (n) => n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

test("a new business keeps its books end to end", async ({ page }) => {
  const errors = await useLocalSupabase(page);
  const email = `${unique("e2e")}@example.com`;
  const password = strongPassword();
  const company = "E2E Trading Sdn Bhd";

  // ── Sign up ──────────────────────────────────────────────────────────────
  await page.goto("/login.html");
  await page.click("#tab-register");
  await page.fill("#r-company", company);
  await page.fill("#r-name", "Aina E2E");
  await page.fill("#r-email", email);
  await page.fill("#r-password", password);
  await page.click("#register-btn");
  await page.waitForURL(/app\.html#dashboard/);
  await expect(page.getByText(company).first()).toBeVisible();

  // A customer to bill (set up through the API the app itself uses).
  await page.waitForFunction(() => window.ZL && ZL.company && ZL.company.company_id);
  await page.evaluate(() => ZL.rpc("save_contact", {
    p_company: ZL.company.company_id, p_id: null, p_data: { kind: "CUSTOMER", name: "Kedai Ujian E2E" },
  }));

  // ── Invoice 1,000.00 and post it ─────────────────────────────────────────
  await page.goto("/app.html#sales");
  await page.locator('button[data-new="INVOICE"]').first().click();
  await expect(modal(page)).toBeVisible();
  const contact = modal(page).locator('select[name="contact"]');
  const value = await contact.locator("option", { hasText: "Kedai Ujian E2E" }).getAttribute("value");
  await contact.selectOption(value);
  const line = modal(page).locator("#zl-dl [data-ln]").first();
  await line.locator('[data-f="description"]').fill("Consulting, November");
  await line.locator('[data-f="unit_price"]').fill("1000");
  await modal(page).locator('select[name="contact"]').focus(); // let the line total redraw
  await primary(page).click();                                  // Save & post
  await expect(page.locator(".zl-modal")).toHaveCount(0);
  const pay = page.locator("button[data-pay]");
  await expect(pay).toBeVisible();                                // the posted invoice opened
  await expect(page.getByText("RM 1,000.00").first()).toBeVisible();

  // ── Receive the payment in full ──────────────────────────────────────────
  await pay.click();
  await expect(modal(page)).toBeVisible();
  await primary(page).click();
  await expect(page.locator(".zl-modal")).toHaveCount(0);
  const inv = await page.evaluate(async () => (await ZL.select("trade_docs", "doc_type,status,total,allocated",
    (q) => q.eq("company_id", ZL.company.company_id).eq("doc_type", "INVOICE")))[0]);
  expect(inv.status).toBe("POSTED");
  expect(Number(inv.total)).toBe(1000);
  expect(Number(inv.allocated)).toBe(1000);

  // ── Other income through "Money in" ──────────────────────────────────────
  await page.goto("/app.html#transactions");
  await page.locator('button[data-quick="IN"]').click();
  await expect(modal(page)).toBeVisible();
  await modal(page).locator('[name="amount"]').fill("234.56");
  const cat = modal(page).locator('select[name="other"]');
  const firstCat = await cat.locator("option").evaluateAll((os) => (os.find((o) => o.value) || {}).value);
  await cat.selectOption(firstCat);
  await modal(page).locator('[name="description"]').fill("E2E sundry income");
  await primary(page).click();                                  // Record receipt
  await expect(page.locator(".zl-modal")).toHaveCount(0);
  await expect(page.getByText("E2E sundry income").first()).toBeVisible();

  // ── The books agree ──────────────────────────────────────────────────────
  const proof = await page.evaluate(async () => {
    const lines = await ZL.select("journal_lines", "debit,credit,journal_entries!inner(company_id,status)",
      (q) => q.eq("journal_entries.company_id", ZL.company.company_id).eq("journal_entries.status", "POSTED"));
    const d = lines.reduce((s, l) => s + Math.round(Number(l.debit) * 100), 0);
    const c = lines.reduce((s, l) => s + Math.round(Number(l.credit) * 100), 0);
    return { d, c, n: lines.length };
  });
  expect(proof.n).toBeGreaterThan(0);
  expect(proof.d).toBe(proof.c);

  await page.goto("/app.html#tb");
  await expect(page.getByText(money(1234.56)).first()).toBeVisible();   // cash received in total
  await page.goto("/app.html#pl");
  // Invoice 1,000.00 + money in 234.56, both income (the first category is Sales).
  await expect(page.getByText(`RM ${money(1234.56)}`).first()).toBeVisible();

  // ── Sign out, sign back in ───────────────────────────────────────────────
  await page.goto("/app.html#dashboard");
  await page.evaluate(() => document.getElementById("me-signout").click());
  await page.waitForURL(/login\.html/);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click("#signin-btn");
  await page.waitForURL(/app\.html/);
  await expect(page.getByText(company).first()).toBeVisible();

  expect(errors, `uncaught errors in the app: ${errors.join(" | ")}`).toEqual([]);
});
