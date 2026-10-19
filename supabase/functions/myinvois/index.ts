// Sends invoices, cash sales, credit notes and debit notes to LHDN MyInvois as UBL 2.1
// JSON (document version 1.0), and checks, cancels and validates TINs.
//
// The caller's own session is used first (einvoice_payload / einvoice_*_access) so the
// books' roles decide who may submit or cancel. Only then does the function use the
// service role, to read the taxpayer's MyInvois client secret from Vault, cache the
// one-hour access token and record LHDN's answer.
//
// Actions (POST JSON): { action: "submit" | "status" | "cancel", doc_id, reason? }
//                      { action: "validate_tin", contact_id }
//                      { action: "test", company_id }
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { encodeHex } from "jsr:@std/encoding@1/hex";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const HOSTS: Record<string, { api: string; portal: string }> = {
  SANDBOX: { api: "https://preprod-api.myinvois.hasil.gov.my", portal: "https://preprod.myinvois.hasil.gov.my" },
  PRODUCTION: { api: "https://api.myinvois.hasil.gov.my", portal: "https://myinvois.hasil.gov.my" },
};

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  reply(status, { error: { code, message, ...extra } });
class Stop extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}
const dbError = (e: { message?: string }) => {
  const m = /^([A-Z_]+):\s*(.*)$/s.exec(e.message || "");
  return new Stop(m && m[1] === "NOT_FOUND" ? 404 : m && m[1] === "PERMISSION_DENIED" ? 403 : 400, m ? m[1] : "ERROR", m ? m[2] : (e.message || "Something went wrong."));
};

// ── UBL JSON helpers ───────────────────────────────────────────────────────
const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const v = (x: unknown, attrs: Record<string, unknown> = {}) => [{ _: x, ...attrs }];
const amt = (n: unknown) => [{ _: r2(n), currencyID: "MYR" }];
const OTH = [{ ID: v("OTH", { schemeID: "UN/ECE 5153", schemeAgencyID: "6" }) }];
const STATE: Record<string, string> = {
  johor: "01", kedah: "02", kelantan: "03", melaka: "04", malacca: "04", "negeri sembilan": "05", pahang: "06", "pulau pinang": "07",
  penang: "07", perak: "08", perlis: "09", selangor: "10", terengganu: "11", sabah: "12", sarawak: "13", "wp kuala lumpur": "14",
  "kuala lumpur": "14", "wp labuan": "15", labuan: "15", "wp putrajaya": "16", putrajaya: "16",
};
const ISO3: Record<string, string> = {
  MY: "MYS", SG: "SGP", ID: "IDN", TH: "THA", BN: "BRN", PH: "PHL", VN: "VNM", CN: "CHN", HK: "HKG", TW: "TWN", JP: "JPN", KR: "KOR",
  IN: "IND", AU: "AUS", NZ: "NZL", GB: "GBR", US: "USA", CA: "CAN", DE: "DEU", FR: "FRA", NL: "NLD", AE: "ARE", SA: "SAU",
};
const UNIT: Record<string, string> = {
  UNIT: "C62", UNITS: "C62", PCS: "C62", PC: "C62", EA: "C62", NOS: "C62", SET: "SET", HR: "HUR", HRS: "HUR", HOUR: "HUR",
  DAY: "DAY", DAYS: "DAY", MONTH: "MON", MTH: "MON", KG: "KGM", G: "GRM", L: "LTR", LTR: "LTR", M: "MTR", BOX: "BX", PKT: "PA",
};
const stateCode = (s?: string | null) => STATE[String(s || "").trim().toLowerCase()] || "17";
const country3 = (c?: string | null) => { const k = String(c || "MY").trim().toUpperCase(); return ISO3[k] || (k.length === 3 ? k : "MYS"); };
const lines3 = (addr?: string | null) => {
  const parts = String(addr || "").split(/\r?\n|,(?=\s)/).map((s) => s.trim()).filter(Boolean);
  const out = parts.length > 3 ? [parts[0], parts[1], parts.slice(2).join(", ")] : parts;
  return (out.length ? out : ["NA"]).map((l) => ({ Line: v(l.slice(0, 150)) }));
};
const address = (addr: string | null | undefined, city: string | null | undefined, postcode: string | null | undefined, state: string, country: string) => [{
  CityName: v(city || "NA"), ...(postcode ? { PostalZone: v(postcode) } : {}), CountrySubentityCode: v(state),
  AddressLine: lines3(addr), Country: [{ IdentificationCode: v(country, { listID: "ISO3166-1", listAgencyID: "6" }) }],
}];
const ids = (pairs: [string, string | null | undefined][]) => pairs.map(([scheme, value]) => ({ ID: v(value || "NA", { schemeID: scheme }) }));

// deno-lint-ignore no-explicit-any
function buildDocument(p: any) {
  const d = p.doc, s = p.supplier, b = p.buyer;
  const now = new Date().toISOString();
  // Buyer: a customer with a TIN, or LHDN's general-public / foreign-buyer TINs.
  let buyerTin: string, buyerIdScheme = "BRN", buyerId: string = "NA", buyerName: string;
  if (!b) { buyerTin = "EI00000000010"; buyerName = d.bill_name || "General Public"; }
  else {
    const foreign = String(b.country || "MY").toUpperCase() !== "MY";
    buyerName = b.name;
    buyerTin = b.tin || (foreign ? "EI00000000020" : "EI00000000010");
    if (b.reg_no) { buyerId = b.reg_no; buyerIdScheme = ["BRN", "NRIC", "PASSPORT", "ARMY"].includes(String(b.id_type || "").toUpperCase()) ? String(b.id_type).toUpperCase() : "BRN"; }
  }
  // deno-lint-ignore no-explicit-any
  const lines = (p.lines as any[]).map((l) => {
    const type = l.tax_type || (Number(l.tax_rate) > 0 ? "02" : "06");
    const qty = Number(l.qty) || 1;
    const simple = !d.tax_inclusive && !Number(l.discount);
    return {
      ID: v(String(l.line_no)),
      InvoicedQuantity: v(qty, { unitCode: UNIT[String(l.uom || "").toUpperCase()] || "C62" }),
      LineExtensionAmount: amt(l.amount),
      TaxTotal: [{
        TaxAmount: amt(l.tax_amount),
        TaxSubtotal: [{
          TaxableAmount: amt(l.amount), TaxAmount: amt(l.tax_amount), Percent: v(Number(l.tax_rate) || 0),
          TaxCategory: [{ ID: v(type), ...(type === "E" ? { TaxExemptionReason: v("Exempted under the Sales Tax / Service Tax Act") } : {}), TaxScheme: OTH }],
        }],
      }],
      Item: [{ CommodityClassification: [{ ItemClassificationCode: v(l.classification || "022", { listID: "CLASS" }) }], Description: v(String(l.description).slice(0, 300)) }],
      Price: [{ PriceAmount: [{ _: simple ? Number(l.unit_price) : Math.round((Number(l.amount) / qty) * 10000) / 10000, currencyID: "MYR" }] }],
      ItemPriceExtension: [{ Amount: amt(l.amount) }],
    };
  });
  // deno-lint-ignore no-explicit-any
  const byType = new Map<string, { taxable: number; tax: number }>();
  // deno-lint-ignore no-explicit-any
  (p.lines as any[]).forEach((l) => {
    const type = l.tax_type || (Number(l.tax_rate) > 0 ? "02" : "06");
    const g = byType.get(type) || { taxable: 0, tax: 0 };
    g.taxable += Number(l.amount) || 0; g.tax += Number(l.tax_amount) || 0; byType.set(type, g);
  });
  const invoice: Record<string, unknown> = {
    ID: v(String(d.doc_no).slice(0, 50)),
    IssueDate: v(now.slice(0, 10)),
    IssueTime: v(now.slice(11, 19) + "Z"),
    InvoiceTypeCode: v(p.type, { listVersionID: "1.0" }),
    DocumentCurrencyCode: v("MYR"),
    TaxCurrencyCode: v("MYR"),
    ...(p.original ? { BillingReference: [{ InvoiceDocumentReference: [{ ID: v(p.original.doc_no), UUID: v(p.original.uuid) }] }] }
      : d.reference ? { BillingReference: [{ AdditionalDocumentReference: [{ ID: v(String(d.reference).slice(0, 150)) }] }] } : {}),
    AccountingSupplierParty: [{
      Party: [{
        IndustryClassificationCode: v(s.msic, { name: s.activity }),
        PartyIdentification: ids([["TIN", s.tin], ["BRN", s.brn], ["SST", s.sst], ["TTX", s.ttx]]),
        PostalAddress: address(s.address, s.city, s.postcode, s.state, "MYS"),
        PartyLegalEntity: [{ RegistrationName: v(s.name) }],
        Contact: [{ Telephone: v(s.phone), ...(s.email ? { ElectronicMail: v(s.email) } : {}) }],
      }],
    }],
    AccountingCustomerParty: [{
      Party: [{
        PostalAddress: b ? address(b.address, b.city, b.postcode, stateCode(b.state), country3(b.country)) : address(null, null, null, "17", "MYS"),
        PartyLegalEntity: [{ RegistrationName: v(buyerName) }],
        PartyIdentification: ids([["TIN", buyerTin], [buyerIdScheme, buyerId], ["SST", b && b.sst_no], ["TTX", null]]),
        Contact: [{ Telephone: v((b && b.phone) || "NA"), ...(b && b.email ? { ElectronicMail: v(b.email) } : {}) }],
      }],
    }],
    ...(d.terms_days != null && p.type === "01" && d.doc_type === "INVOICE" ? { PaymentTerms: [{ Note: v(d.terms_days ? `Net ${d.terms_days} days` : "Cash") }] } : {}),
    TaxTotal: [{
      TaxAmount: amt(d.tax_total),
      TaxSubtotal: [...byType.entries()].map(([type, g]) => ({
        TaxableAmount: amt(g.taxable), TaxAmount: amt(g.tax), TaxCategory: [{ ID: v(type), TaxScheme: OTH }],
      })),
    }],
    LegalMonetaryTotal: [{
      LineExtensionAmount: amt(d.subtotal), TaxExclusiveAmount: amt(d.subtotal), TaxInclusiveAmount: amt(d.total), PayableAmount: amt(d.total),
    }],
    InvoiceLine: lines,
  };
  return {
    _D: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
    _A: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
    _B: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
    Invoice: [invoice],
  };
}

// ── LHDN calls ─────────────────────────────────────────────────────────────
async function token(admin: SupabaseClient, company: string, env: string, fresh = false): Promise<string> {
  if (!fresh) {
    const { data } = await admin.from("einvoice_tokens").select("access_token,environment,expires_at").eq("company_id", company).maybeSingle();
    if (data && data.environment === env && new Date(data.expires_at).getTime() > Date.now() + 120_000) return data.access_token;
  }
  const { data: cred, error } = await admin.rpc("_einvoice_credentials", { p_company: company });
  if (error) throw dbError(error);
  if (!cred || !cred.client_id || !cred.client_secret) {
    throw new Stop(400, "EINVOICE_NOT_CONNECTED", "Connect MyInvois first — Settings → e-Invoice, with the client ID and secret from your MyInvois portal.");
  }
  const host = HOSTS[cred.environment] || HOSTS.SANDBOX;
  const res = await fetch(`${host.api}/connect/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cred.client_id, client_secret: cred.client_secret, grant_type: "client_credentials", scope: "InvoicingAPI" }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Stop(400, "EINVOICE_LOGIN", body.error === "invalid_client"
      ? `MyInvois didn't accept the client ID and secret for ${cred.environment === "PRODUCTION" ? "production" : "the sandbox"}. Check them in Settings → e-Invoice.`
      : `MyInvois login failed${body.error_description ? `: ${body.error_description}` : ""}.`);
  }
  await admin.from("einvoice_tokens").upsert({ company_id: company, environment: cred.environment, access_token: body.access_token,
    expires_at: new Date(Date.now() + (Number(body.expires_in) || 3600) * 1000).toISOString() });
  return body.access_token;
}

async function lhdn(admin: SupabaseClient, company: string, env: string, path: string, init: RequestInit = {}) {
  const host = HOSTS[env] || HOSTS.SANDBOX;
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await token(admin, company, env, attempt > 0);
    const res = await fetch(host.api + path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${tok}`, Accept: "application/json",
      "Accept-Language": "en" } });
    if (res.status === 401 && attempt === 0) continue;
    if (res.status === 429) throw new Stop(429, "BUSY", `MyInvois is busy. Try again in ${res.headers.get("Retry-After") || "a minute"}${res.headers.get("Retry-After") ? " seconds" : ""}.`);
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { message: text.slice(0, 300) }; }
    return { status: res.status, ok: res.ok, body };
  }
  throw new Stop(401, "EINVOICE_LOGIN", "MyInvois refused the login. Check the client ID and secret.");
}

// LHDN's nested errors, flattened to what a person can fix.
// deno-lint-ignore no-explicit-any
function flatErrors(e: any): { code?: string; message: string; path?: string }[] {
  if (!e) return [];
  const own = e.message || e.error ? [{ code: e.code || e.errorCode, message: String(e.message || e.error || ""), path: e.propertyPath || e.target || undefined }] : [];
  // deno-lint-ignore no-explicit-any
  const inner = (e.details || e.innerError || []).flatMap((x: any) => flatErrors(x));
  return (inner.length ? inner : own).filter((x) => x.message).slice(0, 20);
}
// deno-lint-ignore no-explicit-any
const stepErrors = (details: any) => (details?.validationResults?.validationSteps || [])
  // deno-lint-ignore no-explicit-any
  .filter((s: any) => String(s.status).toLowerCase() === "invalid").flatMap((s: any) => flatErrors(s.error).map((x) => ({ ...x, step: s.name })));

const STATUS: Record<string, string> = { valid: "VALID", invalid: "INVALID", submitted: "SUBMITTED", cancelled: "CANCELLED" };

async function readStatus(admin: SupabaseClient, company: string, env: string, uuid: string) {
  const r = await lhdn(admin, company, env, `/api/v1.0/documents/${encodeURIComponent(uuid)}/details`);
  // deno-lint-ignore no-explicit-any
  const b: any = r.body || {};
  if (!r.ok) return { status: null, errors: flatErrors(b.error || b) };
  return { status: STATUS[String(b.status || "").toLowerCase()] || "SUBMITTED", long_id: b.longId || b.longID || null, errors: stepErrors(b) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Handler ────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail(405, "VALIDATION", "Use POST.");
  const auth = req.headers.get("Authorization");
  if (!auth) return fail(401, "AUTH", "Sign in again.");
  // deno-lint-ignore no-explicit-any
  let input: any = {};
  try { input = await req.json(); } catch { /* handled below */ }
  const url = Deno.env.get("SUPABASE_URL")!;
  const sb = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "", {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: who } = await sb.auth.getUser();
  if (!who?.user) return fail(401, "AUTH", "Sign in again.");
  const uid = who.user.id;
  const isId = (x: unknown) => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x);
  const record = (doc: string, action: string, env: string, result: Record<string, unknown>) =>
    admin.rpc("_einvoice_record", { p_doc: doc, p_action: action, p_env: env, p_result: result, p_user: uid });

  try {
    switch (input.action) {
      case "submit": {
        if (!isId(input.doc_id)) throw new Stop(400, "VALIDATION", "Which document?");
        const { data: p, error } = await sb.rpc("einvoice_payload", { p_doc: input.doc_id });
        if (error) throw dbError(error);
        const { data: acc, error: e2 } = await sb.rpc("einvoice_doc_access", { p_doc: input.doc_id, p_perm: "journal.post" });
        if (e2) throw dbError(e2);
        const env = p.environment;
        const json = JSON.stringify(buildDocument(p));
        const bytes = new TextEncoder().encode(json);
        const hash = encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
        const r = await lhdn(admin, acc.company_id, env, "/api/v1.0/documentsubmissions/", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ documents: [{ format: "JSON", document: encodeBase64(bytes), documentHash: hash, codeNumber: p.doc.doc_no }] }),
        });
        // deno-lint-ignore no-explicit-any
        const b: any = r.body || {};
        if (!r.ok) {
          const errors = flatErrors(b.error || b);
          await record(input.doc_id, "SUBMIT", env, { status: "INVALID", errors });
          throw new Stop(r.status === 422 ? 409 : 400, "EINVOICE_REJECTED", errors[0]?.message || "MyInvois rejected the submission.", { errors });
        }
        const accepted = (b.acceptedDocuments || [])[0], rejected = (b.rejectedDocuments || [])[0];
        if (!accepted) {
          const errors = flatErrors(rejected?.error);
          await record(input.doc_id, "SUBMIT", env, { status: "INVALID", submission_uid: b.submissionUid || b.submissionUID, errors });
          return reply(200, { status: "INVALID", errors, environment: env });
        }
        await record(input.doc_id, "SUBMIT", env, { status: "SUBMITTED", submission_uid: b.submissionUid || b.submissionUID, uuid: accepted.uuid });
        // LHDN validates within seconds; look once or twice before answering.
        let st: { status: string | null; long_id?: string | null; errors: unknown[] } = { status: "SUBMITTED", errors: [] };
        for (const wait of [2500, 3500]) {
          await sleep(wait);
          st = await readStatus(admin, acc.company_id, env, accepted.uuid);
          if (st.status && st.status !== "SUBMITTED") break;
        }
        if (st.status) await record(input.doc_id, "STATUS", env, { status: st.status, uuid: accepted.uuid, long_id: st.long_id, errors: st.errors.length ? st.errors : null });
        return reply(200, { status: st.status || "SUBMITTED", uuid: accepted.uuid, long_id: st.long_id || null, errors: st.errors, environment: env,
          link: st.long_id ? `${(HOSTS[env] || HOSTS.SANDBOX).portal}/${accepted.uuid}/share/${st.long_id}` : null });
      }
      case "status": {
        if (!isId(input.doc_id)) throw new Stop(400, "VALIDATION", "Which document?");
        const { data: acc, error } = await sb.rpc("einvoice_doc_access", { p_doc: input.doc_id, p_perm: "journal.view" });
        if (error) throw dbError(error);
        if (!acc.uuid) throw new Stop(400, "VALIDATION", `${acc.doc_no} hasn't been sent to LHDN yet.`);
        const st = await readStatus(admin, acc.company_id, acc.environment, acc.uuid);
        await record(input.doc_id, "STATUS", acc.environment, { status: st.status, uuid: acc.uuid, long_id: st.long_id, errors: st.errors.length ? st.errors : null });
        return reply(200, { ...st, uuid: acc.uuid, environment: acc.environment,
          link: st.long_id ? `${(HOSTS[acc.environment] || HOSTS.SANDBOX).portal}/${acc.uuid}/share/${st.long_id}` : null });
      }
      case "cancel": {
        if (!isId(input.doc_id)) throw new Stop(400, "VALIDATION", "Which document?");
        const reason = String(input.reason || "").trim();
        if (!reason) throw new Stop(400, "VALIDATION", "Give LHDN a reason for cancelling.");
        const { data: acc, error } = await sb.rpc("einvoice_doc_access", { p_doc: input.doc_id, p_perm: "journal.reverse" });
        if (error) throw dbError(error);
        if (!acc.uuid) throw new Stop(400, "VALIDATION", `${acc.doc_no} hasn't been sent to LHDN.`);
        const r = await lhdn(admin, acc.company_id, acc.environment, `/api/v1.0/documents/state/${encodeURIComponent(acc.uuid)}/state`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "cancelled", reason: reason.slice(0, 300) }),
        });
        // deno-lint-ignore no-explicit-any
        const b: any = r.body || {};
        if (!r.ok) {
          const errors = flatErrors(b.error || b);
          await record(input.doc_id, "CANCEL", acc.environment, { status: null, uuid: acc.uuid, errors });
          throw new Stop(400, "EINVOICE_CANCEL", errors[0]?.message || "LHDN didn't cancel it. e-Invoices can only be cancelled within 72 hours of validation — after that, issue a credit note.", { errors });
        }
        await record(input.doc_id, "CANCEL", acc.environment, { status: "CANCELLED", uuid: acc.uuid });
        return reply(200, { status: "CANCELLED", uuid: acc.uuid });
      }
      case "validate_tin": {
        if (!isId(input.contact_id)) throw new Stop(400, "VALIDATION", "Which customer?");
        const { data: c, error } = await sb.from("contacts").select("company_id,name,tin,reg_no,id_type").eq("id", input.contact_id).maybeSingle();
        if (error || !c) throw new Stop(404, "NOT_FOUND", "Customer not found.");
        if (!c.tin) throw new Stop(400, "VALIDATION", `${c.name} has no TIN to check.`);
        if (!c.reg_no) throw new Stop(400, "VALIDATION", `Add ${c.name}'s registration or ID number so LHDN can match the TIN.`);
        const { data: acc, error: e2 } = await sb.rpc("einvoice_company_access", { p_company: c.company_id });
        if (e2) throw dbError(e2);
        const idType = ["BRN", "NRIC", "PASSPORT", "ARMY"].includes(String(c.id_type || "").toUpperCase()) ? String(c.id_type).toUpperCase() : "BRN";
        const r = await lhdn(admin, c.company_id, acc.environment,
          `/api/v1.0/taxpayer/validate/${encodeURIComponent(c.tin)}?idType=${idType}&idValue=${encodeURIComponent(c.reg_no)}`);
        return reply(200, { valid: r.status === 200, tin: c.tin, environment: acc.environment });
      }
      case "test": {
        if (!isId(input.company_id)) throw new Stop(400, "VALIDATION", "Which books?");
        const { data: acc, error } = await sb.rpc("einvoice_company_access", { p_company: input.company_id });
        if (error) throw dbError(error);
        await token(admin, input.company_id, acc.environment, true);
        return reply(200, { ok: true, environment: acc.environment });
      }
      default:
        return fail(400, "VALIDATION", "Unknown action.");
    }
  } catch (e) {
    if (e instanceof Stop) return fail(e.status, e.code, e.message, e.extra);
    console.error(e);
    return fail(502, "UPSTREAM", "MyInvois didn't answer. Try again in a moment.");
  }
});
