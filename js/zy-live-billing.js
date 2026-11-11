/* ═══════════════════════════════════════════════════════════════════════════
 * Zycount live workspace — plans and payment.
 *   billing       Plan & billing for these books: plan, trial, usage, pay online.
 *   adminkeys     Platform admin: API keys (kept in Vault, write-only) and the
 *                 payment gateway (Billplz, ToyyibPay or Stripe).
 *   adminbilling  Platform admin: every book's plan, every payment, overrides.
 * Keys never come back to the browser: the server shows only the last four
 * characters, and the edge functions read the real value with the service role.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const ZL = window.ZL;
  const E = ZL.esc;
  const cid = () => ZL.company.company_id;
  const RM = (v) => ZL.money(v, { symbol: true });
  const call = (body) => ZL.fn("billing", body);

  const STATUS = {
    TRIAL: ["Free trial", "warn"], ACTIVE: ["Active", "ok"], PAST_DUE: ["Payment due", "bad"], EXPIRED: ["Trial ended", "bad"],
    CANCELLED: ["Cancelled", "bad"], FREE: ["Free", "ok"],
  };
  const PAY = { PENDING: ["Waiting for payment", "warn"], PAID: ["Paid", "ok"], FAILED: ["Failed", "bad"], CANCELLED: ["Cancelled", ""] };
  const chip = (map, s) => { const [l, t] = map[s] || [s, ""]; return `<span class="chip ${t}">${E(l)}</span>`; };
  const GATEWAY = { BILLPLZ: "Billplz", TOYYIBPAY: "ToyyibPay", STRIPE: "Stripe", MANUAL: "Manual" };
  const daysLeft = (iso) => (iso ? Math.ceil((new Date(iso) - Date.now()) / 86400000) : null);

  const css = document.createElement("style");
  css.textContent = `
  .zb-plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin:16px 0}
  .zb-plan{border:1px solid var(--line);border-radius:12px;background:var(--card);padding:18px;display:flex;flex-direction:column;gap:10px}
  .zb-plan.cur{border-color:var(--brand);box-shadow:0 0 0 1px var(--brand) inset}
  .zb-plan h3{margin:0;font-size:16px;display:flex;justify-content:space-between;gap:8px;align-items:center}
  .zb-price{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums}
  .zb-price small{font-size:13px;font-weight:400;color:var(--ink-3)}
  .zb-plan ul{margin:0;padding-left:18px;color:var(--ink-2);font-size:13px;line-height:1.7;flex:1}
  .zb-meter{height:6px;border-radius:3px;background:var(--line-2);overflow:hidden;margin-top:6px}
  .zb-meter>i{display:block;height:100%;background:var(--brand)}
  .zb-meter.full>i{background:var(--bad)}
  .zb-keys td{vertical-align:middle}
  .zb-keys .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
  .zb-group td{background:var(--bg-2, var(--line-2));font-weight:600;font-size:12.5px;letter-spacing:.02em}
  .zb-hook{display:flex;gap:8px;align-items:center;margin:6px 0}
  .zb-hook input{flex:1;min-width:0}
  @media (max-width:760px){.zb-plans{grid-template-columns:minmax(0,1fr)}}
  `;
  document.head.appendChild(css);

  // ══ Plan & billing (these books) ══════════════════════════════════════════
  ZL.register("billing", {
    title: "Plan & billing",
    perm: "company.view",
    business: true,
    async render(ctx) {
      const s = await ZL.rpc("my_subscription", { p_company: cid() });
      const cycle = ctx.params.cycle === "YEAR" ? "YEAR" : "MONTH";
      const p = s.plan || {};
      const left = s.status === "TRIAL" ? daysLeft(s.trial_ends_at) : s.status === "ACTIVE" ? daysLeft(s.current_period_end) : null;
      const meter = (used, max, label) => {
        const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
        return `<div style="margin-top:12px"><div style="display:flex;justify-content:space-between;font-size:13px"><span>${label}</span>
          <span class="num">${used}${max ? ` of ${max}` : " · no limit"}</span></div>
          ${max ? `<div class="zb-meter${used >= max ? " full" : ""}"><i style="width:${pct}%"></i></div>` : ""}</div>`;
      };
      const g = s.billing || {};
      const online = !!g.gateway;
      const seg = [["MONTH", "Monthly"], ["YEAR", "Yearly · 2 months free"]].map(([v, l]) =>
        `<button type="button" data-cycle="${v}" aria-pressed="${cycle === v}">${l}</button>`).join("");
      const plans = (s.plans || []).map((x) => {
        const price = cycle === "YEAR" ? x.price_year : x.price_month;
        const cur = x.code === p.code && (s.status === "ACTIVE" || s.status === "TRIAL");
        const label = x.code === p.code && s.status === "ACTIVE" ? "Renew" : x.code === p.code ? "Pay for this plan" : "Choose";
        return `<div class="zb-plan${cur ? " cur" : ""}">
          <h3>${E(x.name)}${cur ? '<span class="chip ok">Current</span>' : ""}</h3>
          <div class="zb-price">${RM(price)} <small>/${cycle === "YEAR" ? "year" : "month"}</small></div>
          <ul>${(x.features || []).map((f) => `<li>${E(f)}</li>`).join("")}
            <li>${x.max_users ? `${x.max_users} user${x.max_users > 1 ? "s" : ""}` : "Unlimited users"} · ${x.scan_daily} automatic reads a day</li></ul>
          ${s.can_pay && Number(price) > 0 ? `<button type="button" class="zl-btn${cur ? " primary" : ""}" data-pay="${E(x.code)}"${online ? "" : " disabled"}>${label}</button>` : ""}
        </div>`;
      }).join("");
      const pays = (s.payments || []).map((y) => `<tr>
          <td class="nil" style="white-space:nowrap">${ZL.dateTime(y.created_at)}</td>
          <td>${E((s.plans || []).find((x) => x.code === y.plan_code)?.name || y.plan_code)} · ${y.billing_cycle === "YEAR" ? "yearly" : "monthly"}</td>
          <td class="r num">${RM(y.amount)}</td>
          <td>${E(GATEWAY[y.gateway] || y.gateway)}${y.mode === "SANDBOX" ? ' <span class="chip">Test</span>' : ""}</td>
          <td>${chip(PAY, y.status)}</td>
          <td class="nil">${y.status === "PAID" ? `Until ${ZL.date(y.period_end)}` : ""}</td>
          <td class="r" style="white-space:nowrap">${y.status === "PENDING" ? `${y.pay_url ? `<a class="zl-btn sm" href="${E(y.pay_url)}" rel="noopener">Pay now</a> ` : ""}<button type="button" class="zl-btn sm ghost" data-verify="${y.id}">Check</button>` : ""}</td></tr>`).join("");
      return ZL.header("Plan & billing", "Your Zycount plan for these books, what it includes and what you've paid.") + `
        <section class="card" style="padding:18px 20px;margin-bottom:16px">
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <h3 style="margin:0;font-size:16px">${E(p.name || "—")} plan</h3>${chip(STATUS, s.status)}
            <span class="hint">${s.status === "TRIAL" ? (left > 0 ? `${left} day${left === 1 ? "" : "s"} left in your trial — ends ${ZL.date(s.trial_ends_at)}.` : "")
              : s.status === "ACTIVE" ? `Paid until ${ZL.date(s.current_period_end)}${left != null && left <= 7 ? ` — ${left} day${left === 1 ? "" : "s"} left` : ""}.`
              : s.status === "EXPIRED" ? `Your trial ended on ${ZL.date(s.trial_ends_at)}. Your books are safe — choose a plan to keep going.`
              : s.status === "PAST_DUE" ? `Your plan ran out on ${ZL.date(s.current_period_end)}. Renew to keep going.` : ""}</span>
          </div>
          <div style="max-width:520px">${meter(s.usage.users, p.max_users, "Users")}${meter(s.usage.scans_today, p.scan_daily, "Automatic reads in the last 24 hours")}</div>
        </section>
        ${!online ? `<section class="card" style="padding:14px 20px;margin-bottom:16px"><span class="hint">Online payment isn't switched on yet. To pay by bank transfer, contact Zycount — your plan is set for you once it's received.</span></section>`
          : g.mode === "SANDBOX" ? `<section class="card" style="padding:14px 20px;margin-bottom:16px"><span class="chip warn">Test mode</span> <span class="hint">Payments go to the ${E(GATEWAY[g.gateway])} sandbox — no real money moves.</span></section>` : ""}
        <div class="toolbar"><div class="seg" role="group" aria-label="Billing period">${seg}</div></div>
        <div class="zb-plans">${plans}</div>
        ${s.can_pay ? "" : '<p class="hint">Only owners and administrators of these books can change the plan.</p>'}
        <section class="card"><div class="tablewrap"><table>
          <thead><tr><th>Started</th><th>Plan</th><th class="r">Amount</th><th>Paid with</th><th>Status</th><th></th><th></th></tr></thead>
          <tbody>${pays || '<tr><td colspan="7" class="nil">No payments yet.</td></tr>'}</tbody></table></div>
          <div class="proofrow"><span>Payments are confirmed with the payment provider before your plan changes, and every payment is written to the audit trail.</span></div></section>`;
    },
    after(root, ctx) {
      root.querySelectorAll("[data-cycle]").forEach((b) => b.addEventListener("click", () => ZL.open("billing", Object.assign({}, ctx.params, { cycle: b.dataset.cycle }))));
      const cycle = ctx.params.cycle === "YEAR" ? "YEAR" : "MONTH";
      root.querySelectorAll("[data-pay]").forEach((b) => b.addEventListener("click", async () => {
        b.disabled = true; const old = b.textContent; b.textContent = "Opening payment…";
        try {
          const r = await call({ action: "checkout", company_id: cid(), plan: b.dataset.pay, cycle });
          location.href = r.url;
        } catch (e) { ZL.toast(ZL.errorText(e), "bad"); b.disabled = false; b.textContent = old; ZL.refresh(); }
      }));
      root.querySelectorAll("[data-verify]").forEach((b) => b.addEventListener("click", async () => {
        b.disabled = true;
        try { const r = await call({ action: "verify", payment_id: b.dataset.verify }); toastStatus(r); ZL.refresh(); }
        catch (e) { ZL.toast(ZL.errorText(e), "bad"); b.disabled = false; }
      }));
    },
  });

  function toastStatus(r) {
    if (r.status === "PAID") ZL.toast(`Payment received — your plan is active${r.period_end ? ` until ${ZL.date(r.period_end)}` : ""}.`);
    else if (r.status === "CANCELLED") ZL.toast("Payment cancelled. Nothing was charged.", "warn");
    else if (r.status === "FAILED") ZL.toast("The payment didn't go through. Try again or use another method.", "bad");
    else ZL.toast("The payment isn't confirmed yet. It usually takes under a minute — press Check again shortly.", "warn");
  }

  /** Back from the payment page: app.html?zpay=<id>[&zcancel=1]#billing */
  ZL.billingReturn = async () => {
    const q = new URLSearchParams(location.search);
    const id = q.get("zpay");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
    const cancelled = q.get("zcancel") === "1" || q.get("status_id") === "3" || q.get("billplz[paid]") === "false";
    history.replaceState(null, "", location.pathname + location.hash);
    try {
      const r = await call({ action: "verify", payment_id: id, cancelled });
      toastStatus(r);
      if (ZL.modules.billing && location.hash === "#billing") ZL.refresh();
    } catch (e) { ZL.toast(ZL.errorText(e), "bad"); }
  };

  // ══ Admin: keys & payments ════════════════════════════════════════════════
  const KEYS = [
    { group: "AI reading", name: "ANTHROPIC_API_KEY", label: "Anthropic API key", help: "Reads receipts, bills and payment slips in the Inbox. console.anthropic.com → API keys.", test: "ANTHROPIC" },
    { group: "Billplz", name: "BILLPLZ_API_KEY", label: "API secret key", help: "Billplz → Settings → Keys & Integration.", test: "BILLPLZ" },
    { group: "Billplz", name: "BILLPLZ_X_SIGNATURE_KEY", label: "X Signature key", help: "Same page. Turn X Signature on so payment callbacks are signed." },
    { group: "Billplz", name: "BILLPLZ_COLLECTION_ID", label: "Collection ID", help: "Billplz → Billing → the collection subscription payments go into." },
    { group: "ToyyibPay", name: "TOYYIBPAY_SECRET_KEY", label: "User secret key", help: "ToyyibPay → Settings → User secret key.", test: "TOYYIBPAY" },
    { group: "ToyyibPay", name: "TOYYIBPAY_CATEGORY_CODE", label: "Category code", help: "ToyyibPay → Category → the category for Zycount plans." },
    { group: "Stripe", name: "STRIPE_SECRET_KEY", label: "Secret key (sk_…)", help: "Stripe → Developers → API keys. Use sk_test_… in sandbox.", test: "STRIPE" },
    { group: "Stripe", name: "STRIPE_WEBHOOK_SECRET", label: "Webhook signing secret (whsec_…)", help: "Stripe → Developers → Webhooks → your endpoint below." },
  ];
  const KNOWN = new Set(KEYS.map((k) => k.name));

  async function setKey(name, label, exists) {
    const v = await ZL.form({
      title: exists ? `Replace ${label}` : `Add ${label}`,
      intro: "Paste the value. It is stored encrypted in Supabase Vault — after saving, nobody (you included) can read it back here; only Zycount's server uses it.",
      confirmLabel: "Save key",
      fields: [
        ...(name ? [] : [{ name: "name", label: "Key name", required: true, placeholder: "e.g. BILLPLZ_API_KEY_SANDBOX" }]),
        { name: "value", label: "Value", type: "password", required: true, placeholder: "Paste here" },
      ],
      submit: (x) => ZL.rpc("platform_secret_set", { p_name: name || x.name, p_value: x.value }),
    });
    if (v && v.hint) { ZL.toast(`${v.name} saved (${v.hint}).`); ZL.refresh(); }
  }

  ZL.register("adminkeys", {
    title: "Keys & payments",
    platform: true,
    async render() {
      if (!ZL.platformAdmin) return ZL.noAccess("Keys & payments", "platform administrator");
      const [list, set] = await Promise.all([ZL.rpc("platform_secrets_list"), ZL.rpc("platform_settings_get")]);
      const have = new Map(list.map((x) => [x.name, x]));
      const row = (k) => {
        const h = have.get(k.name);
        const variants = list.filter((x) => x.name === k.name + "_SANDBOX" || x.name === k.name + "_LIVE");
        return `<tr><td><div style="font-weight:500">${E(k.label)}</div><div class="hint mono">${E(k.name)}</div>${k.help ? `<div class="hint">${E(k.help)}</div>` : ""}
            ${variants.map((x) => `<div class="hint mono">+ ${E(x.name)} ${E(x.hint || "")}</div>`).join("")}</td>
          <td>${h ? `<span class="chip ok">Saved</span> <span class="mono">${E(h.hint || "")}</span>` : '<span class="chip">Not set</span>'}</td>
          <td class="nil" style="white-space:nowrap">${h ? `${ZL.dateTime(h.updated_at)}<div class="hint">${E(h.updated_by || "")}</div>` : ""}</td>
          <td class="r" style="white-space:nowrap">
            ${k.test ? `<button type="button" class="zl-btn sm ghost" data-ktest="${k.test}">Test</button>` : ""}
            <button type="button" class="zl-btn sm" data-kset="${E(k.name)}" data-label="${E(k.label)}" data-has="${h ? 1 : 0}">${h ? "Replace" : "Add"}</button>
            ${h ? `<button type="button" class="zl-btn sm ghost" data-kdel="${E(k.name)}">Remove</button>` : ""}</td></tr>`;
      };
      let lastGroup = "";
      const rows = KEYS.map((k) => { const g = k.group !== lastGroup ? `<tr class="zb-group"><td colspan="4">${E(k.group)}</td></tr>` : ""; lastGroup = k.group; return g + row(k); }).join("");
      const others = list.filter((x) => !KNOWN.has(x.name) && !KEYS.some((k) => x.name === k.name + "_SANDBOX" || x.name === k.name + "_LIVE"));
      const otherRows = others.map((x) => `<tr><td class="mono">${E(x.name)}</td><td><span class="chip ok">Saved</span> <span class="mono">${E(x.hint || "")}</span></td>
          <td class="nil">${ZL.dateTime(x.updated_at)}</td>
          <td class="r" style="white-space:nowrap"><button type="button" class="zl-btn sm" data-kset="${E(x.name)}" data-label="${E(x.name)}" data-has="1">Replace</button>
            <button type="button" class="zl-btn sm ghost" data-kdel="${E(x.name)}">Remove</button></td></tr>`).join("");
      const gw = set["billing.gateway"] || "";
      const mode = set["billing.mode"] || "SANDBOX";
      const hook = (g) => `${ZL.SUPABASE_URL}/functions/v1/billing?hook=${g}`;
      return ZL.header("Keys & payments", "API keys for Zycount's services and how customers pay for their plan.") + `
        <section class="card" style="margin-bottom:16px"><form class="zl-form" id="zb-set" style="padding:18px 20px" autocomplete="off">
          <h3 style="grid-column:1/-1;margin:0;font-size:15px">Payment for plans</h3>
          <label class="zl-field half"><span>Payment gateway</span><select class="zl-input" name="gateway">
            <option value="">Off — customers pay by transfer</option>
            ${Object.entries({ BILLPLZ: "Billplz (FPX, cards)", TOYYIBPAY: "ToyyibPay (FPX, cards)", STRIPE: "Stripe (cards, FPX, GrabPay)" })
              .map(([v, l]) => `<option value="${v}"${gw === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
          <label class="zl-field half"><span>Mode</span><select class="zl-input" name="mode">
            <option value="SANDBOX"${mode !== "LIVE" ? " selected" : ""}>Sandbox (test money)</option>
            <option value="LIVE"${mode === "LIVE" ? " selected" : ""}>Live (real payments)</option></select></label>
          <label class="zl-field half"><span>Free trial for new business books (days)</span><input class="zl-input" name="trial" type="number" min="0" max="90" value="${E(set["billing.trial_days"] ?? 14)}"></label>
          <label class="zl-field half"><span>App address (customers return here after paying)</span><input class="zl-input mono" name="app" value="${E(set["app.url"] || "")}"></label>
          <div class="zl-actions" style="grid-column:1/-1"><button type="submit" class="zl-btn primary">Save</button>
            ${gw ? `<button type="button" class="zl-btn" data-ktest="${gw}">Test ${E(GATEWAY[gw])} ${mode === "LIVE" ? "live" : "sandbox"} keys</button>` : ""}</div>
          <div style="grid-column:1/-1" class="hint">
            In sandbox mode a key named <span class="mono">NAME_SANDBOX</span> is used before <span class="mono">NAME</span>; in live mode <span class="mono">NAME_LIVE</span> first. Billplz and ToyyibPay are told the callback address with every bill.
            For Stripe, add this endpoint under Developers → Webhooks with the events <span class="mono">checkout.session.completed</span>, <span class="mono">checkout.session.async_payment_succeeded</span> and <span class="mono">checkout.session.expired</span>:
            <div class="zb-hook"><input class="zl-input mono" readonly value="${E(hook("stripe"))}"><button type="button" class="zl-btn sm" data-copy="${E(hook("stripe"))}">Copy</button></div>
          </div>
        </form></section>
        <section class="card"><div class="tablewrap"><table class="zb-keys">
          <thead><tr><th>Key</th><th>Stored</th><th>Last changed</th><th class="r"><button type="button" class="zl-btn sm" id="zb-addkey">+ Add another key</button></th></tr></thead>
          <tbody>${rows}${otherRows ? `<tr class="zb-group"><td colspan="4">Other keys</td></tr>${otherRows}` : ""}</tbody></table></div>
          <div class="proofrow"><span>Keys are encrypted in Supabase Vault. The browser never receives a key — only its last four characters. Every change is logged.
            A key still set as an Edge Function secret keeps working until you add it here.</span></div></section>`;
    },
    after(root) {
      const form = root.querySelector("#zb-set");
      if (!form) return;
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
        const btn = form.querySelector('[type="submit"]'); btn.disabled = true;
        form.querySelectorAll(".zl-err").forEach((x) => x.remove());
        try {
          await ZL.rpc("platform_setting_set", { p_key: "billing.gateway", p_value: v("gateway") || null });
          await ZL.rpc("platform_setting_set", { p_key: "billing.mode", p_value: v("mode") });
          await ZL.rpc("platform_setting_set", { p_key: "billing.trial_days", p_value: Number(v("trial") || 0) });
          if (v("app")) await ZL.rpc("platform_setting_set", { p_key: "app.url", p_value: v("app") });
          ZL.toast("Payment settings saved.");
          ZL.refresh();
        } catch (e) { form.insertAdjacentHTML("beforeend", ZL.errorBox(e)); btn.disabled = false; }
      });
      root.querySelectorAll("[data-kset]").forEach((b) => b.addEventListener("click", () => setKey(b.dataset.kset, b.dataset.label, b.dataset.has === "1")));
      root.querySelector("#zb-addkey").addEventListener("click", () => setKey(null, "a key", false));
      root.querySelectorAll("[data-kdel]").forEach((b) => b.addEventListener("click", async () => {
        if (!(await ZL.confirm({ title: `Remove ${b.dataset.kdel}?`, message: "The key is deleted from Vault. Anything that uses it stops working until a new one is added.", confirmLabel: "Remove key", danger: true }))) return;
        try { await ZL.rpc("platform_secret_set", { p_name: b.dataset.kdel, p_value: "" }); ZL.toast("Key removed."); ZL.refresh(); }
        catch (e) { ZL.toast(ZL.errorText(e), "bad"); }
      }));
      root.querySelectorAll("[data-ktest]").forEach((b) => b.addEventListener("click", async () => {
        b.disabled = true; const old = b.textContent; b.textContent = "Testing…";
        const mode = form.querySelector('[name="mode"]').value;
        try { const r = await call({ action: "test", target: b.dataset.ktest, mode }); ZL.toast(r.detail); }
        catch (e) { ZL.toast(ZL.errorText(e), "bad"); }
        b.disabled = false; b.textContent = old;
      }));
      root.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(b.dataset.copy); ZL.toast("Copied."); } catch (_) { ZL.toast("Select the address and copy it.", "warn"); }
      }));
    },
  });

  // ══ Admin: subscriptions ══════════════════════════════════════════════════
  ZL.register("adminbilling", {
    title: "Subscriptions",
    platform: true,
    async render(ctx) {
      if (!ZL.platformAdmin) return ZL.noAccess("Subscriptions", "platform administrator");
      const tab = ctx.params.tab === "payments" ? "payments" : "books";
      const [d, plans] = await Promise.all([ZL.rpc("admin_subscriptions"), ZL.select("plans", "*", (q) => q.order("sort"))]);
      const count = (st) => d.books.filter((b) => b.status === st).length;
      const kpi = (label, v, sub) => `<div class="kpi"><div class="klbl">${label}</div><div class="kval num">${v}</div><div class="hint">${sub}</div></div>`;
      const name = (code) => (plans.find((p) => p.code === code) || {}).name || code || "—";
      const seg = [["books", `Books (${d.books.length})`], ["payments", `Payments (${d.payments.length})`]].map(([v, l]) =>
        `<button type="button" data-btab="${v}" aria-pressed="${tab === v}">${l}</button>`).join("");
      return ZL.header("Subscriptions", "Every book's plan and every payment. Change a plan by hand for transfers, discounts or comps.") + `
        <div class="kpi-head zl-kpis">
          ${kpi("Paying", count("ACTIVE"), `${count("PAST_DUE")} payment due`)}
          ${kpi("On trial", count("TRIAL"), `${count("EXPIRED")} trial ended`)}
          ${kpi("Live revenue, 30 days", RM(d.revenue_30d), "Paid through the gateway")}
        </div>
        <div class="toolbar"><div class="seg" role="group" aria-label="Show">${seg}</div></div>
        <section class="card"><div class="tablewrap"><table>
        ${tab === "books" ? `<thead><tr><th>Books</th><th>Plan</th><th>Status</th><th>Until</th><th>Note</th><th></th></tr></thead><tbody>
          ${d.books.map((b) => `<tr><td style="font-weight:500">${E(b.name)} <span class="chip">${b.kind === "PERSONAL" ? "Personal" : "Business"}</span></td>
            <td>${E(name(b.plan_code))}${b.billing_cycle ? ` · ${b.billing_cycle === "YEAR" ? "yearly" : "monthly"}` : ""}</td><td>${chip(STATUS, b.status)}</td>
            <td class="nil">${ZL.date(b.status === "TRIAL" || b.status === "EXPIRED" ? b.trial_ends_at : b.current_period_end)}</td>
            <td class="nil">${E(b.note || "")}</td>
            <td class="r"><button type="button" class="zl-btn sm" data-bset="${b.company_id}">Change</button></td></tr>`).join("") || '<tr><td colspan="6" class="nil">No books yet.</td></tr>'}</tbody>`
        : `<thead><tr><th>Started</th><th>Books</th><th>Plan</th><th class="r">Amount</th><th>Gateway</th><th>Reference</th><th>Status</th></tr></thead><tbody>
          ${d.payments.map((y) => `<tr><td class="nil" style="white-space:nowrap">${ZL.dateTime(y.created_at)}</td><td>${E(y.company)}</td>
            <td>${E(name(y.plan_code))} · ${y.billing_cycle === "YEAR" ? "yearly" : "monthly"}</td><td class="r num">${RM(y.amount)}</td>
            <td>${E(GATEWAY[y.gateway] || y.gateway)}${y.mode === "SANDBOX" ? ' <span class="chip">Test</span>' : ""}</td>
            <td class="hint mono">${E(y.gateway_ref || "")}</td><td>${chip(PAY, y.status)}</td></tr>`).join("") || '<tr><td colspan="7" class="nil">No payments yet.</td></tr>'}</tbody>`}
        </table></div></section>`;
    },
    after(root, ctx) {
      root.querySelectorAll("[data-btab]").forEach((b) => b.addEventListener("click", () => ZL.open("adminbilling", Object.assign({}, ctx.params, { tab: b.dataset.btab }))));
      root.querySelectorAll("[data-bset]").forEach((b) => b.addEventListener("click", async () => {
        const [d, plans] = await Promise.all([ZL.rpc("admin_subscriptions"), ZL.select("plans", "*", (q) => q.order("sort"))]);
        const cur = d.books.find((x) => x.company_id === b.dataset.bset) || {};
        const until = (cur.status === "TRIAL" ? cur.trial_ends_at : cur.current_period_end) || "";
        const done = await ZL.form({
          title: `Plan for ${cur.name}`,
          intro: "For a bank transfer, a discount or a free account. The change is written to the books' audit trail.",
          fields: [
            { name: "plan", label: "Plan", type: "select", half: true, value: cur.plan_code || "BUSINESS",
              options: plans.filter((p) => p.kind === cur.kind).map((p) => ({ value: p.code, label: `${p.name} — ${RM(p.price_month)}/month` })) },
            { name: "status", label: "Status", type: "select", half: true, value: cur.status === "EXPIRED" ? "TRIAL" : cur.status === "PAST_DUE" ? "ACTIVE" : cur.status || "TRIAL",
              options: [["TRIAL", "Free trial"], ["ACTIVE", "Active (paid)"], ["FREE", "Free"], ["CANCELLED", "Cancelled"]].map(([value, label]) => ({ value, label })) },
            { name: "until", label: "Until (trial end or paid-until date)", type: "date", half: true, value: String(until).slice(0, 10) },
            { name: "note", label: "Note", half: true, value: cur.note || "", placeholder: "e.g. Paid by transfer, ref 12345" },
          ],
          submit: (v) => ZL.rpc("admin_set_subscription", { p_company: cur.company_id, p_plan: v.plan, p_status: v.status,
            p_until: v.until ? `${v.until}T23:59:59+08:00` : null, p_note: v.note || null }),
        });
        if (done) { ZL.toast("Plan updated."); ZL.refresh(); }
      }));
    },
  });
})();
