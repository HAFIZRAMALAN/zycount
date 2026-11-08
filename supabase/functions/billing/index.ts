// Zycount subscriptions: takes payment for a plan through Billplz, ToyyibPay or
// Stripe, and checks API keys stored in the platform key register.
//
// Keys never reach the browser. They are read here with the service role from
// Vault (public._platform_secret), falling back to an Edge Function secret of
// the same name. In sandbox mode NAME_SANDBOX wins over NAME, in live mode
// NAME_LIVE wins over NAME, so test and live keys can sit side by side.
//
// Browser actions (POST JSON with the user's session):
//   { action: "checkout", company_id, plan, cycle }   → { url, payment_id }
//   { action: "verify", payment_id }                  → { status }
//   { action: "test", target }                        → { ok, detail }   (platform admin)
// Gateway callbacks (no session; deployed with verify_jwt = false):
//   POST ?hook=billplz | ?hook=toyyibpay | ?hook=stripe
// Every callback is confirmed by asking the gateway for the bill itself before
// anything is marked paid, and the amount must match to the cent.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { encodeHex } from "jsr:@std/encoding@1/hex";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
class Stop extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const dbError = (e: { message?: string }) => {
  const m = /^([A-Z_]+):\s*(.*)$/s.exec(e.message || "");
  const code = m ? m[1] : "ERROR";
  return new Stop(code === "NOT_FOUND" ? 404 : code === "PERMISSION_DENIED" ? 403 : 400, code, m ? m[2] : (e.message || "Something went wrong."));
};

type Mode = "SANDBOX" | "LIVE";
const BASE = {
  BILLPLZ: { SANDBOX: "https://www.billplz-sandbox.com/api/v3", LIVE: "https://www.billplz.com/api/v3" },
  TOYYIBPAY: { SANDBOX: "https://dev.toyyibpay.com", LIVE: "https://toyyibpay.com" },
};
const cents = (n: unknown) => Math.round(Number(n) * 100);
const isId = (x: unknown) => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x);
const form = (o: Record<string, string | number | undefined | null>) => {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) f.set(k, String(v));
  return f;
};

async function secret(admin: SupabaseClient, name: string, mode?: Mode): Promise<string | null> {
  for (const n of mode ? [`${name}_${mode}`, name] : [name]) {
    const { data } = await admin.rpc("_platform_secret", { p_name: n });
    if (typeof data === "string" && data) return data;
  }
  for (const n of mode ? [`${name}_${mode}`, name] : [name]) {
    const e = Deno.env.get(n);
    if (e) return e;
  }
  return null;
}
async function need(admin: SupabaseClient, name: string, mode?: Mode) {
  const v = await secret(admin, name, mode);
  if (!v) throw new Stop(503, "BILLING_NOT_CONFIGURED", `${name} isn't set. A Zycount administrator adds it in Admin console → Keys & payments.`);
  return v;
}

async function hmacHex(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return encodeHex(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg))));
}
const sameText = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
async function getJson(r: Response) {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t.slice(0, 500) }; }
}

// ── Gateways ───────────────────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
type Pay = any;
interface Created { ref: string; url: string }
interface Checked { paid: boolean; amount: number | null; closed: boolean; raw: unknown }

const billplz = {
  auth: async (admin: SupabaseClient, mode: Mode) => "Basic " + btoa((await need(admin, "BILLPLZ_API_KEY", mode)) + ":"),
  async create(admin: SupabaseClient, p: Pay, urls: { back: string; hook: string }): Promise<Created> {
    const mode = p.mode as Mode;
    const r = await fetch(`${BASE.BILLPLZ[mode]}/bills`, {
      method: "POST", headers: { Authorization: await billplz.auth(admin, mode) },
      body: form({
        collection_id: await need(admin, "BILLPLZ_COLLECTION_ID", mode), email: p.email, name: String(p.payer_name).slice(0, 255),
        amount: cents(p.amount), callback_url: urls.hook, redirect_url: urls.back,
        description: `Zycount ${p.plan_name} (${p.billing_cycle === "YEAR" ? "yearly" : "monthly"}) — ${p.company_name}`.slice(0, 200),
        reference_1_label: "Payment", reference_1: p.payment_id,
      }),
    });
    const j = await getJson(r);
    if (!r.ok || !j.id) throw new Stop(502, "GATEWAY", `Billplz refused the bill: ${JSON.stringify(j.error || j).slice(0, 200)}`);
    return { ref: j.id, url: j.url };
  },
  async check(admin: SupabaseClient, mode: Mode, ref: string): Promise<Checked> {
    const r = await fetch(`${BASE.BILLPLZ[mode]}/bills/${encodeURIComponent(ref)}`, { headers: { Authorization: await billplz.auth(admin, mode) } });
    const j = await getJson(r);
    if (!r.ok) throw new Stop(502, "GATEWAY", "Billplz didn't answer about this bill.");
    return { paid: j.paid === true, amount: j.paid ? Number(j.paid_amount ?? j.amount) / 100 : null, closed: j.state === "deleted", raw: j };
  },
  async test(admin: SupabaseClient, mode: Mode) {
    const id = await need(admin, "BILLPLZ_COLLECTION_ID", mode);
    const r = await fetch(`${BASE.BILLPLZ[mode]}/collections/${encodeURIComponent(id)}`, { headers: { Authorization: await billplz.auth(admin, mode) } });
    const j = await getJson(r);
    if (!r.ok) throw new Stop(400, "KEY_INVALID", `Billplz ${mode.toLowerCase()} refused the key or collection (${r.status}).`);
    return `Billplz ${mode.toLowerCase()} OK — collection “${j.title || id}”.`;
  },
  // Callback body: form fields signed with the X Signature key.
  async verifySignature(admin: SupabaseClient, mode: Mode, f: URLSearchParams) {
    const key = await secret(admin, "BILLPLZ_X_SIGNATURE_KEY", mode);
    if (!key) return true; // without the key we still confirm with Billplz's API below
    const sig = f.get("x_signature") || "";
    const src = [...f.entries()].filter(([k]) => k !== "x_signature").map(([k, v]) => `${k}${v}`)
      .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0)).join("|");
    return sameText(await hmacHex(key, src), sig);
  },
};

const toyyib = {
  async create(admin: SupabaseClient, p: Pay, urls: { back: string; hook: string }): Promise<Created> {
    const mode = p.mode as Mode;
    const clean = (s: string, n: number) => s.replace(/[^A-Za-z0-9 _]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
    const r = await fetch(`${BASE.TOYYIBPAY[mode]}/index.php/api/createBill`, {
      method: "POST",
      body: form({
        userSecretKey: await need(admin, "TOYYIBPAY_SECRET_KEY", mode), categoryCode: await need(admin, "TOYYIBPAY_CATEGORY_CODE", mode),
        billName: clean(`Zycount ${p.plan_name}`, 30),
        billDescription: clean(`Zycount ${p.plan_name} ${p.billing_cycle === "YEAR" ? "yearly" : "monthly"} for ${p.company_name}`, 100),
        billPriceSetting: 1, billPayorInfo: 1, billAmount: cents(p.amount), billReturnUrl: urls.back, billCallbackUrl: urls.hook,
        billExternalReferenceNo: p.payment_id, billTo: String(p.payer_name).slice(0, 100), billEmail: p.email,
        billPhone: String(p.phone || "").replace(/\D/g, "") || "0000000000", billPaymentChannel: "2", billChargeToCustomer: "",
      }),
    });
    const j = await getJson(r);
    const code = Array.isArray(j) && j[0] && j[0].BillCode;
    if (!code) throw new Stop(502, "GATEWAY", `ToyyibPay refused the bill: ${JSON.stringify(j).slice(0, 200)}`);
    return { ref: code, url: `${BASE.TOYYIBPAY[mode]}/${code}` };
  },
  async check(_admin: SupabaseClient, mode: Mode, ref: string): Promise<Checked> {
    const r = await fetch(`${BASE.TOYYIBPAY[mode]}/index.php/api/getBillTransactions`, {
      method: "POST", body: form({ billCode: ref, billpaymentStatus: 1 }),
    });
    const j = await getJson(r);
    const hit = Array.isArray(j) ? j.find((t: Pay) => String(t.billpaymentStatus) === "1") : null;
    return { paid: !!hit, amount: hit ? Number(hit.billpaymentAmount) : null, closed: false, raw: j };
  },
  async test(admin: SupabaseClient, mode: Mode) {
    const r = await fetch(`${BASE.TOYYIBPAY[mode]}/index.php/api/getCategoryDetails`, {
      method: "POST",
      body: form({ userSecretKey: await need(admin, "TOYYIBPAY_SECRET_KEY", mode), categoryCode: await need(admin, "TOYYIBPAY_CATEGORY_CODE", mode) }),
    });
    const j = await getJson(r);
    const cat = Array.isArray(j) ? j[0] : null;
    if (!r.ok || !cat || !cat.categoryName) throw new Stop(400, "KEY_INVALID", `ToyyibPay ${mode.toLowerCase()} refused the secret key or category code.`);
    return `ToyyibPay ${mode.toLowerCase()} OK — category “${cat.categoryName}”.`;
  },
};

const stripe = {
  async call(admin: SupabaseClient, mode: Mode, path: string, body?: URLSearchParams) {
    const r = await fetch(`https://api.stripe.com/v1${path}`, {
      method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${await need(admin, "STRIPE_SECRET_KEY", mode)}` }, body,
    });
    return { r, j: await getJson(r) };
  },
  async create(admin: SupabaseClient, p: Pay, urls: { back: string; cancel: string }): Promise<Created> {
    const { r, j } = await stripe.call(admin, p.mode, "/checkout/sessions", form({
      mode: "payment", success_url: urls.back, cancel_url: urls.cancel, client_reference_id: p.payment_id, customer_email: p.email,
      "metadata[payment_id]": p.payment_id, "line_items[0][quantity]": 1, "line_items[0][price_data][currency]": "myr",
      "line_items[0][price_data][unit_amount]": cents(p.amount),
      "line_items[0][price_data][product_data][name]": `Zycount ${p.plan_name} — ${p.billing_cycle === "YEAR" ? "yearly" : "monthly"}`,
      "line_items[0][price_data][product_data][description]": String(p.company_name).slice(0, 200),
    }));
    if (!r.ok || !j.url) throw new Stop(502, "GATEWAY", `Stripe refused the checkout: ${(j.error && j.error.message) || r.status}`);
    return { ref: j.id, url: j.url };
  },
  async check(admin: SupabaseClient, mode: Mode, ref: string): Promise<Checked> {
    const { r, j } = await stripe.call(admin, mode, `/checkout/sessions/${encodeURIComponent(ref)}`);
    if (!r.ok) throw new Stop(502, "GATEWAY", "Stripe didn't answer about this checkout.");
    return { paid: j.payment_status === "paid", amount: j.payment_status === "paid" ? Number(j.amount_total) / 100 : null, closed: j.status === "expired", raw: { id: j.id, status: j.status, payment_status: j.payment_status, amount_total: j.amount_total } };
  },
  async test(admin: SupabaseClient, mode: Mode) {
    const { r, j } = await stripe.call(admin, mode, "/balance");
    if (!r.ok) throw new Stop(400, "KEY_INVALID", `Stripe refused the key: ${(j.error && j.error.message) || r.status}`);
    return `Stripe OK — ${j.livemode ? "live" : "test"} mode key.`;
  },
  async verifySignature(admin: SupabaseClient, raw: string, header: string | null) {
    const key = (await secret(admin, "STRIPE_WEBHOOK_SECRET", "LIVE")) || (await secret(admin, "STRIPE_WEBHOOK_SECRET", "SANDBOX"));
    if (!key) return true; // confirmed with Stripe's API below either way
    const parts = Object.fromEntries(String(header || "").split(",").map((x) => x.split("=") as [string, string]).filter((x) => x.length === 2 && x[0] === "t"));
    const sigs = String(header || "").split(",").filter((x) => x.startsWith("v1=")).map((x) => x.slice(3));
    const t = Number(parts.t);
    if (!t || Math.abs(Date.now() / 1000 - t) > 600) return false;
    const want = await hmacHex(key, `${t}.${raw}`);
    return sigs.some((s) => sameText(s, want));
  },
};

const GATEWAYS = { BILLPLZ: billplz, TOYYIBPAY: toyyib, STRIPE: stripe } as const;

/** Asks the gateway about a payment and records the answer. */
async function settle(admin: SupabaseClient, pay: Pay) {
  if (!pay || pay.status !== "PENDING" || !pay.gateway_ref) return { status: pay ? pay.status : "UNKNOWN" };
  const g = GATEWAYS[pay.gateway as keyof typeof GATEWAYS];
  if (!g) return { status: pay.status };
  const c = await g.check(admin, pay.mode, pay.gateway_ref);
  if (c.paid) {
    const { data, error } = await admin.rpc("_billing_mark_paid", { p_payment: pay.id, p_amount: c.amount, p_raw: c.raw });
    if (error) throw dbError(error);
    return { status: "PAID", period_end: data && data.period_end };
  }
  if (c.closed) {
    await admin.rpc("_billing_mark_failed", { p_payment: pay.id, p_status: "CANCELLED", p_raw: c.raw });
    return { status: "CANCELLED" };
  }
  return { status: "PENDING" };
}

// ── Gateway callbacks ──────────────────────────────────────────────────────
async function hook(kind: string, req: Request, admin: SupabaseClient) {
  const raw = await req.text();
  try {
    if (kind === "billplz") {
      const f = new URLSearchParams(raw);
      const { data: pay } = await admin.rpc("_billing_payment_by_ref", { p_gateway: "BILLPLZ", p_ref: f.get("id") || "" });
      if (!pay) return new Response("unknown bill", { status: 404 });
      if (!(await billplz.verifySignature(admin, pay.mode, f))) return new Response("bad signature", { status: 401 });
      await settle(admin, pay);
    } else if (kind === "toyyibpay") {
      const f = new URLSearchParams(raw);
      const { data: pay } = await admin.rpc("_billing_payment_by_ref", { p_gateway: "TOYYIBPAY", p_ref: f.get("billcode") || "" });
      if (!pay) return new Response("unknown bill", { status: 404 });
      await settle(admin, pay);
    } else if (kind === "stripe") {
      if (!(await stripe.verifySignature(admin, raw, req.headers.get("stripe-signature")))) return new Response("bad signature", { status: 401 });
      const ev = JSON.parse(raw || "{}");
      const obj = ev && ev.data && ev.data.object;
      if (obj && obj.object === "checkout.session") {
        const { data: pay } = await admin.rpc("_billing_payment_by_ref", { p_gateway: "STRIPE", p_ref: obj.id });
        if (pay) await settle(admin, pay);
      }
    } else {
      return new Response("unknown hook", { status: 404 });
    }
    return new Response("OK", { status: 200 });
  } catch (e) {
    console.error("billing hook", kind, e);
    return new Response("error", { status: 500 }); // the gateway retries
  }
}

// ── Handler ────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail(405, "VALIDATION", "Use POST.");
  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const self = `${url}/functions/v1/billing`;

  const kind = new URL(req.url).searchParams.get("hook");
  if (kind) return hook(kind, req, admin);

  const auth = req.headers.get("Authorization");
  if (!auth) return fail(401, "AUTH", "Sign in again.");
  const sb = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "", {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data: who } = await sb.auth.getUser();
  if (!who?.user) return fail(401, "AUTH", "Sign in again.");
  // deno-lint-ignore no-explicit-any
  let input: any = {};
  try { input = await req.json(); } catch { /* handled below */ }

  try {
    switch (input.action) {
      case "checkout": {
        if (!isId(input.company_id)) throw new Stop(400, "VALIDATION", "Which books?");
        const { data: p, error } = await sb.rpc("billing_begin", { p_company: input.company_id, p_plan: input.plan, p_cycle: input.cycle });
        if (error) throw dbError(error);
        const appUrl = String(p.app_url || "");
        if (!/^https?:\/\/[^ ]+\/app\.html$/.test(appUrl)) throw new Stop(503, "BILLING_NOT_CONFIGURED", "The app address isn't set in Keys & payments.");
        const back = `${appUrl}?zpay=${p.payment_id}#billing`;
        const g = GATEWAYS[p.gateway as keyof typeof GATEWAYS];
        if (!g) throw new Stop(503, "BILLING_NOT_CONFIGURED", "Choose a payment gateway in Keys & payments.");
        let made: Created;
        try {
          made = await g.create(admin, p, { back, cancel: `${appUrl}?zpay=${p.payment_id}&zcancel=1#billing`, hook: `${self}?hook=${p.gateway.toLowerCase()}` });
        } catch (e) {
          await admin.rpc("_billing_mark_failed", { p_payment: p.payment_id, p_status: "FAILED", p_raw: { error: String((e as Error).message) } });
          throw e;
        }
        await admin.rpc("_billing_attach", { p_payment: p.payment_id, p_ref: made.ref, p_url: made.url });
        return reply(200, { url: made.url, payment_id: p.payment_id, gateway: p.gateway, mode: p.mode });
      }
      case "verify": {
        if (!isId(input.payment_id)) throw new Stop(400, "VALIDATION", "Which payment?");
        const { error } = await sb.rpc("billing_payment_access", { p_payment: input.payment_id });
        if (error) throw dbError(error);
        const { data: pay } = await admin.rpc("_billing_payment", { p_payment: input.payment_id });
        if (input.cancelled && pay && pay.status === "PENDING") {
          const r = await settle(admin, pay); // a payment can still complete after "cancel" on some gateways
          if (r.status === "PENDING") {
            await admin.rpc("_billing_mark_failed", { p_payment: pay.id, p_status: "CANCELLED", p_raw: { by: "user" } });
            return reply(200, { status: "CANCELLED" });
          }
          return reply(200, r);
        }
        return reply(200, await settle(admin, pay));
      }
      case "test": {
        const { data: isAdmin } = await sb.rpc("is_platform_admin");
        if (!isAdmin) throw new Stop(403, "PERMISSION_DENIED", "Only Zycount administrators can test keys.");
        const mode: Mode = input.mode === "LIVE" ? "LIVE" : "SANDBOX";
        let detail = "";
        if (input.target === "ANTHROPIC") {
          const key = await need(admin, "ANTHROPIC_API_KEY");
          const r = await fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
          if (!r.ok) throw new Stop(400, "KEY_INVALID", `Anthropic refused the key (${r.status}).`);
          detail = "Anthropic OK — receipt reading is on.";
        } else if (input.target in GATEWAYS) {
          detail = await GATEWAYS[input.target as keyof typeof GATEWAYS].test(admin, mode);
        } else throw new Stop(400, "VALIDATION", "What should be tested?");
        return reply(200, { ok: true, detail });
      }
      default:
        throw new Stop(400, "VALIDATION", "Unknown action.");
    }
  } catch (e) {
    if (e instanceof Stop) return fail(e.status, e.code, e.message);
    console.error("billing", e);
    return fail(500, "ERROR", "Something went wrong talking to the payment service. Nothing was charged by Zycount.");
  }
});
