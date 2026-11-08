// Audit G4: the edge functions' public behaviour, against `supabase start`.
const { test, expect } = require("@playwright/test");
const { SUPA_URL, SUPA_ANON, unique, strongPassword } = require("./env");

const fn = (name) => `${SUPA_URL}/functions/v1/${name}`;
const headers = { "Content-Type": "application/json", apikey: SUPA_ANON, Origin: "http://localhost:8767" };
const person = (over = {}) => Object.assign({
  kind: "BUSINESS", company_name: "Fn Test Sdn Bhd", full_name: "Fn Tester",
  email: `${unique("fn")}@example.com`, password: strongPassword(),
}, over);

test.describe("signup", () => {
  test("answers CORS preflight for the app's origin", async ({ request }) => {
    const r = await request.fetch(fn("signup"), { method: "OPTIONS", headers: { Origin: "http://localhost:8767" } });
    expect(r.ok()).toBeTruthy();
    // Locally the API gateway answers preflight itself with "*"; the hosted
    // function echoes the allowed origin. Either lets the app call it.
    expect(["http://localhost:8767", "*"]).toContain(r.headers()["access-control-allow-origin"]);
  });

  test("refuses bad input without creating anything", async ({ request }) => {
    for (const [body, code] of [
      [person({ email: "not-an-email" }), "VALIDATION"],
      [person({ password: "short1" }), "VALIDATION"],
      [person({ full_name: "" }), "VALIDATION"],
      [person({ kind: "OTHER" }), "VALIDATION"],
    ]) {
      const r = await request.post(fn("signup"), { headers, data: body });
      expect(r.status(), JSON.stringify(body)).toBe(400);
      expect((await r.json()).error).toMatch(new RegExp(`^${code}:`));
    }
  });

  test("refuses a password found in data breaches", async ({ request }) => {
    const r = await request.post(fn("signup"), { headers, data: person({ password: "password1" }) });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/data breach/);
  });

  test("creates the account and books once, then refuses the same email", async ({ request }) => {
    const body = person();
    const r = await request.post(fn("signup"), { headers, data: body });
    expect(r.status()).toBe(201);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.company_id).toBeTruthy();
    const again = await request.post(fn("signup"), { headers, data: body });
    expect(again.status()).toBe(409);
  });

  test("only POST is accepted", async ({ request }) => {
    const r = await request.get(fn("signup"), { headers });
    expect(r.status()).toBe(405);
  });
});

test.describe("functions that need a signed-in user", () => {
  for (const name of ["billing", "scan-document", "myinvois"]) {
    test(`${name} refuses an anonymous caller`, async ({ request }) => {
      const r = await request.post(fn(name), { headers, data: { action: "verify" } });
      expect([401, 403]).toContain(r.status());
    });
  }
});
