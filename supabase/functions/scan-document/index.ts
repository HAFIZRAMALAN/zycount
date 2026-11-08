// Reads a receipt, bill, e-Invoice, payment slip, cheque or transfer
// screenshot and returns the fields a bookkeeper would key in.
//
// Every database and storage call runs with the caller's own session, so the
// books' row-level security and roles apply: begin_attachment_scan checks the
// role and the daily allowance before anything is spent, and
// save_attachment_scan keeps the reading beside the file.
//
// Needs ANTHROPIC_API_KEY — set in Admin console → Keys & payments (Vault), or as
// an Edge Function secret (Supabase → Edge Functions → Secrets).
// Optional: ZYCOUNT_SCAN_MODEL (default claude-opus-5-5), ZYCOUNT_SCAN_EFFORT
// (default low).
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MODEL = Deno.env.get("ZYCOUNT_SCAN_MODEL") || "claude-opus-5-5";
const EFFORT = Deno.env.get("ZYCOUNT_SCAN_EFFORT") || "low";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (status: number, code: string, message: string) => reply(status, { error: { code, message } });

const str = { type: "string" };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["document_type", "direction", "counterparty", "doc_no", "date", "due_date", "currency", "payment_method",
    "payment_reference", "bank_name", "subtotal", "discount", "tax_total", "rounding", "total", "tax_type", "tax_rate",
    "einvoice_uuid", "lines", "references_paid", "suggested_account_code", "summary", "confidence", "warnings"],
  properties: {
    document_type: { type: "string", enum: ["RECEIPT", "TAX_INVOICE", "INVOICE", "CASH_BILL", "EINVOICE", "PAYMENT_SLIP",
      "BANK_TRANSFER", "CHEQUE", "CREDIT_NOTE", "DEBIT_NOTE", "QUOTATION", "PURCHASE_ORDER", "DELIVERY_ORDER", "STATEMENT", "OTHER"] },
    direction: { type: "string", enum: ["MONEY_OUT", "MONEY_IN", "UNKNOWN"] },
    counterparty: {
      type: "object", additionalProperties: false,
      required: ["name", "reg_no", "tin", "sst_no", "address", "phone", "email"],
      properties: { name: str, reg_no: str, tin: str, sst_no: str, address: str, phone: str, email: str },
    },
    doc_no: str, date: str, due_date: str, currency: str,
    payment_method: { type: "string", enum: ["CASH", "CARD", "BANK_TRANSFER", "DUITNOW", "FPX", "CHEQUE", "EWALLET", "CREDIT", "UNKNOWN"] },
    payment_reference: str, bank_name: str,
    subtotal: str, discount: str, tax_total: str, rounding: str, total: str,
    tax_type: { type: "string", enum: ["NONE", "SERVICE_TAX", "SALES_TAX", "MIXED", "GST", "UNKNOWN"] },
    tax_rate: str, einvoice_uuid: str,
    lines: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["description", "quantity", "unit_price", "amount", "tax_rate"],
        properties: { description: str, quantity: str, unit_price: str, amount: str, tax_rate: str },
      },
    },
    references_paid: { type: "array", items: str },
    suggested_account_code: str,
    summary: str,
    confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
    warnings: { type: "array", items: str },
  },
};

const SYSTEM = `You read source documents for Zycount, a Malaysian bookkeeping app, and return the fields a bookkeeper would key in.
Documents include retail receipts, tax invoices, cash bills, supplier bills, LHDN MyInvois e-Invoices, payment advice and transfer screenshots (DuitNow, FPX, IBG, JomPAY, online banking), cheques, credit and debit notes, quotations and delivery orders. Text may be English, Malay, Chinese or Tamil, printed or handwritten, photographed at an angle or faded.

- Report only what the document shows. Use an empty string for anything absent or unreadable; never guess numbers, dates or registration numbers.
- Amounts are plain numbers with a dot for decimals and no currency symbol or thousands separator, e.g. 1234.50. Report totals as printed rather than recomputing them, including any rounding adjustment.
- Dates are YYYY-MM-DD. Malaysian documents write the day first: 03/09/2026 is 3 September 2026.
- direction is from the book owner's point of view (the owner is named in the request): MONEY_OUT when the owner buys or pays, MONEY_IN when the owner sells or is paid. A retail receipt that doesn't name the owner is a purchase.
- counterparty is the other party, never the book owner: the seller on a purchase, the payer on money received.
- SST: service tax is usually 6% or 8%, sales tax 5% or 10%. tax_total is the tax amount shown. An old GST line counts as tax; mention it in warnings.
- tin is LHDN's tax identification number (e.g. C12345678090 or IG12345678090); reg_no is the SSM registration number (e.g. 202001012345 or 1234567-X); sst_no looks like W10-1808-32000123.
- lines are the item lines as printed, each with its printed amount. Leave lines empty for a payment slip or a single-amount document. Give at most 60; summarise any beyond that in one final line.
- references_paid lists invoice or bill numbers that a payment says it settles.
- suggested_account_code is the code from the owner's account list that best fits what was bought or earned; empty if nothing fits.
- summary is under 80 characters: the description a bookkeeper would write, e.g. "Petrol - Petronas Bangsar" or "Office rental October 2026".
- warnings list what a reviewer should check: blurry or cut-off parts, totals that don't add up, handwritten changes, a currency other than MYR, a document marked as a copy, a date far in the past or future.
- confidence is HIGH when the date, total and counterparty are all clearly legible, MEDIUM when one of them is uncertain, LOW otherwise.`;

// ── Normalising what came back ─────────────────────────────────────────────
const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
function amount(v: unknown): number | null {
  let s = String(v ?? "").trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/[^0-9.\-()]/g, ""));
  s = s.replace(/[^0-9.,]/g, "");
  if (/,\d{2}$/.test(s) && !/\.\d/.test(s)) s = s.replace(/\./g, "").replace(",", "."); // 1.234,50
  s = s.replace(/,/g, "");
  const n = Number(s);
  if (!s || !Number.isFinite(n)) return null;
  return Math.round((neg ? -n : n) * 100) / 100;
}
function isoDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}
const near = (a: number, b: number) => Math.abs(a - b) <= 0.05;

// deno-lint-ignore no-explicit-any
function normalise(raw: any, codes: Set<string>, today: string) {
  const cp = raw.counterparty || {};
  const warnings: string[] = (Array.isArray(raw.warnings) ? raw.warnings : []).map((w: unknown) => clip(w, 200)).filter(Boolean).slice(0, 10);
  // deno-lint-ignore no-explicit-any
  const lines = (Array.isArray(raw.lines) ? raw.lines : []).slice(0, 60).map((l: any) => ({
    description: clip(l.description, 300), quantity: amount(l.quantity), unit_price: amount(l.unit_price),
    amount: amount(l.amount), tax_rate: amount(l.tax_rate),
  })).filter((l: { description: string; amount: number | null }) => l.description || l.amount != null);
  const out = {
    v: 1,
    document_type: clip(raw.document_type, 30) || "OTHER",
    direction: ["MONEY_OUT", "MONEY_IN"].includes(raw.direction) ? raw.direction : "UNKNOWN",
    counterparty: {
      name: clip(cp.name, 200), reg_no: clip(cp.reg_no, 40), tin: clip(cp.tin, 30).replace(/\s/g, ""),
      sst_no: clip(cp.sst_no, 40), address: String(cp.address ?? "").trim().slice(0, 500), phone: clip(cp.phone, 40), email: clip(cp.email, 120),
    },
    doc_no: clip(raw.doc_no, 60), date: isoDate(raw.date), due_date: isoDate(raw.due_date),
    currency: (clip(raw.currency, 3).toUpperCase() || "MYR").replace(/^RM$/, "MYR"),
    payment_method: clip(raw.payment_method, 20) || "UNKNOWN",
    payment_reference: clip(raw.payment_reference, 60), bank_name: clip(raw.bank_name, 60),
    subtotal: amount(raw.subtotal), discount: amount(raw.discount), tax_total: amount(raw.tax_total),
    rounding: amount(raw.rounding), total: amount(raw.total),
    tax_type: clip(raw.tax_type, 20) || "UNKNOWN", tax_rate: amount(raw.tax_rate), einvoice_uuid: clip(raw.einvoice_uuid, 60),
    lines,
    references_paid: (Array.isArray(raw.references_paid) ? raw.references_paid : []).map((r: unknown) => clip(r, 60)).filter(Boolean).slice(0, 20),
    suggested_account_code: codes.has(clip(raw.suggested_account_code, 20)) ? clip(raw.suggested_account_code, 20) : "",
    summary: clip(raw.summary, 120),
    confidence: ["HIGH", "MEDIUM", "LOW"].includes(raw.confidence) ? raw.confidence : "LOW",
    warnings,
  };
  // Cross-checks a reviewer should see, whatever the reader said.
  if (out.total == null) warnings.push("No total could be read.");
  if (!out.date) warnings.push("No date could be read.");
  else if (out.date > today) warnings.push("The date is in the future.");
  else if (out.date < String(Number(today.slice(0, 4)) - 7) + today.slice(4)) warnings.push("The date is more than 7 years ago.");
  if (out.currency !== "MYR") warnings.push(`Amounts are in ${out.currency}, not ringgit.`);
  const lineSum = Math.round(lines.reduce((s: number, l: { amount: number | null }) => s + (l.amount || 0), 0) * 100) / 100;
  if (out.total != null && lines.length && lines.every((l: { amount: number | null }) => l.amount != null)) {
    const net = out.subtotal ?? lineSum;
    if (!near(lineSum, net) && !near(lineSum, out.total)) warnings.push(`The lines add up to ${lineSum.toFixed(2)}, not ${net.toFixed(2)}.`);
  }
  if (out.total != null && out.subtotal != null) {
    const calc = out.subtotal - (out.discount || 0) + (out.tax_total || 0) + (out.rounding || 0);
    if (!near(calc, out.total)) warnings.push(`Subtotal, discount, tax and rounding come to ${calc.toFixed(2)}, not the ${out.total.toFixed(2)} total.`);
  }
  out.warnings = [...new Set(warnings)];
  return out;
}

// ── Handler ────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail(405, "VALIDATION", "Use POST.");
  const auth = req.headers.get("Authorization");
  if (!auth) return fail(401, "AUTH", "Sign in again.");
  let id = "";
  try { id = String((await req.json()).attachment_id || ""); } catch { /* handled below */ }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(400, "VALIDATION", "Which file should be read?");

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "", {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  // The key lives in the platform key register (Admin console → Keys & payments),
  // read with the service role; an Edge Function secret of the same name still works.
  let key: string | null = null;
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data } = await admin.rpc("_platform_secret", { p_name: "ANTHROPIC_API_KEY" });
    if (typeof data === "string" && data) key = data;
  } catch { /* fall back to the environment */ }
  key = key || Deno.env.get("ANTHROPIC_API_KEY") || null;
  if (!key) return fail(503, "AI_NOT_CONFIGURED", "Automatic reading isn't switched on for Zycount yet. Key the details in by hand; the file is kept with the entry.");

  const { data: ctx, error: e1 } = await sb.rpc("begin_attachment_scan", { p_id: id });
  if (e1) {
    const m = /^([A-Z_]+):\s*(.*)$/s.exec(e1.message || "");
    return fail(m && m[1] === "LIMIT" ? 429 : 403, m ? m[1] : "PERMISSION_DENIED", m ? m[2] : "You can't read files in these books.");
  }
  const { data: blob, error: e2 } = await sb.storage.from("attachments").download(ctx.path);
  if (e2 || !blob) return fail(404, "NOT_FOUND", "The file couldn't be opened.");
  const data = encodeBase64(new Uint8Array(await blob.arrayBuffer()));
  const file = ctx.mime === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
    : { type: "image", source: { type: "base64", media_type: ctx.mime, data } };

  const co = ctx.company || {};
  const accounts: { code: string; name: string; type: string }[] = ctx.accounts || [];
  const today = new Date().toISOString().slice(0, 10);
  const ask = [
    `Book owner: ${co.name || "(unnamed)"}${co.registration_no ? `, SSM ${co.registration_no}` : ""}${co.tax_registration_no ? `, tax no. ${co.tax_registration_no}` : ""} — ${co.kind === "PERSONAL" ? "personal books" : "business books"}.`,
    `Today is ${today}.`,
    "The owner's accounts (code — name — type):",
    ...accounts.map((a) => `${a.code} — ${a.name} — ${a.type}`),
    "",
    "Read the attached document.",
  ].join("\n");

  const client = new Anthropic({ apiKey: key });
  // deno-lint-ignore no-explicit-any
  const params: any = {
    model: MODEL,
    max_tokens: 16000,
    // A classifier false positive falls back to another model instead of failing the scan.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: EFFORT, format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: [file, { type: "text", text: ask }] }],
  };
  // deno-lint-ignore no-explicit-any
  let msg: any;
  try {
    msg = await client.beta.messages.create(params);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return fail(503, "AI_NOT_CONFIGURED", "The reading service key isn't valid. Key the details in by hand for now.");
    }
    if (err instanceof Anthropic.RateLimitError) return fail(429, "BUSY", "The reader is busy. Try again in a minute.");
    if (err instanceof Anthropic.BadRequestError) return fail(422, "UNREADABLE", "This file couldn't be read. Key the details in by hand.");
    if (err instanceof Anthropic.APIError) return fail(502, "UPSTREAM", "The reader didn't answer. Try again.");
    return fail(502, "UPSTREAM", "The reader didn't answer. Try again.");
  }
  if (msg.stop_reason === "refusal") return fail(422, "UNREADABLE", "This file couldn't be read. Key the details in by hand.");
  const text = (msg.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
  // deno-lint-ignore no-explicit-any
  let raw: any;
  try { raw = JSON.parse(text); } catch { return fail(502, "UPSTREAM", "The reading came back incomplete. Try again."); }

  const scan = { ...normalise(raw, new Set(accounts.map((a) => a.code)), today), engine: msg.model || MODEL, read_at: new Date().toISOString() };
  const { error: e3 } = await sb.rpc("save_attachment_scan", { p_id: id, p_scan: scan, p_engine: String(msg.model || MODEL) });
  if (e3) return fail(500, "SAVE_FAILED", "Read, but the result couldn't be saved.");
  return reply(200, { scan });
});
