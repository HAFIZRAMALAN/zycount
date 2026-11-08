// Maker-checker in a real browser: the owner turns approvals on, a RM 6,000 purchase invoice is held,
// the maker can't approve it, and a second person approves it from the Approvals page — it posts.
const { test, expect } = require("@playwright/test");
const { execSync } = require("child_process");
const { useLocalSupabase, unique, strongPassword } = require("./env");

const modal = (page) => page.locator(".zl-modal").last();
const primary = (page) => modal(page).locator("footer .zl-btn.primary");
const shot = (page, name) => page.screenshot({ path: `screens/${name}.png`, fullPage: true });

async function signUp(page, company, name, email) {
  await page.goto("/login.html");
  await page.click("#tab-register");
  await page.fill("#r-company", company);
  await page.fill("#r-name", name);
  await page.fill("#r-email", email);
  await page.fill("#r-password", strongPassword());
  await page.click("#register-btn");
  await page.waitForURL(/app\.html#dashboard/);
  await page.waitForFunction(() => window.ZL && ZL.company && ZL.company.company_id);
}

test("maker-checker: held purchase invoice approved by a second person", async ({ browser }) => {
  test.skip(!process.env.E2E_DB_URL, "needs E2E_DB_URL to add the second person to the books");
  const maker = await (await browser.newContext()).newPage();
  const checker = await (await browser.newContext()).newPage();
  const errors = await useLocalSupabase(maker);
  await useLocalSupabase(checker);
  const checkerEmail = `${unique("chk")}@example.com`;
  await signUp(maker, "E2E Lulus Sdn Bhd", "Maker Tester", `${unique("mk")}@example.com`);
  await signUp(checker, "Checker Own Books", "Checker Tester", checkerEmail);
  const company = await maker.evaluate(() => ZL.company.company_id);
  // Only the throwaway CI database is touched: the checker joins the maker's books as an Accountant.
  execSync(`psql "${process.env.E2E_DB_URL}" -q -c "insert into public.company_members (company_id, user_id, role) select '${company}', id, 'Accountant' from auth.users where email = '${checkerEmail}'"`, { stdio: "ignore" });

  // ── The owner turns approvals on above RM 5,000 ──────────────────────────
  await maker.goto("/app.html#approvals");
  await maker.check("#zl-apon");
  await maker.fill("#zl-apth", "5000");
  await maker.click("#zl-apsave");
  await expect(maker.getByText("Approvals on, above RM 5,000.00.")).toBeVisible();

  // ── A RM 6,000 purchase invoice is held, not posted ──────────────────────
  const held = await maker.evaluate(async () => {
    const c = ZL.company.company_id;
    await ZL.rpc("save_contact", { p_company: c, p_id: null, p_data: { kind: "SUPPLIER", name: "Pembekal Mesin" } });
    const [su] = await ZL.select("contacts", "id", (q) => q.eq("company_id", c).eq("kind", "SUPPLIER"));
    const ex = (await ZL.accounts(true)).find((a) => a.type === "EXPENSE" && a.is_postable && !a.is_control && a.code.startsWith("6"));
    return ZL.rpc("save_trade_doc", { p_company: c, p_id: null, p_doc: { doc_type: "BILL", contact_id: su.id, date: ZL.today(), reference: "MSN-1" },
      p_lines: [{ description: "Machine service", qty: 1, unit_price: 6000, account_id: ex.id }], p_post: true });
  });
  expect(held.status).toBe("PENDING");
  await maker.evaluate(() => ZL.refresh());                                   // same route: render it again
  await expect(maker.getByText("Waiting (1)")).toBeVisible();
  await expect(maker.locator("[data-open]")).toContainText("(you)");
  await expect(maker.locator('[data-apr="approve"]')).toHaveCount(0);           // the maker can't approve
  await shot(maker, "m1-maker-queue");
  await maker.evaluate((id) => ZL.open("tradedoc", { id }), held.id);
  await expect(maker.getByText("Waiting for approval")).toBeVisible();
  await shot(maker, "m2-held-document");

  // ── The checker opens the maker's books and approves it ──────────────────
  await checker.evaluate((c) => { localStorage.setItem("zl.company", c); }, company);
  await checker.goto("/app.html#approvals");
  await checker.reload();                                                     // load the books it now belongs to
  await checker.waitForFunction((c) => window.ZL && ZL.company && ZL.company.company_id === c, company);
  await checker.evaluate(() => ZL.refresh());
  await expect(checker.getByText("Waiting (1)")).toBeVisible();
  await shot(checker, "m3-checker-queue");
  await checker.locator('[data-apr="approve"]').first().click();
  await expect(modal(checker)).toBeVisible();
  await primary(checker).click();                                              // Approve & post
  await expect(checker.getByText(/Approved and posted/)).toBeVisible();

  const after = await maker.evaluate(async (id) => (await ZL.select("trade_docs", "status,approval_status,doc_no", (q) => q.eq("id", id)))[0], held.id);
  expect(after.status).toBe("POSTED");
  expect(after.approval_status).toBe("APPROVED");
  await maker.evaluate((id) => ZL.open("tradedoc", { id }), held.id);
  await expect(maker.getByText("Waiting for approval")).toHaveCount(0);
  await shot(maker, "m4-posted");

  expect(errors, `uncaught errors in the app: ${errors.join(" | ")}`).toEqual([]);
});
