/* ═══════════════════════════════════════════════════════════════════════════
 * Zycount live workspace — money in, money out, transfers, opening balances.
 *
 * People describe what happened ("paid RM50 for groceries from cash"); the
 * database writes the balanced double entry and posts it (record_transaction,
 * post_opening_balances). Every form shows the exact journal before it posts.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const ZL = window.ZL;
  const E = ZL.esc;
  const M = ZL.money;
  const cid = () => ZL.company.company_id;

  const CSS = `
  .zl-post{border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-top:4px}
  .zl-post-h{display:flex;justify-content:space-between;padding:8px 12px;background:var(--sunk);font-size:12.5px;color:var(--ink-3)}
  .zl-post table{font-size:13px}
  .zl-post td{padding:7px 12px;border-bottom:1px solid var(--line-2)}
  .zl-post tr:last-child td{border-bottom:0}
  .zl-post .ok{color:var(--good);font-weight:500}
  html .zl-post th,html.zl-live .zl-post th{padding:6px 12px;font-size:12px;background:none;border-bottom:1px solid var(--line-2)}
  html .zl-post td,html.zl-live .zl-post td{padding:8px 12px}
  .zl-post .zl-amtcol{width:110px}
  @media (max-width:640px){.zl-post .zl-amtcol{width:78px}html .zl-post td,html.zl-live .zl-post td{padding:8px 8px}}
  .zl-kinds{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
  @media (max-width:1100px){.zl-kinds{grid-template-columns:repeat(2,minmax(0,1fr))}}
  .zl-kind{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:12px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--card);cursor:pointer}
  .zl-kind:hover,.zl-kind:focus-visible{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
  .zl-kind i{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;flex:none}
  .zl-kind b{display:block;font-size:14.5px;font-weight:600}
  .zl-kind span{display:block;font-size:12.5px;color:var(--ink-3)}
  .zl-kind.in i{background:var(--good-soft);color:var(--good)}
  .zl-kind.out i{background:var(--bad-soft);color:var(--bad)}
  .zl-kind.tr i{background:var(--brand-soft);color:var(--brand)}
  .zl-kind.imp i{background:var(--sunk);color:var(--ink-2)}
  .zl-sumrow{display:flex;gap:28px;flex-wrap:wrap;font-size:13px;color:var(--ink-3)}
  .zl-sumrow b{display:block;font-size:17px;color:var(--ink);font-weight:600;margin-top:2px}
  .zl-amt-in{color:var(--good);font-weight:600}
  .zl-amt-out{color:var(--ink);font-weight:600}
  .zl-amt-tr{color:var(--ink-2);font-weight:500}
  .zl-ob{display:grid;gap:18px}
  .zl-ob h4{margin:0 0 6px;font-size:13px;font-weight:600;color:var(--ink-2)}
  .zl-ob-row{display:grid;grid-template-columns:minmax(0,1fr) 170px;gap:12px;align-items:center;padding:5px 0;border-bottom:1px solid var(--line-2);font-size:13.5px}
  .zl-ob-row small{color:var(--ink-3);display:block;font-size:12px}
  .zl-ob-row .zl-input{padding:7px 10px;text-align:right}
  .zl-ob-total{position:sticky;bottom:-18px;background:var(--card);border-top:1px solid var(--line);padding:12px 0 2px;display:flex;gap:24px;flex-wrap:wrap;font-size:13px;color:var(--ink-3)}
  .zl-ob-total b{display:block;color:var(--ink);font-size:15px}
  @media (max-width:760px){.zl-kinds{grid-template-columns:minmax(0,1fr)}.zl-ob-row{grid-template-columns:minmax(0,1fr) 130px}}
  `;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const IMP_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>`;
  const IN_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 7 7 17M7 8v9h9"/></svg>`;
  const OUT_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M8 7h9v9"/></svg>`;
  const TR_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h13l-4-4M17 17H4l4 4"/></svg>`;

  /** Accounts money moves through: cash and bank, plus (personal) cards and pay-later. */
  const isMoney = (a) => a.is_cash || (ZL.isPersonal() && a.type === "LIABILITY" && a.sub_type === "CURRENT_LIABILITY");
  const usable = (a) => a.is_postable && a.is_active && !a.is_control;
  const label = (a) => `${a.name} · ${a.code}`;
  const TYPE_GROUP = () => ({
    ASSET: ZL.T("Assets", "What I own"), LIABILITY: ZL.T("Liabilities", "What I owe"), EQUITY: ZL.T("Equity", "Net worth"),
    REVENUE: ZL.T("Income", "Income"), COST_OF_SALES: "Cost of sales", EXPENSE: ZL.T("Expenses", "Spending"),
  });
  const options = (list, order) => {
    const g = TYPE_GROUP();
    return order.flatMap((t) => list.filter((a) => a.type === t).map((a) => ({ value: a.id, label: label(a), group: g[t] })));
  };

  function journalPreview(lines, accounts) {
    const acc = new Map(accounts.map((a) => [a.id, a]));
    const ok = lines.length >= 2 && lines.every((l) => l.account && l.amount > 0);
    if (!ok) return `<div class="zl-post"><div class="zl-post-h"><span>What gets posted</span></div>
      <table><tbody><tr><td class="nil">Fill in the amount and both accounts to see the journal.</td></tr></tbody></table></div>`;
    const dr = lines.filter((l) => l.side === "dr").reduce((s, l) => s + ZL.cents(l.amount), 0);
    const cr = lines.filter((l) => l.side === "cr").reduce((s, l) => s + ZL.cents(l.amount), 0);
    return `<div class="zl-post"><div class="zl-post-h"><span>What gets posted</span><span class="${dr === cr ? "ok" : ""}">${dr === cr ? "Balanced" : "Not balanced"}</span></div>
      <table><thead><tr><th></th><th class="r zl-amtcol">Debit</th><th class="r zl-amtcol">Credit</th></tr></thead><tbody>${lines.map((l) => {
        const a = acc.get(l.account) || { code: "", name: l.label || "" };
        return `<tr><td>${l.side === "dr" ? "" : '<span style="display:inline-block;width:18px"></span>'}${E(a.name)} <span class="code">${E(a.code)}</span></td>
          <td class="r num zl-amtcol">${l.side === "dr" ? M(l.amount) : ""}</td><td class="r num zl-amtcol">${l.side === "cr" ? M(l.amount) : ""}</td></tr>`;
      }).join("")}</tbody></table></div>`;
  }

  const METHODS = ["Bank transfer", "DuitNow / FPX", "Cheque", "Cash", "Card", "Online banking", "Other"].map((m) => ({ value: m, label: m }));

  /** Money in / money out / transfer. Resolves with the posting result, or null. */
  ZL.quick = async (kind, preset = {}) => {
    if (!(ZL.can("journal.create") && ZL.can("journal.post"))) {
      ZL.toast("Your role can't record transactions in these books.", "bad");
      return null;
    }
    const accounts = (await ZL.accounts()).filter(usable);
    const money = accounts.filter(isMoney);
    const P = ZL.isPersonal();
    const sst = !P && accounts.some((a) => a.code === "2150");
    if (!money.length) { ZL.toast("Create a cash or bank account first.", "bad"); return null; }
    // Start from the account used last time, else the main bank account.
    const prefKey = `zl.money.${cid()}`;
    let last = null;
    try { last = localStorage.getItem(prefKey); } catch (_) { /* ignore */ }
    const preferred = (money.find((a) => a.id === last) || money.find((a) => a.code === (P ? "1120" : "1131")) || money[0]).id;
    const others = accounts.filter((a) => !money.includes(a));
    const numRows = kind === "TRANSFER" ? [] : await ZL.numbering.load(ZL.today()).catch(() => []);
    let fields, title, confirm, numCtl = null, cap = null;
    if (kind === "OUT") {
      title = P ? "Money out" : "Record a payment";
      confirm = "Record payment";
      fields = [
        { name: "amount", label: "Amount", type: "amount", required: true, value: preset.amount || "" },
        { name: "date", label: "Date", type: "date", required: true, value: ZL.today(), half: true },
        { name: "money", label: "Paid from", type: "select", half: true, value: preset.money || preferred, options: money.map((a) => ({ value: a.id, label: label(a) })) },
        { name: "other", label: P ? "What for" : "Category", type: "select", required: true, value: "",
          options: [{ value: "", label: "Choose…" }].concat(options(others, ["EXPENSE", "COST_OF_SALES", "ASSET", "LIABILITY", "EQUITY"])) },
        ...(P ? [] : [{ name: "party", label: "Paid to", placeholder: "e.g. Tenaga Nasional Berhad", half: true, value: preset.party || "" },
          { name: "method", label: "Paid by", type: "select", half: true, value: preset.method || "Bank transfer", options: METHODS }]),
        { name: "description", label: P ? "Description" : "What it's for", placeholder: P ? "e.g. Groceries at Lotus's" : "e.g. Electricity for September", value: preset.description || "" },
        { name: "reference", label: P ? "Receipt or reference no." : "Their invoice or reference no.", placeholder: "Optional", value: preset.reference || "" },
      ];
    } else if (kind === "IN") {
      title = P ? "Money in" : "Record money received";
      confirm = "Record receipt";
      fields = [
        { name: "amount", label: "Amount", type: "amount", required: true, value: preset.amount || "" },
        { name: "date", label: "Date", type: "date", required: true, value: ZL.today(), half: true },
        { name: "money", label: "Received into", type: "select", half: true, value: preset.money || preferred, options: money.map((a) => ({ value: a.id, label: label(a) })) },
        { name: "other", label: P ? "Where it came from" : "Category", type: "select", required: true, value: "",
          options: [{ value: "", label: "Choose…" }].concat(options(others, ["REVENUE", "LIABILITY", "EQUITY", "ASSET"])) },
        ...(sst ? [{ name: "tax", label: "SST included in the amount", type: "select", value: "0",
          options: [{ value: "0", label: "No SST" }, { value: "8", label: "Service tax 8%" }, { value: "6", label: "Service tax 6%" }, { value: "10", label: "Sales tax 10%" }, { value: "5", label: "Sales tax 5%" }] }] : []),
        ...(P ? [] : [{ name: "party", label: "Received from", placeholder: "e.g. Syarikat ABC Sdn Bhd", half: true, value: preset.party || "" },
          { name: "method", label: "Received by", type: "select", half: true, value: preset.method || "Bank transfer", options: METHODS }]),
        { name: "description", label: P ? "Description" : "What it's for", placeholder: P ? "e.g. September salary" : "e.g. Payment for invoice 1024", value: preset.description || "" },
        { name: "reference", label: "Reference no.", placeholder: "Optional", value: preset.reference || "" },
      ];
    } else {
      const all = accounts.filter((a) => a.type === "ASSET" || a.type === "LIABILITY");
      title = "Transfer";
      confirm = "Record transfer";
      fields = [
        { name: "amount", label: "Amount", type: "amount", required: true, value: preset.amount || "" },
        { name: "date", label: "Date", type: "date", required: true, value: ZL.today() },
        { name: "money", label: "From", type: "select", half: true, value: preset.money || preferred, options: options(all, ["ASSET", "LIABILITY"]) },
        { name: "other", label: "To", type: "select", half: true, required: true, value: "",
          options: [{ value: "", label: "Choose…" }].concat(options(all, ["ASSET", "LIABILITY"])) },
        { name: "description", label: "Description", placeholder: P ? "e.g. Pay credit card bill" : "e.g. Move funds to CIMB" },
        { name: "reference", label: "Reference no.", placeholder: "Optional" },
      ];
    }
    if (kind !== "TRANSFER") {
      const at = fields.findIndex((f) => f.name === "other") + 1;
      fields.splice(at, 0, ...ZL.numbering.fields(numRows, ZL.numbering.KIND_OF[kind], preset.money || preferred));
    }
    fields.push({ name: "_preview", label: "", type: "hidden" });

    const linesFor = (v) => {
      const amt = Number.isNaN(v.amount) || !v.amount ? 0 : v.amount;
      if (kind === "IN") {
        const rate = Number(v.tax || 0);
        const net = rate ? Math.round((amt * 100) / (100 + rate) * 100) / 100 : amt;
        const tax = Math.round((amt - net) * 100) / 100;
        const tl = accounts.find((a) => a.code === "2150");
        return [{ side: "dr", account: v.money, amount: amt }, { side: "cr", account: v.other, amount: net }]
          .concat(tax > 0 && tl ? [{ side: "cr", account: tl.id, amount: tax }] : []);
      }
      return [{ side: "dr", account: v.other, amount: amt }, { side: "cr", account: v.money, amount: amt }];
    };

    return ZL.form({
      title, confirmLabel: confirm, fields,
      intro: kind === "TRANSFER" ? "Moves money between your own accounts — paying a card, saving, or withdrawing cash. Nothing is income or spending." : "",
      onOpen: (root) => {
        const slot = root.querySelector('[name="_preview"]').closest("label");
        slot.innerHTML = "";
        slot.className = "";
        const draw = () => { slot.innerHTML = journalPreview(linesFor(ZL.readForm(root, fields)), accounts); };
        root.addEventListener("input", draw);
        root.addEventListener("change", draw);
        draw();
        if (kind !== "TRANSFER") {
          const moneyInput = root.querySelector('[name="money"]');
          numCtl = ZL.numbering.wire(root, numRows, ZL.numbering.KIND_OF[kind],
            { money: () => moneyInput.value, moneyInput, dateInput: root.querySelector('[name="date"]') });
        }
        // The receipt or slip behind it: read into the form and kept with the entry.
        if (kind !== "TRANSFER" && ZL.capture) {
          const C = ZL.capture;
          cap = C.evidence({ root }, { preset: preset.attachment, fill: async (s, att, ev) => {
            if (s.total != null) C.put(root, "amount", M(Math.abs(s.total)));
            C.put(root, "date", s.date);
            const acc = await C.accountFor(s, others, { direction: kind });
            if (!C.put(root, "other", acc)) ev.note(P ? "Choose what it was for." : "Choose the category.");
            C.put(root, "party", (s.counterparty && s.counterparty.name) || "");
            C.put(root, "method", C.methodFor(s));
            if (!preset.money) C.put(root, "money", C.moneyFor(s, money));
            C.put(root, "description", s.summary);
            C.put(root, "reference", s.doc_no || s.payment_reference);
            if (kind === "IN" && s.tax_total > 0 && s.tax_rate) C.put(root, "tax", String(Math.round(s.tax_rate)));
            if (s.direction === (kind === "OUT" ? "MONEY_IN" : "MONEY_OUT")) {
              ev.note(`This looks like money ${kind === "OUT" ? "coming in" : "going out"}. Check you're recording it on the right side.`, "warn");
            }
          } });
        }
      },
      submit: async (v) => {
        if (!v.amount || v.amount <= 0) throw new ZL.ZLError("VALIDATION", "Enter an amount greater than zero.");
        if (!v.other) throw new ZL.ZLError("VALIDATION", `Choose ${kind === "TRANSFER" ? "where the money goes" : "a category"}.`);
        if (v.other === v.money) throw new ZL.ZLError("VALIDATION", "Choose two different accounts.");
        const num = numCtl ? numCtl.read() : {};
        const r = await ZL.rpc("record_transaction", {
          p_company: cid(), p_kind: kind, p_date: v.date, p_amount: v.amount, p_money_account: v.money,
          p_other_account: v.other, p_description: v.description || null, p_reference: v.reference || null,
          p_tax_rate: kind === "IN" ? Number(v.tax || 0) : 0, p_party: v.party || null, p_method: v.method || null,
          p_series: num.p_series || null, p_doc_no: num.p_doc_no || null,
        });
        try { if (money.some((a) => a.id === v.money)) localStorage.setItem(prefKey, v.money); } catch (_) { /* ignore */ }
        if (cap) await cap.link("JOURNAL", r.id);
        ZL.toast(r.doc_no ? `Recorded as ${r.doc_no} and posted (${r.reference}).` : `Recorded and posted as ${r.reference}.`);
        return r;
      },
    }).then((r) => { if (r) ZL.refresh(); return r; });
  };

  // ── Opening balances ──────────────────────────────────────────────────────
  ZL.openingBalances = async () => {
    if (!(ZL.can("journal.create") && ZL.can("journal.post"))) {
      ZL.toast("Your role can't post opening balances.", "bad");
      return;
    }
    const P = ZL.isPersonal();
    const [accounts, periods, existing] = await Promise.all([
      ZL.accounts(),
      ZL.select("fiscal_periods", "start_date,status", (q) => q.eq("company_id", cid()).order("start_date").limit(1)),
      ZL.select("journal_entries", "id,reference", (q) => q.eq("company_id", cid()).eq("source", "OPENING_BALANCE").eq("status", "POSTED").is("reversal_of_id", null).limit(1)),
    ]);
    if (existing[0]) {
      if (await ZL.confirm({ title: "Opening balances are posted", message: `They were posted as ${E(existing[0].reference)}. To change them, open that journal and reverse it, then enter them again.`, confirmLabel: "Open the journal" })) {
        ZL.open("journal", { id: existing[0].id });
      }
      return;
    }
    const plugCode = P ? "3100" : "3200";
    const plug = accounts.find((a) => a.code === plugCode);
    const list = accounts.filter((a) => usable(a) && ["ASSET", "LIABILITY", "EQUITY"].includes(a.type) && a.code !== plugCode);
    const controls = accounts.filter((a) => a.is_control && a.is_active);
    // Contra accounts sit on the other side from their group: accumulated depreciation, allowances, drawings.
    const contra = (a) => (a.type === "ASSET" && /^(accumulated|allowance)/i.test(a.name)) || (a.type === "EQUITY" && (a.code === "3300" || /drawing/i.test(a.name)));
    const groups = [
      ["ASSET", P ? "What you own" : "Assets"],
      ["LIABILITY", P ? "What you owe" : "Liabilities"],
      ...(P ? [] : [["EQUITY", "Equity"]]),
    ];
    const date = periods[0] ? periods[0].start_date : ZL.yearStart();
    const body = `
      <p class="zl-p" style="margin-bottom:14px">Enter what each account held when you start using Zycount. Leave the rest blank.
        The difference goes to <b>${E(plug ? plug.name : "equity")}</b> automatically, so the journal always balances.</p>
      ${controls.length ? `<p class="hint" style="margin:-6px 0 14px">${controls.map((a) => E(a.name)).join(" and ")} aren't listed: enter what each customer owes you and what you owe each supplier as an opening balance on that customer or supplier, so every amount can be knocked off later.</p>` : ""}
      <label class="zl-field" style="max-width:220px;margin-bottom:16px"><span>Balances as at</span><input class="zl-input" type="date" id="zl-ob-date" value="${E(date)}"></label>
      <div class="zl-ob">${groups.map(([t, title]) => `<div><h4>${title}</h4>${list.filter((a) => a.type === t).map((a) => `
        <label class="zl-ob-row"><span>${E(a.name)} <span class="code">${E(a.code)}</span>${contra(a) ? `<small>Enter as a positive number — it reduces ${a.type === "ASSET" ? "the asset" : "equity"}.</small>` : ""}</span>
          <input class="zl-input num" data-ob="${a.id}" data-type="${a.type}" data-contra="${contra(a) ? 1 : 0}" inputmode="decimal" placeholder="0.00" aria-label="${E(a.name)}"></label>`).join("")}</div>`).join("")}
      </div>
      <div class="zl-ob-total" id="zl-ob-total"></div>`;
    const dialog = ZL.modal({
      title: "Opening balances",
      wide: true,
      body,
      actions: [
        { label: "Cancel" },
        {
          label: "Post opening balances", primary: true,
          onClick: async ({ root, close }) => {
            const lines = [];
            for (const inp of root.querySelectorAll("[data-ob]")) {
              const v = ZL.parseAmount(inp.value);
              if (Number.isNaN(v)) throw new ZL.ZLError("VALIDATION", `${inp.getAttribute("aria-label")}: enter a number like 1,250.00.`);
              if (v) lines.push({ account_id: inp.dataset.ob, amount: v });
            }
            if (!lines.length) throw new ZL.ZLError("VALIDATION", "Enter at least one balance.");
            const r = await ZL.rpc("post_opening_balances", { p_company: cid(), p_date: root.querySelector("#zl-ob-date").value, p_lines: lines });
            close();
            ZL.toast(`Opening balances posted as ${r.reference}.`);
            ZL.refresh();
          },
        },
      ],
    });
    const root = dialog.root;
    const total = root.querySelector("#zl-ob-total");
    const draw = () => {
      let own = 0, owe = 0, eq = 0, bad = false;
      root.querySelectorAll("[data-ob]").forEach((inp) => {
        const v = ZL.parseAmount(inp.value);
        if (Number.isNaN(v)) { bad = true; return; }
        const c = Math.round(v * 100);
        if (inp.dataset.type === "ASSET") own += inp.dataset.contra === "1" ? -c : c;
        else if (inp.dataset.type === "LIABILITY") owe += c;
        else eq += inp.dataset.contra === "1" ? -c : c;
      });
      const plugAmt = own - owe - eq;
      total.innerHTML = bad ? `<span style="color:var(--bad)">An amount isn't a number.</span>` : `
        <span>${P ? "You own" : "Assets"}<b>${M(own / 100)}</b></span>
        <span>${P ? "You owe" : "Liabilities"}<b>${M(owe / 100)}</b></span>
        ${P ? "" : `<span>Other equity<b>${M(eq / 100)}</b></span>`}
        <span>${E(plug ? plug.name : "Balancing figure")}<b>${M(plugAmt / 100)}</b></span>`;
    };
    root.addEventListener("input", draw);
    root.querySelectorAll("[data-ob]").forEach((inp) => inp.addEventListener("blur", () => {
      const v = ZL.parseAmount(inp.value);
      if (!Number.isNaN(v) && v) inp.value = M(v);
    }));
    draw();
  };

  // ── Transactions page ──────────────────────────────────────────────────────
  /** In, out, transfer or reversal — as chosen in the form (txn_kind), else inferred from the lines. */
  function classify(entry, acc) {
    const lines = entry.journal_lines || [];
    const dr = lines.filter((l) => ZL.cents(l.debit) > 0), cr = lines.filter((l) => ZL.cents(l.credit) > 0);
    if (entry.reversal_of_id) return { kind: "REVERSAL", money: cr[0], other: dr[0] };
    if (entry.txn_kind === "IN") return { kind: "IN", money: dr[0], other: cr[0] };
    if (entry.txn_kind === "OUT") return { kind: "OUT", money: cr[0], other: dr[0] };
    if (entry.txn_kind === "TRANSFER") return { kind: "TRANSFER", money: cr[0], other: dr[0] };
    const m = (l) => { const a = acc.get(l.account_id); return a && isMoney(a); };
    const drMoney = lines.filter((l) => ZL.cents(l.debit) > 0 && m(l));
    const crMoney = lines.filter((l) => ZL.cents(l.credit) > 0 && m(l));
    const drOther = lines.filter((l) => ZL.cents(l.debit) > 0 && !m(l));
    const crOther = lines.filter((l) => ZL.cents(l.credit) > 0 && !m(l));
    if (drMoney.length && !crMoney.length) return { kind: "IN", money: drMoney[0], other: crOther[0] };
    if (crMoney.length && !drMoney.length) return { kind: "OUT", money: crMoney[0], other: drOther[0] };
    const from = lines.find((l) => ZL.cents(l.credit) > 0), to = lines.find((l) => ZL.cents(l.debit) > 0);
    return { kind: "TRANSFER", money: from, other: to };
  }

  ZL.register("transactions", {
    title: "Transactions",
    perm: "journal.view",
    async render(ctx) {
      const p = ctx.params;
      const size = p.limit || 100, want = p.kind || "", term = String(p.q || "").replace(/[,()*%\\:"']/g, " ").trim().slice(0, 80);
      const [accounts, page, opening, monthRows] = await Promise.all([
        ZL.accounts(),
        ZL.page("journal_entries", "id,reference,date,description,memo,status,total_debit,created_at,reversal_of_id,txn_kind,doc_no,party,journal_lines(account_id,debit,credit)",
          (q) => {
            q = q.eq("company_id", cid()).eq("source", "BANK");
            if (term) q = q.or(`description.ilike.*${term}*,reference.ilike.*${term}*,memo.ilike.*${term}*,doc_no.ilike.*${term}*,party.ilike.*${term}*`);
            if (p.from) q = q.gte("date", p.from);
            if (p.to) q = q.lte("date", p.to);
            return q.order("date", { ascending: false }).order("created_at", { ascending: false });
          }, 0, size),
        ZL.count("journal_entries", (q) => q.eq("company_id", cid()).eq("source", "OPENING_BALANCE").eq("status", "POSTED").is("reversal_of_id", null)),
        // Month totals come from their own query: every posted receipt and payment this month, whatever the page shows.
        ZL.select("journal_entries", "id,total_debit,txn_kind,journal_lines(account_id,debit,credit)",
          (q) => q.eq("company_id", cid()).eq("source", "BANK").eq("status", "POSTED").is("reversal_of_id", null)
            .gte("date", ZL.monthStart(ctx.today)).lte("date", ZL.monthEnd(ctx.today))),
      ]);
      const acc = new Map(accounts.map((a) => [a.id, a]));
      const rows = page.rows.map((e) => Object.assign({ c: classify(e, acc) }, e)).filter((r) => !want || r.c.kind === want);
      const thisMonth = monthRows.map((e) => ({ e, c: classify(e, acc) }));
      const inM = ZL.sum(thisMonth.filter((x) => x.c.kind === "IN"), (x) => x.e.total_debit);
      const outM = ZL.sum(thisMonth.filter((x) => x.c.kind === "OUT"), (x) => x.e.total_debit);
      const canRecord = ZL.can("journal.create") && ZL.can("journal.post");
      const P = ZL.isPersonal();
      const name = (l) => { const a = l && acc.get(l.account_id); return a ? E(a.name) : "—"; };
      const seg = [["", "All"], ["IN", "Money in"], ["OUT", "Money out"], ["TRANSFER", "Transfers"]].map(([v, l]) =>
        `<button type="button" data-tkind="${v}" aria-pressed="${want === v}">${l}</button>`).join("");
      const amount = (r) => r.c.kind === "IN" ? `<span class="zl-amt-in num">+${M(r.total_debit)}</span>`
        : r.c.kind === "OUT" ? `<span class="zl-amt-out num">−${M(r.total_debit)}</span>` : `<span class="zl-amt-tr num">${M(r.total_debit)}</span>`;
      const counts = (r) => r.status !== "REVERSED" && r.c.kind !== "REVERSAL";
      const kinds = canRecord ? `
        <div class="zl-kinds">
          <button type="button" class="zl-kind in" data-quick="IN"><i>${IN_ICON}</i><span><b>Money in</b><span>${P ? "Salary, refunds, gifts" : "Customer payments, other income"}</span></span></button>
          <button type="button" class="zl-kind out" data-quick="OUT"><i>${OUT_ICON}</i><span><b>Money out</b><span>${P ? "Spending and bills" : "Bills, expenses, purchases"}</span></span></button>
          <button type="button" class="zl-kind tr" data-quick="TRANSFER"><i>${TR_ICON}</i><span><b>Transfer</b><span>${P ? "Between your own accounts" : "Between bank and cash accounts"}</span></span></button>
          <button type="button" class="zl-kind imp" data-import><i>${IMP_ICON}</i><span><b>Import statement</b><span>${P ? "Any bank or card — PDF, CSV or Excel" : "Bank PDF, CSV or Excel"}</span></span></button>
        </div>` : "";
      return ZL.header(P ? "Money in & out" : "Transactions", "Each one is posted as a balanced journal the moment you save it.",
          canRecord ? `<button type="button" class="zl-btn${opening ? " ghost" : ""}" id="zl-ob">${opening ? `${TICK} Opening balances posted` : "Enter opening balances"}</button>` : "") +
        kinds + `
        <div class="zl-sumrow"><span>In this month<b class="num">${M(inM, { symbol: true })}</b></span><span>Out this month<b class="num">${M(outM, { symbol: true })}</b></span>
          <span>Net<b class="num">${M(inM - outM, { symbol: true })}</b></span></div>
        <div class="toolbar">
          <label class="field in"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>
            <input id="zl-tq" type="search" value="${E(p.q || "")}" placeholder="${P ? "Search description or reference" : "Search PV/OR no., payee or description"}" aria-label="Search transactions"></label>
          <div class="seg" role="group" aria-label="Kind">${seg}</div>
          <label class="field"><span class="hint">From</span><input id="zl-tfrom" type="date" value="${E(p.from || "")}" aria-label="From date"></label>
          <label class="field"><span class="hint">To</span><input id="zl-tto" type="date" value="${E(p.to || "")}" aria-label="To date"></label>
          ${ZL.applyButton("zl-tapply")}
          ${p.from || p.to ? '<button type="button" class="zl-btn ghost sm" id="zl-tclear">Clear dates</button>' : ""}
          <span class="count"><b>${rows.length}</b>${want ? "" : ` of ${page.count}`}</span>
        </div>
        ${rows.length ? `<section class="card"><div class="tablewrap"><table>
          <thead><tr><th>Date</th><th>Description</th><th>${P ? "Account" : "Bank / cash"}</th><th>${P ? "Category" : "Category"}</th><th class="r">Amount</th><th>${P ? "Journal" : "Voucher"}</th></tr></thead>
          <tbody>${rows.map((r) => `<tr class="click" data-open-journal="${r.id}">
            <td class="nil" style="white-space:nowrap">${ZL.date(r.date)}</td>
            <td><div style="font-weight:500">${E(r.description || "—")}</div>${r.party || r.memo ? `<div class="hint">${E([r.party, r.memo].filter(Boolean).join(" · "))}</div>` : ""}</td>
            <td>${r.c.kind === "TRANSFER" ? `${name(r.c.money)} → ${name(r.c.other)}` : name(r.c.money)}</td>
            <td class="nil">${r.c.kind === "TRANSFER" ? "Transfer" : r.c.kind === "REVERSAL" ? "Reversal" : name(r.c.other)}</td>
            <td class="r" style="white-space:nowrap${counts(r) ? "" : ";text-decoration:line-through;opacity:.6"}" title="${counts(r) ? "" : "Cancelled by a reversal; not counted"}">${amount(r)}</td>
            <td style="white-space:nowrap">${r.doc_no ? `<button type="button" class="zl-ref" data-voucher="${r.id}" title="Open, print or save as PDF">${E(r.doc_no)}</button><div class="hint">${E(r.reference || "")}</div>`
              : `<span class="zl-ref">${E(r.reference || "")}</span>`}${r.status === "REVERSED" ? ' <span class="chip warn">Reversed</span>' : ""}</td></tr>`).join("")}</tbody>
        </table></div>
        ${page.count > page.rows.length ? `<div class="proofrow"><span>Showing the latest ${page.rows.length} of ${page.count}.</span><span class="figs"><button type="button" class="zl-btn sm" id="zl-tmore">Load 100 more</button></span></div>` : ""}
        </section>`
        : ZL.empty(term || want || p.from || p.to ? "Nothing matches" : "No transactions yet",
          term || want || p.from || p.to ? "Try another search, filter or date range." : `Record ${P ? "your salary, a bill or a transfer" : "a payment or money received"} and it appears here with its journal reference.`)}`;
    },
    after(root, ctx) {
      const p = ctx.params;
      root.querySelectorAll("[data-quick]").forEach((b) => b.addEventListener("click", () => ZL.quick(b.dataset.quick)));
      root.querySelectorAll("[data-import]").forEach((b) => b.addEventListener("click", () => ZL.uploadStatement()));
      const ob = root.querySelector("#zl-ob");
      if (ob) ob.addEventListener("click", () => ZL.openingBalances());
      root.querySelectorAll("[data-tkind]").forEach((b) => b.addEventListener("click", () => ZL.open("transactions", Object.assign({}, p, { kind: b.dataset.tkind, focus: null }))));
      const q = root.querySelector("#zl-tq");
      q.addEventListener("input", ZL.debounce(() => ZL.open("transactions", Object.assign({}, p, { q: q.value, focus: "q" })), 400));
      if (p.focus === "q") { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      const more = root.querySelector("#zl-tmore");
      if (more) more.addEventListener("click", () => ZL.open("transactions", Object.assign({}, p, { limit: (p.limit || 100) + 100, focus: null })));
      ZL.wireApply(root, ["zl-tfrom", "zl-tto"], "zl-tapply", () => {
        const from = root.querySelector("#zl-tfrom").value || null, to = root.querySelector("#zl-tto").value || null;
        if (from && to && from > to) { ZL.toast("The start date is after the end date.", "warn"); return; }
        ZL.open("transactions", Object.assign({}, p, { from, to, focus: null }));
      });
      const tclear = root.querySelector("#zl-tclear");
      if (tclear) tclear.addEventListener("click", () => ZL.open("transactions", Object.assign({}, p, { from: null, to: null, focus: null })));
      root.querySelectorAll("[data-voucher]").forEach((b) => b.addEventListener("click", (ev) => { ev.stopPropagation(); ZL.voucher(b.dataset.voucher); }));
      ZL.wireJournalLinks(root);
    },
  });
})();
