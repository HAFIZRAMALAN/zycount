import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { DEMO_PASSWORD, api, createHarness, login, type Harness, type Session } from "./harness";

/**
 * Authentication and authorisation (docs/spec/06).
 *
 * The UI hides controls by permission, but the server is the authority — these
 * tests go straight at the API to prove it.
 */
describe("auth and permissions", () => {
  let harness: Harness;
  let admin: Session;
  let companyId: string;

  beforeAll(async () => {
    harness = await createHarness();
    admin = await login(harness.app, "admin@zycount.test");
    companyId = admin.user.companies[0].id;
  });

  afterAll(async () => {
    await harness?.close();
  });

  const server = () => harness.app.getHttpServer();

  describe("sign-in", () => {
    it("returns an access token, the user, and their effective permissions", async () => {
      const response = await request(server())
        .post("/api/auth/login")
        .send({ email: "accountant@zycount.test", password: DEMO_PASSWORD })
        .expect(200);

      expect(response.body.accessToken).toBeTruthy();
      expect(response.body.user.roles).toEqual(["Accountant"]);
      expect(response.body.user.permissions).toContain("journal.post");
      expect(response.body.user.permissions).not.toContain("period.close");
      expect(response.body.user.companies.length).toBeGreaterThan(0);
    });

    it("sets a refresh cookie that JavaScript cannot read", async () => {
      const response = await request(server())
        .post("/api/auth/login")
        .send({ email: "accountant@zycount.test", password: DEMO_PASSWORD })
        .expect(200);

      const cookie = (response.headers["set-cookie"] as unknown as string[])?.find((value) =>
        value.startsWith("zycount_refresh="),
      );

      expect(cookie).toBeTruthy();
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Path=/api/auth");
    });

    it("never says whether it was the email or the password that was wrong", async () => {
      const unknownEmail = await request(server())
        .post("/api/auth/login")
        .send({ email: "nobody@zycount.test", password: DEMO_PASSWORD })
        .expect(401);

      const wrongPassword = await request(server())
        .post("/api/auth/login")
        .send({ email: "accountant@zycount.test", password: "WrongPassword!2026" })
        .expect(401);

      expect(unknownEmail.body.error.code).toBe("AUTH_INVALID_CREDENTIALS");
      expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
    });

    it("rejects a malformed sign-in before it reaches the database", async () => {
      const response = await request(server())
        .post("/api/auth/login")
        .send({ email: "not-an-email", password: "" })
        .expect(422);

      expect(response.body.error.code).toBe("VALIDATION_FAILED");
      expect(response.body.error.fields).toHaveProperty("email");
    });
  });

  describe("session lifecycle", () => {
    const refreshCookie = (response: request.Response) =>
      ((response.headers["set-cookie"] as unknown as string[]) ?? [])
        .find((value) => value.startsWith("zycount_refresh="))
        ?.split(";")[0];

    it("rotates the refresh token on every use", async () => {
      const agent = request.agent(server());

      await agent
        .post("/api/auth/login")
        .send({ email: "viewer@zycount.test", password: DEMO_PASSWORD })
        .expect(200);

      const first = await agent.post("/api/auth/refresh").expect(200);
      expect(first.body.accessToken).toBeTruthy();

      // The agent now holds the rotated cookie, so this must succeed…
      await agent.post("/api/auth/refresh").expect(200);
    });

    it("refuses a replayed refresh token and ends the whole family", async () => {
      const signIn = await request(server())
        .post("/api/auth/login")
        .send({ email: "viewer@zycount.test", password: DEMO_PASSWORD })
        .expect(200);
      const original = refreshCookie(signIn)!;
      expect(original).toBeTruthy();

      const rotated = await request(server()).post("/api/auth/refresh").set("Cookie", original).expect(200);
      const successor = refreshCookie(rotated)!;

      const replay = await request(server()).post("/api/auth/refresh").set("Cookie", original).expect(401);
      expect(replay.body.error.code).toBe("AUTH_REFRESH_REUSED");

      // The token issued before the replay was detected is dead too.
      await request(server()).post("/api/auth/refresh").set("Cookie", successor).expect(401);
    });

    it("lets only one of two simultaneous refreshes with the same token through", async () => {
      const signIn = await request(server())
        .post("/api/auth/login")
        .send({ email: "viewer@zycount.test", password: DEMO_PASSWORD })
        .expect(200);
      const token = refreshCookie(signIn)!;

      const results = await Promise.all(
        Array.from({ length: 4 }, () => request(server()).post("/api/auth/refresh").set("Cookie", token)),
      );

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 401)).toHaveLength(3);
    });

    it("refuses a refresh with no cookie at all", async () => {
      const response = await request(server()).post("/api/auth/refresh").expect(401);
      expect(response.body.error.code).toBe("AUTH_UNAUTHENTICATED");
    });

    it("returns the caller from /auth/me", async () => {
      const response = await api(harness.app, admin)
        .get("/auth/me")
        .expect(200);

      expect(response.body.email).toBe("admin@zycount.test");
      expect(response.body.roles).toContain("SuperAdmin");
    });
  });

  describe("access control", () => {
    it("refuses an unauthenticated request", async () => {
      const response = await request(server()).get(`/api/companies/${companyId}/journals`).expect(401);
      expect(response.body.error.code).toBe("AUTH_UNAUTHENTICATED");
    });

    it("refuses a forged token", async () => {
      const response = await request(server())
        .get(`/api/companies/${companyId}/journals`)
        .set("Authorization", "Bearer not.a.real.token")
        .expect(401);

      expect(response.body.error.code).toBe("AUTH_TOKEN_INVALID");
    });

    it("refuses a company the caller was not granted", async () => {
      const stranger = "00000000-0000-0000-0000-000000000000";
      const response = await api(harness.app, admin, stranger)
        .get(`/companies/${stranger}/journals`)
        .expect(403);

      expect(response.body.error.code).toBe("COMPANY_ACCESS_DENIED");
    });

    it("requires a company context on company-scoped routes", async () => {
      const response = await request(server())
        .get(`/api/companies/${companyId}/accounts`)
        .set("Authorization", `Bearer ${admin.token}`)
        .expect(200);

      // The :companyId path parameter is itself a valid company context.
      expect(Array.isArray(response.body)).toBe(true);
    });
  });

  describe("the role matrix is enforced, not merely displayed", () => {
    it("stops a read-only user writing anything", async () => {
      const viewer = await login(harness.app, "viewer@zycount.test");
      const client = api(harness.app, viewer, companyId);

      const accounts = (await client.get(`/companies/${companyId}/accounts?postableOnly=true`).expect(200)).body;

      const create = await client
        .post(`/companies/${companyId}/journals`, {
          date: "2026-05-04",
          description: "Read-only attempt",
          lines: [
            { accountId: accounts[0].id, debit: "10.00", credit: "0" },
            { accountId: accounts[1].id, debit: "0", credit: "10.00" },
          ],
        })
        .expect(403);

      expect(create.body.error.code).toBe("PERMISSION_DENIED");

      // …but reporting still works, which is the whole point of the role.
      await client.get(`/companies/${companyId}/reports/trial-balance?dateTo=2026-05-31`).expect(200);
    });

    it("stops an accountant closing a period", async () => {
      const accountant = await login(harness.app, "accountant@zycount.test");
      const client = api(harness.app, accountant, companyId);

      const periods = (await client.get(`/companies/${companyId}/fiscal-periods`).expect(200)).body;
      const open = periods.find((period: { status: string }) => period.status === "OPEN");

      const response = await client
        .post(`/companies/${companyId}/fiscal-periods/${open.id}/close`, {})
        .expect(403);

      expect(response.body.error.code).toBe("PERMISSION_DENIED");
      expect(response.body.error.message).toContain("administrator");
    });

    it("lets a finance manager close and reopen, and audits both", async () => {
      const manager = await login(harness.app, "manager@zycount.test");
      const client = api(harness.app, manager, companyId);

      const periods = (await client.get(`/companies/${companyId}/fiscal-periods`).expect(200)).body;
      // Pick a late, empty period so closing it disturbs nothing.
      const target = periods.filter((p: { journalCount: number }) => p.journalCount === 0).at(-1);

      const closed = (
        await client.post(`/companies/${companyId}/fiscal-periods/${target.id}/close`, {}).expect(200)
      ).body;
      expect(closed.status).toBe("CLOSED");

      const reopened = (
        await client
          .post(`/companies/${companyId}/fiscal-periods/${target.id}/reopen`, {
            reason: "Reopened by the integration suite to verify the audit trail",
          })
          .expect(200)
      ).body;
      expect(reopened.status).toBe("OPEN");

      const audit = (
        await api(harness.app, admin, companyId)
          .get(`/audit-log/FiscalPeriod/${target.id}`)
          .expect(200)
      ).body;

      const actions = audit.map((entry: { action: string }) => entry.action);
      expect(actions).toContain("period.close");
      expect(actions).toContain("period.reopen");

      const reopen = audit.find((entry: { action: string }) => entry.action === "period.reopen");
      expect(reopen.metadata.reason).toContain("integration suite");
      expect(reopen.userId).toBe(manager.user.id);
    });

    it("keeps the audit log away from users without the permission", async () => {
      const accountant = await login(harness.app, "accountant@zycount.test");
      const response = await api(harness.app, accountant, companyId).get("/audit-log").expect(403);
      expect(response.body.error.code).toBe("PERMISSION_DENIED");
    });

    it("lets an auditor read the audit log but change nothing", async () => {
      const auditor = await login(harness.app, "auditor@zycount.test");
      const client = api(harness.app, auditor, companyId);

      await client.get("/audit-log").expect(200);

      const response = await client
        .post(`/companies/${companyId}/accounts`, { code: "9999", name: "Auditor attempt", type: "ASSET" })
        .expect(403);

      expect(response.body.error.code).toBe("PERMISSION_DENIED");
    });
  });

  describe("account safety rails", () => {
    it("deletes an unused account outright", async () => {
      const client = api(harness.app, admin, companyId);

      const created = (
        await client
          .post(`/companies/${companyId}/accounts`, {
            code: "1399-TMP",
            name: "Temporary unused account",
            type: "ASSET",
            subType: "CURRENT_ASSET",
          })
          .expect(201)
      ).body;

      const response = await client.delete(`/companies/${companyId}/accounts/${created.id}`).expect(200);
      expect(response.body).toEqual({ deleted: true, archived: false });
    });

    it("archives rather than deletes an account that carries postings", async () => {
      const client = api(harness.app, admin, companyId);
      const accounts = (await client.get(`/companies/${companyId}/accounts`).expect(200)).body;

      // 1545 (accumulated depreciation) is posted to by the seed but is not a
      // system account, so deletion falls through to the archive path.
      const inUse = accounts.find((a: { code: string }) => a.code === "1545");

      const response = await client.delete(`/companies/${companyId}/accounts/${inUse.id}`).expect(200);
      expect(response.body).toEqual({ deleted: false, archived: true });

      // Restore it so the suite stays re-runnable.
      await client.patch(`/companies/${companyId}/accounts/${inUse.id}`, { isActive: true }).expect(200);
    });

    it("refuses to delete an account that still has children", async () => {
      const client = api(harness.app, admin, companyId);

      const parent = (
        await client
          .post(`/companies/${companyId}/accounts`, {
            code: "1398-TMP",
            name: "Temporary heading",
            type: "ASSET",
            subType: "CURRENT_ASSET",
          })
          .expect(201)
      ).body;

      const child = (
        await client
          .post(`/companies/${companyId}/accounts`, {
            code: "1398-TMP-A",
            name: "Temporary child",
            type: "ASSET",
            subType: "CURRENT_ASSET",
            parentId: parent.id,
          })
          .expect(201)
      ).body;

      const refused = await client.delete(`/companies/${companyId}/accounts/${parent.id}`).expect(409);
      expect(refused.body.error.code).toBe("ACCOUNT_HAS_CHILDREN");

      // Gaining a child also stops the parent taking postings of its own.
      const reloaded = (await client.get(`/companies/${companyId}/accounts/${parent.id}`).expect(200)).body;
      expect(reloaded.isPostable).toBe(false);

      await client.delete(`/companies/${companyId}/accounts/${child.id}`).expect(200);
      await client.delete(`/companies/${companyId}/accounts/${parent.id}`).expect(200);
    });

    it("refuses to delete a system account the posting rules depend on", async () => {
      const client = api(harness.app, admin, companyId);
      const accounts = (await client.get(`/companies/${companyId}/accounts`).expect(200)).body;
      const system = accounts.find((a: { code: string }) => a.code === "1150");

      const response = await client.delete(`/companies/${companyId}/accounts/${system.id}`).expect(409);
      expect(response.body.error.code).toBe("ACCOUNT_IN_USE");
      expect(response.body.error.message).toContain("system account");
    });

    it("refuses a parent of a different account type", async () => {
      const client = api(harness.app, admin, companyId);
      const accounts = (await client.get(`/companies/${companyId}/accounts`).expect(200)).body;
      const revenueHeading = accounts.find((a: { code: string }) => a.code === "4100");

      const response = await client
        .post(`/companies/${companyId}/accounts`, {
          code: "1399",
          name: "Wrongly parented asset",
          type: "ASSET",
          parentId: revenueHeading.id,
        })
        .expect(422);

      expect(response.body.error.code).toBe("ACCOUNT_TYPE_MISMATCH");
    });

    it("refuses to change the type of an account already in use", async () => {
      const client = api(harness.app, admin, companyId);
      const accounts = (await client.get(`/companies/${companyId}/accounts`).expect(200)).body;
      const inUse = accounts.find((a: { code: string }) => a.code === "1150");

      const response = await client
        .patch(`/companies/${companyId}/accounts/${inUse.id}`, { type: "EXPENSE" })
        .expect(409);

      expect(response.body.error.code).toBe("ACCOUNT_IN_USE");
    });
  });
});
