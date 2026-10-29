// Zycount signup — creates a confirmed user and their first set of books
// (business or personal) in one step.
//
// Public endpoint (verify_jwt = false): it is the sign-up form's backend, so the
// caller has no session yet. It validates everything itself, uses the service
// role only on the server, and rolls the user back if company setup fails.
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://hafizramalan.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:8765",
  "http://localhost:8765",
];

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function reply(origin: string | null, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

// The address is kept only as a SHA-256 hash, for the database throttle.
async function ipHash(ip: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`zycount-signup:${ip}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return reply(origin, 405, { error: "METHOD_NOT_ALLOWED: Use POST." });

  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return reply(origin, 400, { error: "VALIDATION: Send the form as JSON." });
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const fullName = String(body.full_name ?? "").trim();
  const kind = String(body.kind ?? "BUSINESS").trim().toUpperCase();
  if (kind !== "BUSINESS" && kind !== "PERSONAL") return reply(origin, 400, { error: "VALIDATION: Choose personal or business." });
  if (fullName.length < 2 || fullName.length > 100) return reply(origin, 400, { error: "VALIDATION: Enter your name." });
  // Personal books are named after their owner unless a name is given.
  const companyName = String(body.company_name ?? "").trim() || (kind === "PERSONAL" ? `${fullName} — Personal` : "");

  if (companyName.length < 2 || companyName.length > 200) {
    return reply(origin, 400, { error: `VALIDATION: Enter your ${kind === "PERSONAL" ? "books'" : "company"} name.` });
  }
  if (!EMAIL_RE.test(email) || email.length > 254) return reply(origin, 400, { error: "VALIDATION: Enter a valid email address." });
  if (password.length < 8 || password.length > 72 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return reply(origin, 400, { error: "VALIDATION: Use 8–72 characters, including a letter and a number." });
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 5 sign-ups an hour per address and 60 an hour overall, counted in the
  // database so every function instance shares the same limit.
  const { data: allowed, error: throttleError } = await admin.rpc("_signup_allowed", { p_ip_hash: await ipHash(ip) });
  if (throttleError) {
    console.error("signup throttle failed", throttleError.message);
    return reply(origin, 503, { error: "INTERNAL: Sign-up is busy. Try again in a minute." });
  }
  if (!allowed) return reply(origin, 429, { error: "RATE_LIMITED: Too many sign-ups right now. Try again later." });

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, company_name: companyName, kind },
  });
  if (createError || !created?.user) {
    const msg = createError?.message ?? "";
    if (/already|registered|exists/i.test(msg)) {
      return reply(origin, 409, { error: "DUPLICATE: An account with that email already exists. Sign in instead." });
    }
    if (/password/i.test(msg)) return reply(origin, 400, { error: `VALIDATION: ${msg}` });
    console.error("createUser failed", msg);
    return reply(origin, 500, { error: "INTERNAL: We couldn't create the account. Nothing was saved — please try again." });
  }

  const { data: companyId, error: companyError } = await admin.rpc("create_company_for_user", {
    p_user: created.user.id,
    p_name: companyName,
    p_kind: kind,
  });
  if (companyError) {
    console.error("create_company_for_user failed", companyError.message);
    await admin.auth.admin.deleteUser(created.user.id);
    const msg = companyError.message.includes(":") ? companyError.message : "INTERNAL: Company setup failed.";
    return reply(origin, 400, { error: `${msg} Nothing was saved — please try again.` });
  }

  return reply(origin, 201, { ok: true, user_id: created.user.id, company_id: companyId });
});
