/* ═══════════════════════════════════════════════════════════════════════════
 * Zycount live workspace — fixed assets and depreciation (Phase 3.4).
 *
 * The register, the monthly depreciation run, and disposals. The database does
 * the schedule, the journals and the gain or loss (phase3_4_fixed_assets
 * migration); the register's cost and accumulated depreciation are checked
 * against the ledger every time this page opens.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const ZL = window.ZL;
  const E = ZL.esc;
  const M = ZL.money;
  const cid = () => ZL.company.company_id;

  const METHOD = { SL: "Straight-line", RB: "Reducing balance" };
  const monthEnd = (ym) => { const [y, m] = ym.split("-").map(Number); const d = new Date(Date.UTC(y, m, 0)); return d.toISOString().slice(0, 10); };
  const monthName = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-MY", { month: "long", year: "numeric", timeZone: "UTC" });
  const nbv = (a) => (ZL.cents(a.cost) - ZL.cents(a.accumulated)) / 100;

  const accountOpts = (accounts, pick, sel, blank) => (blank ? [{ value: "", label: blank }] : []).concat(
    accounts.filter(pick).map((a) => ({ value: a.id, label: `${a.code} · ${a.name}`, selected: a.id === sel })));
  const isAssetAcc = (a) => a.is_postable && a.is_active && a.type === "ASSET" && a.sub_type === "NON_CURRENT_ASSET" && !/^accumulated/i.test(a.name);
  const isAccumAcc = (a) => a.is_postable && a.is_active && a.type === "ASSET" && a.sub_type === "NON_CURRENT_ASSET";
  const isExpAcc = (a) => a.is_postable && a.is_active && a.type === "EXPENSE";
  const isMoneyAcc = (a) => a.is_postable && a.is_active && a.is_cash;

  const scheduleFields = (v = {}) => [
    { name: "method", label: "Method", type: "select", half: true, value: v.method || "SL",
      options: [{ value: "SL", label: "Straight-line (same amount each month)" }, { value: "RB", label: "Reducing balance (a % of book value)" }] },
    { name: "life_months", label: "Useful life (months) — straight-line", type: "number", half: true, value: v.life_months || 60, placeholder: "e.g. 60 = 5 years" },
    { name: "rb_rate", label: "Rate per year (%) — reducing balance", type: "number", half: true, value: v.rb_rate || "", placeholder: "e.g. 20" },
    { name: "residual", label: "Residual value", type: "amount", half: true, value: v.residual || "", hint: "What it will be worth at the end. Usually zero." },
  ];
  const scheduleData = (v) => ({ method: v.method, life_months: v.method === "SL" ? v.life_months : null, rb_rate: v.method === "RB" ? v.rb_rate : null,
    residual: v.residual === "" ? 0 : v.residual });

  // ── Register: manually, or from a posted purchase invoice line ────────────
  async function registerAsset() {
    const accounts = await ZL.accounts();
    const assetOpts = accountOpts(accounts, isAssetAcc, (accounts.find((a) => a.code === "1540") || {}).id);
    if (!assetOpts.length) { ZL.toast("These books have no fixed-asset accounts. Add one in the chart of accounts.", "bad"); return; }
    const r = await ZL.form({
      title: "Register an asset", wide: true, confirmLabel: "Register",
      intro: "For something you already own, choose “Already in the books”. To record a purchase now, choose the account it was paid from. Bought on a purchase invoice? Register it from the list on this page instead, so it isn't counted twice.",
      fields: [
        { name: "name", label: "Asset name", required: true, placeholder: "e.g. Toyota Hilux WXY 1234" },
        { name: "cost_account_id", label: "Asset account", type: "select", half: true, options: assetOpts.map((o) => ({ value: o.value, label: o.label })), value: (assetOpts.find((o) => o.selected) || assetOpts[0]).value },
        { name: "acquired_on", label: "Date bought", type: "date", half: true, required: true, value: ZL.today() },
        { name: "cost", label: "Cost", type: "amount", half: true, required: true },
        { name: "paid", label: "How it gets into the books", type: "select", half: true, value: "",
          options: [{ value: "", label: "Already in the books (no journal)" }].concat(accountOpts(accounts, isMoneyAcc).map((o) => ({ value: o.value, label: `Paid now from ${o.label}` }))) },
        ...scheduleFields(),
        { name: "opening_accumulated", label: "Depreciation already charged", type: "amount", half: true, hint: "Only for an asset you're bringing in from older books. Depreciation then continues from next month." },
        { name: "accum_account_id", label: "Accumulated depreciation account", type: "select", half: true, value: "", options: accountOpts(accounts, isAccumAcc, null, "Default for the asset account").map((o) => ({ value: o.value, label: o.label })) },
        { name: "expense_account_id", label: "Depreciation expense account", type: "select", half: true, value: "", options: accountOpts(accounts, isExpAcc, null, "Default for the asset account").map((o) => ({ value: o.value, label: o.label })) },
        { name: "notes", label: "Notes", type: "textarea", placeholder: "Serial number, location, who has it…" },
      ],
      submit: (v) => ZL.rpc("register_asset", { p_company: cid(), p_data: Object.assign(scheduleData(v), {
        name: v.name, cost_account_id: v.cost_account_id, acquired_on: v.acquired_on, cost: v.cost,
        opening_accumulated: v.opening_accumulated === "" ? 0 : v.opening_accumulated,
        accum_account_id: v.accum_account_id || null, expense_account_id: v.expense_account_id || null,
        post_acquisition: !!v.paid, paid_from_account_id: v.paid || null, notes: v.notes || null }) }),
    });
    if (r) { ZL.toast(`Asset ${r.code} registered.`); ZL.refresh(); }
  }

  async function registerFromLine(c) {
    const r = await ZL.form({
      title: `Register as an asset — ${c.doc_no}`, wide: true, confirmLabel: "Register",
      intro: `<b>${E(c.description || "")}</b> · ${E(c.account)} · RM ${M(c.amount)} on ${E(ZL.date(c.date))}. The purchase invoice already put it in the books, so no new journal is posted.`,
      fields: [{ name: "name", label: "Asset name", required: true, value: c.description || "" }, ...scheduleFields()],
      submit: (v) => ZL.rpc("register_asset", { p_company: cid(), p_data: Object.assign(scheduleData(v), { name: v.name, source_line_id: c.line_id }) }),
    });
    if (r) { ZL.toast(`Asset ${r.code} registered.`); ZL.refresh(); }
  }

  // ── Monthly depreciation ──────────────────────────────────────────────────
  async function runDepreciation() {
    const v = await ZL.form({ title: "Run depreciation", confirmLabel: "Preview",
      intro: "Depreciation is charged for every month up to the one you choose, from the month each asset was bought. You'll see the amounts before anything is posted.",
      fields: [{ name: "month", label: "Up to the end of", type: "month", required: true, value: ZL.today().slice(0, 7) }] });
    if (!v) return;
    const end = monthEnd(v.month);
    const rows = await ZL.rpc("depreciation_preview", { p_company: cid(), p_period_end: end });
    if (!rows.length) { ZL.toast(`Nothing to depreciate up to ${monthName(end)} — every asset is up to date.`, "bad"); return; }
    const total = rows.reduce((s, r) => s + ZL.cents(r.amount), 0) / 100;
    let result = null;
    ZL.modal({ title: `Depreciation to ${monthName(end)}`, wide: true,
      body: `<p class="hint" style="margin:0 0 12px">One journal dated ${E(ZL.date(end))}: Dr depreciation expense, Cr accumulated depreciation.</p>
        <div class="tablewrap"><table><thead><tr><th>Asset</th><th>Months</th><th class="r">Amount (RM)</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td><span class="mono">${E(r.code)}</span> ${E(r.name)}</td>
          <td class="nil">${E(monthName(r.from))}${r.months > 1 ? ` – ${E(monthName(r.to))}` : ""} (${r.months})</td><td class="r num">${M(r.amount)}</td></tr>`).join("")}</tbody>
        <tfoot><tr class="grand"><td colspan="2">Total</td><td class="r num">${M(total)}</td></tr></tfoot></table></div>`,
      actions: [{ label: "Cancel" }, { label: "Post depreciation", primary: true, onClick: async ({ close }) => {
        result = await ZL.rpc("run_depreciation", { p_company: cid(), p_period_end: end }); close(); } }],
      onClose: () => { if (result) { ZL.toast(`Depreciation RM ${M(result.total)} posted${result.reference ? ` (${result.reference})` : ""}.`); ZL.refresh(); } },
    });
  }

  // ── One asset: details, schedule, disposal ────────────────────────────────
  async function openAsset(id) {
    const [[a], lines, accounts] = await Promise.all([
      ZL.select("fixed_assets", "*", (q) => q.eq("id", id)),
      ZL.select("depreciation_lines", "month,amount,kind", (q) => q.eq("asset_id", id).order("month")),
      ZL.accounts()]);
    if (!a) return;
    const acc = (x) => { const r = accounts.find((y) => y.id === x); return r ? `${r.code} · ${r.name}` : ""; };
    const can = ZL.can("journal.post"), canRev = ZL.can("journal.reverse");
    const act = a.status === "ACTIVE";
    const removable = act && Number(a.accumulated) === Number(a.opening_accumulated) && !lines.length;
    const m = ZL.modal({ title: `${a.code} · ${a.name}`, wide: true,
      body: `<div class="zl-kv" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 18px;margin-bottom:14px">
          <div><span class="hint">Status</span><br>${act ? "Active" : `Disposed of on ${E(ZL.date(a.disposed_on))} for RM ${M(a.disposal_proceeds)}`}</div>
          <div><span class="hint">Bought</span><br>${E(ZL.date(a.acquired_on))}</div>
          <div><span class="hint">Cost</span><br>RM ${M(a.cost)}</div>
          <div><span class="hint">Accumulated depreciation</span><br>RM ${M(a.accumulated)}</div>
          <div><span class="hint">Book value</span><br><b>RM ${M(nbv(a))}</b></div>
          <div><span class="hint">Method</span><br>${a.method === "SL" ? `Straight-line over ${a.life_months} months` : `Reducing balance ${Number(a.rb_rate)}% a year`}${Number(a.residual) ? `, residual RM ${M(a.residual)}` : ""}</div>
          <div><span class="hint">Accounts</span><br><small>${E(acc(a.cost_account_id))}<br>${E(acc(a.accum_account_id))}<br>${E(acc(a.expense_account_id))}</small></div>
          <div><span class="hint">Depreciated to</span><br>${a.depreciated_to ? E(ZL.date(a.depreciated_to)) : "Not yet"}</div>
        </div>${a.notes ? `<p class="hint">${E(a.notes)}</p>` : ""}
        ${lines.length ? `<div class="tablewrap" style="max-height:260px;overflow:auto"><table><thead><tr><th>Month</th><th class="r">Depreciation (RM)</th></tr></thead>
          <tbody>${lines.map((l) => `<tr><td>${E(monthName(l.month))}${l.kind === "DISPOSAL" ? ' <span class="hint">(with the disposal)</span>' : ""}</td><td class="r num">${M(l.amount)}</td></tr>`).join("")}</tbody></table></div>`
          : `<p class="hint">No depreciation charged yet${Number(a.opening_accumulated) ? ` here (RM ${M(a.opening_accumulated)} brought in from older books)` : ""}.</p>`}`,
      actions: [{ label: "Close" },
        ...(removable && canRev ? [{ label: "Remove", danger: true, onClick: async ({ close }) => {
          if (!await ZL.confirm({ title: `Remove ${a.code}?`, message: `Only for an asset registered by mistake.${a.acquisition_journal_id ? " Its purchase journal is reversed." : ""}`, confirmLabel: "Remove", danger: true })) return;
          await ZL.rpc("delete_asset", { p_id: a.id }); close(); ZL.toast(`${a.code} removed.`); ZL.refresh(); } }] : []),
        ...(!act && canRev ? [{ label: "Undo disposal", onClick: async ({ close }) => {
          const r = await ZL.form({ title: `Undo the disposal of ${a.code}`, confirmLabel: "Undo disposal", danger: true,
            intro: "The disposal journal is reversed and the asset is active again.",
            fields: [{ name: "reason", label: "Reason", required: true, placeholder: "e.g. Wrong price" }],
            submit: (v) => ZL.rpc("undo_asset_disposal", { p_id: a.id, p_reason: v.reason }) });
          if (r) { close(); ZL.toast(`Disposal of ${a.code} undone.`); ZL.refresh(); } } }] : []),
        ...(act && can ? [{ label: "Sell or write off", primary: true, onClick: async ({ close }) => { if (await disposeAsset(a, accounts)) close(); } }] : []),
      ] });
    return m;
  }

  async function disposeAsset(a, accounts) {
    const money = accountOpts(accounts, isMoneyAcc).map((o) => ({ value: o.value, label: o.label }));
    const r = await ZL.form({ title: `Sell or write off ${a.code}`, confirmLabel: "Post disposal", wide: true,
      intro: `Book value today RM ${M(nbv(a))}. Depreciation for the months not yet charged, up to the disposal month, is added first. The difference between what you received and the book value goes to <b>Gain on Disposal</b> or <b>Loss on Disposal</b>.`,
      fields: [
        { name: "date", label: "Date", type: "date", half: true, required: true, value: ZL.today() },
        { name: "proceeds", label: "Amount received (0 to write off)", type: "amount", half: true },
        { name: "money_account_id", label: "Received into", type: "select", half: true, options: money, value: (money[0] || {}).value || "" },
        { name: "reason", label: "Note", half: true, placeholder: "e.g. Sold to Ali, traded in" },
      ],
      submit: (v) => ZL.rpc("dispose_asset", { p_id: a.id, p_data: { date: v.date, proceeds: v.proceeds === "" ? 0 : v.proceeds,
        money_account_id: (v.proceeds === "" || !v.proceeds) ? null : v.money_account_id, reason: v.reason || null } }) });
    if (!r) return false;
    const g = Number(r.gain);
    ZL.toast(`${a.code} disposed of — ${g >= 0 ? "gain" : "loss"} RM ${M(Math.abs(g))}${r.reference ? ` (${r.reference})` : ""}.`);
    ZL.refresh();
    return true;
  }

  // ── The register page ─────────────────────────────────────────────────────
  ZL.register("assets", {
    title: "Fixed assets",
    perm: "journal.view",
    business: true,
    async render(ctx) {
      const p = ctx.params || {};
      const [assets, runs, cands, check, accounts] = await Promise.all([
        ZL.select("fixed_assets", "id,code,name,cost_account_id,acquired_on,cost,accumulated,method,life_months,rb_rate,status,disposed_on,depreciated_to",
          (q) => q.eq("company_id", cid()).order("code")),
        ZL.select("depreciation_runs", "id,period_end,total,status,journal_entry_id,seq", (q) => q.eq("company_id", cid()).order("seq", { ascending: false }).limit(24)),
        ZL.rpc("asset_candidates", { p_company: cid() }).catch(() => []),
        ZL.can("report.view") ? ZL.rpc("fixed_asset_gl_check", { p_company: cid() }).catch(() => null) : Promise.resolve(null),
        ZL.accounts()]);
      ctx.cands = cands;
      ctx.assets = assets;
      const show = p.all ? assets : assets.filter((a) => a.status === "ACTIVE");
      const acc = (x) => { const r = accounts.find((y) => y.id === x); return r ? r.code : ""; };
      const active = assets.filter((a) => a.status === "ACTIVE");
      const tc = active.reduce((s, a) => s + ZL.cents(a.cost), 0) / 100, ta = active.reduce((s, a) => s + ZL.cents(a.accumulated), 0) / 100;
      const can = ZL.can("journal.post");
      const refs = runs.filter((r) => r.journal_entry_id).length
        ? await ZL.select("journal_entries", "id,reference", (q) => q.in("id", runs.map((r) => r.journal_entry_id).filter(Boolean))) : [];
      const ref = (id) => (refs.find((j) => j.id === id) || {}).reference || "";
      const latest = runs.find((r) => r.status === "POSTED");
      const accs = (check && check.accounts) || [];
      const proof = accs.length ? (check.in_balance
        ? `<div class="zl-banner info" style="margin-bottom:14px">✓ The register agrees with the ledger (${accs.map((a) => `${E(a.code)} RM ${M(a.gl_balance)}`).join(", ")}).</div>`
        : `<div class="zl-banner" style="margin-bottom:14px">The register and the ledger differ: ${accs.filter((a) => Number(a.difference)).map((a) => `${E(a.code)} ${E(a.name)} — register RM ${M(a.register)}, ledger RM ${M(a.gl_balance)}`).join("; ")}.
            ${cands.length ? "Register the purchases listed below, or" : "Check for"} a manual journal posted to an asset account.</div>`) : "";
      const actions = can ? `<div class="zl-actions" style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="zl-btn primary" id="zl-fadd">Register asset</button>
          <button type="button" class="zl-btn" id="zl-frun">Run depreciation</button></div>` : "";
      return ZL.header("Fixed assets", "What the business owns for the long term, and what it has lost in value. Depreciation is charged monthly from the month each asset was bought.", actions) +
        proof +
        (cands.length ? `<section class="card" style="margin-bottom:16px"><div class="card-h"><b>Bought on purchase invoices — not in the register yet</b>
            <span class="hint"> ${cands.length} line${cands.length === 1 ? "" : "s"} on asset accounts</span></div>
          <div class="tablewrap"><table><thead><tr><th>Date</th><th>Invoice</th><th>Supplier</th><th>Description</th><th>Account</th><th class="r">Amount (RM)</th><th></th></tr></thead>
          <tbody>${cands.map((c, i) => `<tr><td>${E(ZL.date(c.date))}</td><td class="mono">${E(c.doc_no || "")}</td><td>${E(c.supplier || "")}</td><td>${E(c.description || "")}</td>
            <td class="nil">${E(c.account)}</td><td class="r num">${M(c.amount)}</td>
            <td>${can ? `<button type="button" class="zl-btn sm" data-freg="${i}">Register</button>` : ""}</td></tr>`).join("")}</tbody></table></div></section>` : "") +
        `<div class="zl-toolbar" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
          <span class="hint">${active.length} active · cost <b>RM ${M(tc)}</b> · accumulated RM ${M(ta)} · book value <b>RM ${M((ZL.cents(tc) - ZL.cents(ta)) / 100)}</b></span>
          <label class="zl-check" style="margin-left:auto"><input type="checkbox" id="zl-fall"${p.all ? " checked" : ""}><span>Show disposed</span></label>
          <button type="button" class="zl-btn sm ghost" id="zl-fcsv">Export CSV</button></div>` +
        (show.length ? `<section class="card"><div class="tablewrap"><table>
          <thead><tr><th>Code</th><th>Asset</th><th>Account</th><th>Bought</th><th>Method</th><th class="r">Cost</th><th class="r">Accumulated</th><th class="r">Book value</th></tr></thead>
          <tbody>${show.map((a) => `<tr class="click" data-fa="${a.id}"${a.status === "ACTIVE" ? "" : ' style="opacity:.6"'}>
            <td class="mono">${E(a.code)}</td><td>${E(a.name)}${a.status === "ACTIVE" ? "" : ` <span class="hint">disposed ${E(ZL.date(a.disposed_on))}</span>`}</td>
            <td class="nil">${E(acc(a.cost_account_id))}</td><td>${E(ZL.date(a.acquired_on))}</td>
            <td class="nil">${a.method === "SL" ? `${a.life_months} mo` : `${Number(a.rb_rate)}% RB`}</td>
            <td class="r num">${M(a.cost)}</td><td class="r num">${M(a.accumulated)}</td><td class="r num">${M(nbv(a))}</td></tr>`).join("")}</tbody></table></div></section>`
          : ZL.empty("No fixed assets yet", "Register vehicles, computers, machinery and furniture here — or buy them on a purchase invoice to an asset account (15xx) and register them from this page.",
              can ? `<button type="button" class="zl-btn" id="zl-fadd2">Register asset</button>` : "")) +
        (runs.length ? `<section class="card" style="margin-top:16px"><div class="card-h"><b>Depreciation runs</b></div><div class="tablewrap"><table>
          <thead><tr><th>Up to</th><th>Journal</th><th class="r">Total (RM)</th><th>Status</th><th></th></tr></thead>
          <tbody>${runs.map((r) => `<tr><td>${E(monthName(r.period_end))}</td><td class="mono">${E(ref(r.journal_entry_id))}</td><td class="r num">${M(r.total)}</td>
            <td>${r.status === "POSTED" ? "Posted" : '<span class="hint">Void</span>'}</td>
            <td>${latest && r.id === latest.id && ZL.can("journal.reverse") ? `<button type="button" class="zl-btn sm ghost" data-fvoid="${r.id}">Void</button>` : ""}</td></tr>`).join("")}</tbody></table></div></section>` : "");
    },
    after(root, ctx) {
      ["#zl-fadd", "#zl-fadd2"].forEach((s) => { const b = root.querySelector(s); if (b) b.addEventListener("click", registerAsset); });
      const run = root.querySelector("#zl-frun");
      if (run) run.addEventListener("click", runDepreciation);
      const all = root.querySelector("#zl-fall");
      if (all) all.addEventListener("change", () => ZL.open("assets", { all: all.checked || null }));
      root.querySelectorAll("[data-freg]").forEach((b) => b.addEventListener("click", () => registerFromLine(ctx.cands[+b.dataset.freg])));
      root.querySelectorAll("[data-fa]").forEach((tr) => tr.addEventListener("click", () => openAsset(tr.dataset.fa)));
      root.querySelectorAll("[data-fvoid]").forEach((b) => b.addEventListener("click", async () => {
        const r = await ZL.form({ title: "Void this depreciation run", confirmLabel: "Void run", danger: true,
          intro: "The journal is reversed and each asset steps back to before this run. Only the latest run can be voided.",
          fields: [{ name: "reason", label: "Reason", required: true, placeholder: "e.g. Ran the wrong month" }],
          submit: (v) => ZL.rpc("void_depreciation_run", { p_id: b.dataset.fvoid, p_reason: v.reason }) });
        if (r) { ZL.toast("Depreciation run voided."); ZL.refresh(); }
      }));
      const c = root.querySelector("#zl-fcsv");
      if (c) c.addEventListener("click", () => ZL.csv(`fixed-assets-${ZL.today()}.csv`, [["Code", "Asset", "Bought", "Method", "Cost", "Accumulated", "Book value", "Status"]]
        .concat((ctx.assets || []).map((a) => [a.code, a.name, a.acquired_on, METHOD[a.method], Number(a.cost), Number(a.accumulated), nbv(a), a.status]))));
    },
  });
})();
