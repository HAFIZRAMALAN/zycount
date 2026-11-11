/* ═══════════════════════════════════════════════════════════════════════════
 * Zycount live workspace — making the books easy to read for a first-time user.
 *   ZL.sideBanner(side)   AR (money in, green) and AP (money out, amber) look
 *                         different everywhere, with one line saying what they are.
 *   ZL.tip(key, …)        a short explainer a user can close for good.
 *   ZL.term(key, label)   an accounting word that opens its plain-English meaning.
 *   owed                  Money owed: who owes you, whom you owe, side by side.
 *   reports               Every report with the question it answers.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const ZL = window.ZL;
  const E = ZL.esc;
  const M = ZL.money;
  const RM = (v) => ZL.money(v, { symbol: true });
  const cid = () => ZL.company.company_id;

  const ICON_IN = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>`;
  const ICON_OUT = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden><path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>`;

  /** Everything that tells AR and AP apart, in one place. */
  ZL.SIDE_INFO = {
    AR: { cls: "zs-ar", icon: ICON_IN, short: "Money in", name: "Accounts receivable (AR)", who: "customers",
      line: "Money your <b>customers owe you</b>. Invoices and debit notes add to it; receipts, credit notes and contra bring it down.",
      owed: "Customers owe you", act: "Receive payment", actType: "RECEIPT", list: "customers", docs: "sales", aging: "araging" },
    AP: { cls: "zs-ap", icon: ICON_OUT, short: "Money out", name: "Accounts payable (AP)", who: "suppliers",
      line: "Money <b>you owe your suppliers</b>. Their invoices (bills) add to it; your payments, their credit notes and contra bring it down.",
      owed: "You owe suppliers", act: "Pay supplier", actType: "PAYMENT", list: "suppliers", docs: "purchases", aging: "apaging" },
  };

  /** A coloured strip under a page title saying which side of the books this is. */
  ZL.sideBanner = (side, extra = "") => {
    const s = ZL.SIDE_INFO[side];
    if (!s) return "";
    return `<div class="zs-banner ${s.cls}" role="note"><span class="zs-ic">${s.icon}</span>
      <div><b>${s.short} · ${E(s.name)}</b><span>${s.line}${extra ? " " + extra : ""}</span></div>
      <button type="button" class="zs-q" data-term="${side}" aria-label="What is ${E(s.name)}?">?</button></div>`;
  };
  /** Small coloured tag: "Money in" / "Money out". */
  ZL.sideTag = (side) => { const s = ZL.SIDE_INFO[side]; return s ? `<span class="zs-tag ${s.cls}">${s.icon}${s.short}</span>` : ""; };

  // ── Plain-English glossary ────────────────────────────────────────────────
  const GLOSSARY = {
    AR: ["Accounts receivable (AR)", "Money other people owe <b>you</b> — usually customers who received an invoice and haven't paid yet. It is an asset: you will collect it. In Zycount it lives under <b>Sales</b>, shown in <span class='zs-txt zs-ar'>green</span>."],
    AP: ["Accounts payable (AP)", "Money <b>you</b> owe other people — usually suppliers whose invoice (a <i>bill</i>) you haven't paid yet. It is a liability: you will pay it. In Zycount it lives under <b>Purchases</b>, shown in <span class='zs-txt zs-ap'>amber</span>."],
    knockoff: ["Knock-off", "Linking a payment to the invoice or bill it pays, so both show as settled. A receipt of RM 500 knocked off a RM 500 invoice leaves nothing owing."],
    contra: ["Contra", "When a company is both your customer and your supplier, you can set what they owe you against what you owe them, instead of swapping money."],
    aging: ["Aging", "Unpaid invoices or bills sorted by how late they are: not yet due, 1–30 days late, 31–60, and so on. The older the money, the harder it is to collect."],
    pl: ["Profit & loss (P&L)", "What you earned and what it cost you <b>over a period</b> — a month, a quarter, a year. Revenue minus costs is your profit (or loss). It does not show cash in the bank."],
    bs: ["Balance sheet", "A snapshot <b>on one date</b>: what the business owns (assets), what it owes (liabilities) and what belongs to the owners (equity). Assets always equal liabilities plus equity."],
    tb: ["Trial balance", "Every account's balance in two columns, debits and credits. If the two totals are equal, the double entry is complete. Accountants start from it."],
    cf: ["Cash flow", "Where cash actually came from and went to. A business can show a profit and still run out of cash — for example when customers pay late."],
    gross: ["Gross profit", "Sales minus the direct cost of what you sold (stock, materials, subcontractors). It shows whether each sale makes money before overheads."],
    opex: ["Operating expenses", "The costs of running the business whatever you sell: rent, salaries, utilities, marketing, software."],
    margin: ["Net margin", "Profit as a share of sales. A 15% margin means you keep RM 0.15 of every RM 1 you sell, after every cost."],
    reconcile: ["Bank reconciliation", "Ticking every line on the bank statement against what is in your books, so you know both agree. Anything on the bank but not in the books still needs recording."],
    sst: ["SST", "Malaysia's Sales and Service Tax. Output tax is what you charge customers and pay to Customs; input tax is what suppliers charge you."],
    debit: ["Debit and credit", "Every entry has two sides that are always equal. Debits increase what you own and what you spend; credits increase what you owe, what you earn and the owner's capital."],
  };
  ZL.glossary = (focus) => {
    const keys = Object.keys(GLOSSARY);
    const m = ZL.modal({
      title: focus && GLOSSARY[focus] ? GLOSSARY[focus][0] : "Accounting words in plain English",
      wide: !focus,
      body: focus && GLOSSARY[focus] ? `<p class="zl-p" style="line-height:1.65">${GLOSSARY[focus][1]}</p>
          <p style="margin-top:14px"><button type="button" class="zl-ref" data-gall>See every word explained →</button></p>`
        : `<dl class="zs-gloss">${keys.map((k) => `<dt>${E(GLOSSARY[k][0])}</dt><dd>${GLOSSARY[k][1]}</dd>`).join("")}</dl>
          <p class="hint" style="margin-top:12px"><button type="button" class="zl-ref" data-tipsreset>Show the page tips again</button></p>`,
      actions: [{ label: "Got it", primary: true }],
    });
    const all = m.root.querySelector("[data-gall]");
    if (all) all.addEventListener("click", () => { m.close(); ZL.glossary(); });
    const rs = m.root.querySelector("[data-tipsreset]");
    if (rs) rs.addEventListener("click", () => {
      try { Object.keys(localStorage).filter((k) => k.startsWith("zl.tip.")).forEach((k) => localStorage.removeItem(k)); } catch (_) { /* ignore */ }
      m.close(); ZL.toast("Tips will show again."); ZL.refresh();
    });
  };
  /** An inline word with a dotted underline that explains itself. */
  ZL.term = (key, label) => `<button type="button" class="zs-term" data-term="${E(key)}">${E(label || (GLOSSARY[key] || [key])[0])}</button>`;

  /** A short explainer the user can dismiss for good. */
  ZL.tip = (key, title, body) => {
    try { if (localStorage.getItem("zl.tip." + key)) return ""; } catch (_) { /* show it */ }
    return `<div class="zs-tip" data-tip="${E(key)}"><div><b>${title}</b><span>${body}</span></div>
      <button type="button" class="zs-x" data-tipclose="${E(key)}" aria-label="Hide this tip">×</button></div>`;
  };

  // Clicks on tips and terms anywhere in the page.
  document.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-term]");
    if (t) { ev.preventDefault(); ev.stopPropagation(); ZL.glossary(t.dataset.term); return; }
    const x = ev.target.closest("[data-tipclose]");
    if (x) {
      try { localStorage.setItem("zl.tip." + x.dataset.tipclose, "1"); } catch (_) { /* ignore */ }
      const box = x.closest(".zs-tip"); if (box) box.remove();
    }
  });

  const css = document.createElement("style");
  css.textContent = `
  :root{--ar:#0d8f6a;--ar-soft:rgba(13,143,106,.10);--ap:#c46a12;--ap-soft:rgba(214,122,24,.12)}
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--ar:#34c79a;--ar-soft:rgba(52,199,154,.13);--ap:#f0a24a;--ap-soft:rgba(240,162,74,.14)}}
  :root[data-theme="dark"],:root[data-theme="dim"]{--ar:#34c79a;--ar-soft:rgba(52,199,154,.13);--ap:#f0a24a;--ap-soft:rgba(240,162,74,.14)}
  .zs-ar{--side:var(--ar);--side-soft:var(--ar-soft)}
  .zs-ap{--side:var(--ap);--side-soft:var(--ap-soft)}
  .zs-banner{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--side);border-left-width:4px;background:var(--side-soft);
    border-radius:10px;padding:10px 14px;margin:0 0 14px}
  .zs-banner .zs-ic{color:var(--side);margin-top:1px;flex:none}
  .zs-banner b{display:block;color:var(--side);font-size:13.5px;margin-bottom:1px}
  .zs-banner span{font-size:13px;color:var(--ink-2);line-height:1.5}
  .zs-banner > div{flex:1}
  .zs-q{flex:none;width:22px;height:22px;border-radius:50%;border:1px solid var(--side);color:var(--side);background:transparent;font-size:12px;font-weight:700;cursor:pointer}
  .zs-tag{display:inline-flex;align-items:center;gap:4px;color:var(--side);background:var(--side-soft);border-radius:99px;padding:1px 8px 1px 6px;font-size:11.5px;font-weight:600;white-space:nowrap}
  .zs-tag svg{width:12px;height:12px}
  .zs-txt{color:var(--side);font-weight:600}
  .zs-term{background:none;border:0;padding:0;font:inherit;color:inherit;border-bottom:1px dotted currentColor;cursor:help}
  .zs-tip{display:flex;gap:12px;align-items:flex-start;background:var(--brand-soft,rgba(33,86,232,.08));border-radius:10px;padding:10px 14px;margin:0 0 14px}
  .zs-tip > div{flex:1}.zs-tip b{display:block;font-size:13.5px;margin-bottom:2px}.zs-tip span{font-size:13px;color:var(--ink-2);line-height:1.55}
  .zs-x{border:0;background:none;color:var(--ink-3);font-size:18px;line-height:1;cursor:pointer;padding:0 2px}
  .zs-gloss{display:grid;grid-template-columns:minmax(0,200px) minmax(0,1fr);gap:10px 18px;margin:0}
  .zs-gloss dt{font-weight:600}.zs-gloss dd{margin:0;color:var(--ink-2);line-height:1.55}
  .zs-two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
  .zs-side{border:1px solid var(--line);border-top:4px solid var(--side);border-radius:12px;background:var(--card);padding:16px 18px;display:flex;flex-direction:column;gap:12px}
  .zs-side h3{margin:0;display:flex;gap:8px;align-items:center;color:var(--side);font-size:15px}
  .zs-big{font-size:28px;font-weight:600;font-variant-numeric:tabular-nums}
  .zs-figs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;font-size:12.5px;color:var(--ink-3)}
  .zs-figs b{display:block;font-size:15px;color:var(--ink);font-variant-numeric:tabular-nums}
  .zs-aging{display:flex;height:10px;border-radius:99px;overflow:hidden;background:var(--line-2)}
  .zs-aging i{display:block;height:100%}
  .zs-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--ink-3)}
  .zs-legend span::before{content:"";display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;background:var(--c)}
  .zs-top{width:100%;border-collapse:collapse;font-size:13px}
  .zs-top td{padding:6px 0;border-top:1px solid var(--line-2)}
  .zs-net{border-radius:12px;padding:14px 18px;margin-top:16px;background:var(--card);border:1px solid var(--line);display:flex;gap:16px;align-items:center;flex-wrap:wrap}
  .zs-net b{font-size:20px;font-variant-numeric:tabular-nums}
  .zs-reports{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
  .zs-rep{text-align:left;border:1px solid var(--line);border-radius:12px;background:var(--card);padding:16px;cursor:pointer;display:flex;flex-direction:column;gap:6px;font:inherit;color:inherit}
  .zs-rep:hover,.zs-rep:focus-visible{border-color:var(--brand);outline:none}
  .zs-rep b{font-size:14.5px}.zs-rep span{font-size:13px;color:var(--ink-2);line-height:1.5}.zs-rep em{font-style:normal;font-size:12px;color:var(--ink-3)}
  .zs-rep .q{color:var(--brand);font-weight:500}
  @media (max-width:760px){.zs-two{grid-template-columns:minmax(0,1fr)}.zs-gloss{grid-template-columns:minmax(0,1fr)}.zs-gloss dd{margin-bottom:6px}}
  `;
  document.head.appendChild(css);

  // ══ Money owed: AR and AP side by side ═════════════════════════════════════
  const BUCKETS = [["not_due", "Not due yet", "var(--good,#16a34a)"], ["d1_30", "1–30 days late", "#e0b100"], ["d31_60", "31–60", "#f08c00"],
    ["d61_90", "61–90", "#e8590c"], ["late90", "Over 90", "var(--bad,#d62828)"]];
  const sumUp = (rows) => {
    const t = { not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, late90: 0, unapplied: 0, balance: 0 };
    rows.forEach((r) => {
      t.not_due += ZL.cents(r.not_due); t.d1_30 += ZL.cents(r.d1_30); t.d31_60 += ZL.cents(r.d31_60); t.d61_90 += ZL.cents(r.d61_90);
      t.late90 += ZL.cents(r.d91_120) + ZL.cents(r.d120_plus); t.unapplied += ZL.cents(r.unapplied); t.balance += ZL.cents(r.balance);
    });
    Object.keys(t).forEach((k) => { t[k] /= 100; });
    t.overdue = (ZL.cents(t.d1_30) + ZL.cents(t.d31_60) + ZL.cents(t.d61_90) + ZL.cents(t.late90)) / 100;
    return t;
  };

  ZL.register("owed", {
    title: "Money owed",
    perm: "journal.view",
    business: true,
    async render(ctx) {
      const [ar, ap] = await Promise.all([
        ZL.rpc("trade_aging", { p_company: cid(), p_side: "AR", p_as_at: ctx.today }).catch(() => []),
        ZL.rpc("trade_aging", { p_company: cid(), p_side: "AP", p_as_at: ctx.today }).catch(() => []),
      ]);
      const card = (side, rows) => {
        const s = ZL.SIDE_INFO[side], t = sumUp(rows);
        const total = Math.max(0.01, BUCKETS.reduce((x, [k]) => x + Math.max(0, t[k]), 0));
        const top = rows.filter((r) => ZL.num(r.balance) > 0).sort((a, b) => ZL.num(b.balance) - ZL.num(a.balance)).slice(0, 5);
        const can = ZL.can("journal.create");
        return `<section class="zs-side ${s.cls}">
          <h3>${s.icon}${s.short} — ${E(s.owed)}</h3>
          <div><div class="zs-big">${RM(t.balance)}</div><div class="hint">${E(s.name)} · ${(() => { const k = rows.filter((r) => ZL.num(r.balance) > 0).length; return `${k} ${k === 1 ? s.who.replace(/s$/, "") : s.who}`; })()} with a balance</div></div>
          <div class="zs-figs"><div>Not due yet<b>${M(t.not_due)}</b></div><div>Overdue<b style="${t.overdue > 0 ? "color:var(--bad)" : ""}">${M(t.overdue)}</b></div>
            <div>Over 90 days<b style="${t.late90 > 0 ? "color:var(--bad)" : ""}">${M(t.late90)}</b></div></div>
          <div><div class="zs-aging" aria-label="How late the money is">${BUCKETS.map(([k, , c]) => (t[k] > 0 ? `<i style="width:${(t[k] / total) * 100}%;background:${c}" title="${E(k)}"></i>` : "")).join("")}</div>
            <div class="zs-legend" style="margin-top:6px">${BUCKETS.map(([k, l, c]) => `<span style="--c:${c}">${l} ${M(t[k])}</span>`).join("")}</div></div>
          ${top.length ? `<table class="zs-top"><tbody>${top.map((r) => `<tr class="click" data-owc="${r.contact_id}" data-side="${side}"><td>${E(r.name)}</td>
            <td class="r num">${M(r.balance)}</td><td class="r" style="width:90px">${ZL.num(r.d1_30) + ZL.num(r.d31_60) + ZL.num(r.d61_90) + ZL.num(r.d91_120) + ZL.num(r.d120_plus) > 0 ? '<span class="chip bad">Late</span>' : '<span class="chip">On time</span>'}</td></tr>`).join("")}</tbody></table>`
            : `<p class="hint">Nothing ${side === "AR" ? "owed to you" : "to pay"} right now.</p>`}
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:auto">
            ${can ? `<button type="button" class="zl-btn primary" data-owpay="${s.actType}">${s.act}</button>` : ""}
            <button type="button" class="zl-btn" data-owgo="${s.aging}">Full aging</button>
            <button type="button" class="zl-btn ghost" data-owgo="${s.docs}">${side === "AR" ? "Sales documents" : "Purchase documents"}</button></div>
        </section>`;
      };
      const tAR = sumUp(ar), tAP = sumUp(ap);
      const net = (ZL.cents(tAR.balance) - ZL.cents(tAP.balance)) / 100;
      return ZL.header("Money owed", "Who owes you, and whom you owe — side by side, as at today.") +
        ZL.tip("owed", "Two sides of the same idea", `${ZL.term("AR", "Receivables")} (green) is money coming <b>in</b> from customers. ${ZL.term("AP", "Payables")} (amber) is money going <b>out</b> to suppliers. Late money is shown in red — chase the oldest first.`) + `
        <div class="zs-two">${card("AR", ar)}${card("AP", ap)}</div>
        <div class="zs-net"><span class="hint">If every customer paid and you paid every supplier today, you would be</span>
          <b style="color:${net >= 0 ? "var(--ar)" : "var(--ap)"}">${net >= 0 ? "" : "−"}${RM(Math.abs(net))} ${net >= 0 ? "better off" : "worse off"}</b>
          <span class="hint">(${M(tAR.balance)} in − ${M(tAP.balance)} out)</span></div>`;
    },
    after(root) {
      root.querySelectorAll("[data-owgo]").forEach((b) => b.addEventListener("click", () => go(b.dataset.owgo)));
      root.querySelectorAll("[data-owpay]").forEach((b) => b.addEventListener("click", () => ZL.tradePay && ZL.tradePay(b.dataset.owpay)));
      root.querySelectorAll("[data-owc]").forEach((tr) => tr.addEventListener("click", () => ZL.open("contact", { id: tr.dataset.owc, side: tr.dataset.side })));
    },
  });

  // ══ Reports hub ═════════════════════════════════════════════════════════════
  ZL.register("reports", {
    title: "Reports",
    perm: "report.view",
    async render() {
      const P = ZL.isPersonal();
      const R = (route, title, q, body, term, biz) => (biz && P) || !ZL.modules[route] ? "" : `<div class="zs-rep" role="link" tabindex="0" data-rep="${route}">
        <b>${title}</b><span class="q">${q}</span><span>${body}</span>${term ? `<em>${ZL.term(term, "What does this mean?")}</em>` : ""}</div>`;
      return ZL.header("Reports", "Pick the question you want answered. Every figure comes from posted entries and opens down to the document.") +
        ZL.tip("reports", "New to accounting?", "Start with <b>Profit & loss</b> (did I make money?) and <b>Money owed</b> (who still has to pay?). The balance sheet and trial balance are what your accountant will ask for.") + `
        <h3 style="font-size:14px;margin:6px 0 10px">How did ${P ? "I" : "we"} do?</h3>
        <div class="zs-reports">
          ${R("pl", P ? "Income & spending" : "Profit & loss", P ? "Did I save money this month?" : "Did we make a profit?", P ? "What came in, what went out, and what you kept." : "Sales minus costs for any period, with the month-by-month view and % of sales.", "pl")}
          ${R("cf", "Cash flow", "Where did the cash go?", "Why the bank balance moved — trading, buying equipment, loans and owner money.", "cf")}
          ${R("sst", "SST summary", "How much SST do we owe Customs?", "Output and input tax by tax code for the period, checked against the ledger.", "sst", true)}
        </div>
        <h3 style="font-size:14px;margin:20px 0 10px">Who owes what?</h3>
        <div class="zs-reports">
          ${R("owed", "Money owed", "Receivables and payables side by side", "Totals, what's late, and the biggest balances on each side.", "AR", true)}
          ${R("araging", "Receivables aging", "Which customers are late?", "Every customer's unpaid invoices by days overdue.", "aging", true)}
          ${R("apaging", "Payables aging", "Which bills are due?", "Every supplier's unpaid bills by days overdue.", "aging", true)}
        </div>
        <h3 style="font-size:14px;margin:20px 0 10px">For ${P ? "the record" : "your accountant"}</h3>
        <div class="zs-reports">
          ${R("bs", P ? "Net worth" : "Balance sheet", P ? "What do I own and owe?" : "What does the business own and owe?", "A snapshot on any date; it always balances.", "bs")}
          ${R("tb", "Trial balance", "Do debits equal credits?", "Every account's balance. The starting point for year-end accounts.", "tb")}
          ${R("gl", "General ledger", "What went through one account?", "Every posted line with a running balance.", "debit")}
          ${R("bankrec", P ? "Match bank statement" : "Bank reconciliation", "Do the bank and the books agree?", "Upload a statement; Zycount ticks off what matches.", "reconcile")}
        </div>`;
    },
    after(root) {
      root.querySelectorAll("[data-rep]").forEach((b) => {
        b.addEventListener("click", (ev) => { if (ev.target.closest("[data-term]")) return; go(b.dataset.rep); });
        b.addEventListener("keydown", (ev) => { if ((ev.key === "Enter" || ev.key === " ") && ev.target === b) { ev.preventDefault(); go(b.dataset.rep); } });
      });
    },
  });
})();
