/* ═══════════════════════════════════════════════════════════════════════════
 * Zycount live workspace — the books: dashboard, chart of accounts, journals
 * (list, editor, detail), general ledger and fiscal periods.
 * Every figure is read from the company's posted journal lines; every change
 * goes through a permission-checked database function (see supabase/migrations).
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const ZL = window.ZL;
  const E = ZL.esc;
  const M = ZL.money;

  const TYPE_LABEL = { ASSET: "Asset", LIABILITY: "Liability", EQUITY: "Equity", REVENUE: "Revenue", COST_OF_SALES: "Cost of sales", EXPENSE: "Expense" };
  const TYPES = Object.keys(TYPE_LABEL);
  const typeLabel = (t) => ZL.isPersonal()
    ? { ASSET: "I own", LIABILITY: "I owe", EQUITY: "Net worth", REVENUE: "Income", COST_OF_SALES: "Cost of sales", EXPENSE: "Spending" }[t]
    : TYPE_LABEL[t];
  /** Balance on the account's usual side: what you own, owe, earn or spend, as a positive number. */
  const natural = (type, signed) => (type === "ASSET" || type === "EXPENSE" || type === "COST_OF_SALES" ? signed : -signed);
  const titleCase = (s) => (s === s.toUpperCase() ? (s.charAt(0) + s.slice(1).toLowerCase()).replace(/\bi\b/g, "I") : s);
  ZL.typeLabel = typeLabel;
  ZL.natural = natural;
  const SUB_TYPES = ["CURRENT_ASSET", "NON_CURRENT_ASSET", "CURRENT_LIABILITY", "NON_CURRENT_LIABILITY", "EQUITY",
    "OPERATING_REVENUE", "OTHER_INCOME", "COST_OF_SALES", "OPERATING_EXPENSE", "OTHER_EXPENSE"];
  const nice = (s) => String(s || "").replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
  const cid = () => ZL.company.company_id;
  const amt = (v) => (ZL.cents(v) ? `<span class="num mono">${M(v)}</span>` : `<span class="nil">—</span>`);
  const statusChip = (s) => s === "POSTED" ? `<span class="chip ok">${TICK}Posted</span>`
    : s === "REVERSED" ? `<span class="chip warn">Reversed</span>` : `<span class="chip">Draft</span>`;
  const refCell = (e) => e.reference
    ? `<span class="zl-ref">${E(e.reference)}</span>`
    : `<span class="nil" style="font-style:italic;font-size:12px">Draft</span>`;
  const searchIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>`;
  const btn = (id, label, cls = "") => `<button type="button" class="zl-btn ${cls}" id="${id}">${label}</button>`;
  const monthName = (iso) => new Date(`${iso.slice(0, 7)}-01T00:00:00Z`).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

  const CSS = `
  .zl-je-head{display:grid;grid-template-columns:180px minmax(0,2fr) minmax(0,1.3fr);gap:14px;padding:18px 20px;border-bottom:1px solid var(--line-2)}
  html .zl-lines td,html.zl-live .zl-lines td{padding:6px 6px;height:auto}
  html .zl-lines td:first-child,html.zl-live .zl-lines td:first-child{padding-left:16px;color:var(--ink-3);font-size:12.5px}
  .zl-lines th:first-child{padding-left:16px}
  .zl-lines .zl-input{padding:7px 9px;font-size:13.5px}
  html .zl-lines tfoot td,html.zl-live .zl-lines tfoot td{background:var(--sunk);border-top:1px solid var(--line);padding:10px 6px;font-weight:600}
  .zl-proof ul{list-style:none;margin:0;padding:0 20px 16px;display:grid;gap:12px}
  .zl-proof li{display:grid;grid-template-columns:24px minmax(0,1fr);gap:10px;align-items:start}
  .zl-proof li i{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-style:normal;font-weight:700;font-size:12px;background:var(--good-soft);color:var(--good)}
  .zl-proof li.bad i{background:var(--bad-soft);color:var(--bad)}
  .zl-proof li b{display:block;font-weight:500;font-size:13.5px}
  .zl-proof li small{display:block;color:var(--ink-3);font-size:12.5px;margin-top:1px}
  .zl-steps{list-style:none;margin:0;padding:6px 14px 14px;display:grid;gap:2px}
  .zl-steps li{display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--line-2)}
  .zl-steps li:last-child{border-bottom:0}
  .zl-steps .n{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:600;background:var(--sunk);color:var(--ink-2)}
  .zl-steps .n.done{background:var(--good-soft);color:var(--good)}
  .zl-steps b{font-weight:500;display:block}
  .zl-steps span.hint{display:block}
  .zl-banner{display:flex;gap:9px;align-items:center;border:1px solid var(--line);border-left:3px solid var(--warn);
    background:var(--warn-soft);border-radius:var(--r);padding:9px 12px;font-size:12.5px;color:var(--ink-2)}
  .zl-banner.info{border-left-color:var(--brand);background:var(--brand-soft)}
  .zl-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:1px;background:var(--line-2)}
  .zl-kv>div{background:var(--card);padding:10px 14px;font-size:12px;color:var(--ink-3)}
  .zl-kv b{display:block;color:var(--ink);font-weight:500;font-size:13px;margin-top:2px}
  .zl-owed-top{display:flex;gap:28px;padding:4px 20px 12px}
  .zl-owed-top .kval{font-size:22px}
  .zl-owed-bar{display:flex;height:10px;border-radius:99px;overflow:hidden;margin:0 20px;background:var(--line)}
  .zl-owed-bar i{display:block;height:100%}
  .zl-owed-key{display:flex;flex-wrap:wrap;gap:6px 14px;padding:10px 20px 12px;font-size:12px;color:var(--ink-3)}
  .zl-owed-key i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;vertical-align:middle}
  .zl-owed-key b{color:var(--ink);font-weight:500;margin-left:3px}
  .zl-je-num{display:grid;grid-template-columns:repeat(2,minmax(0,260px));gap:14px;padding:12px 20px;border-bottom:1px solid var(--line-2)}
  @media (max-width:900px){.zl-je-head,.zl-je-num{grid-template-columns:minmax(0,1fr)}}
  `;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  // ── charts sized to the company's own figures ────────────────────────────
  const niceStep = (x) => {
    if (!(x > 0)) return 1;
    const p = 10 ** Math.floor(Math.log10(x));
    const f = x / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  };
  const scale = (values) => {
    let max = Math.max(0, ...values), min = Math.min(0, ...values);
    if (max === min) max = min + 1000;
    const step = niceStep((max - min) / 5);
    return { max: Math.ceil(max / step) * step, min: Math.floor(min / step) * step, step };
  };

  function trendChart(rows) {
    const W = 840, H = 300, L = 58, R = 14, T = 14, B = 30;
    const iw = W - L - R, ih = H - T - B;
    const s = scale(rows.flatMap((r) => [r.revenue, r.expenses, r.profit]));
    const y = (v) => T + ih - ((v - s.min) / (s.max - s.min)) * ih;
    const band = iw / Math.max(rows.length, 1), bw = Math.min(20, band / 3.2);
    let grid = "", bars = "", labels = "";
    const pts = [];
    for (let v = s.min; v <= s.max + 1e-6; v += s.step) {
      grid += `<line x1="${L}" y1="${y(v).toFixed(1)}" x2="${W - R}" y2="${y(v).toFixed(1)}" stroke="var(--line)"${v ? ' stroke-dasharray="2 4"' : ""}/>`;
      grid += `<text x="${L - 9}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" fill="var(--ink-3)" font-size="10" font-family="IBM Plex Mono, monospace">${compact(v)}</text>`;
    }
    rows.forEach((r, i) => {
      const cx = L + band * (i + 0.5);
      const bar = (v, x, fill) => {
        const top = Math.min(y(0), y(v)), h = Math.max(v ? 2 : 0, Math.abs(y(0) - y(v)));
        return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw}" height="${h.toFixed(1)}" rx="3" fill="${fill}"/>`;
      };
      bars += bar(r.revenue, cx - bw - 1.5, "var(--c1)") + bar(r.expenses, cx + 1.5, "var(--c2)");
      labels += `<text x="${cx.toFixed(1)}" y="${H - 9}" text-anchor="middle" fill="var(--ink-3)" font-size="11">${r.label}</text>`;
      pts.push([cx, y(r.profit)]);
    });
    const line = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    const dots = pts.map((p) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.2" fill="var(--card)" stroke="var(--c4)" stroke-width="2"/>`).join("");
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:560px;display:block" role="img"
      aria-label="Revenue, expenses and net profit by month">${grid}${bars}
      ${pts.length > 1 ? `<polyline fill="none" stroke="var(--c4)" stroke-width="2" stroke-linejoin="round" points="${line}"/>` : ""}${dots}${labels}</svg>`;
  }

  function cashLine(rows) {
    const W = 420, H = 190, L = 50, R = 12, T = 12, B = 26;
    const iw = W - L - R, ih = H - T - B;
    const s = scale(rows.map((r) => r.cash));
    const y = (v) => T + ih - ((v - s.min) / (s.max - s.min)) * ih;
    const x = (i) => L + (rows.length > 1 ? (iw / (rows.length - 1)) * i : iw / 2);
    let grid = "";
    for (let v = s.min; v <= s.max + 1e-6; v += s.step) {
      grid += `<line x1="${L}" y1="${y(v).toFixed(1)}" x2="${W - R}" y2="${y(v).toFixed(1)}" stroke="var(--line)"${v ? ' stroke-dasharray="2 4"' : ""}/>`;
      grid += `<text x="${L - 8}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" fill="var(--ink-3)" font-size="9.5" font-family="IBM Plex Mono, monospace">${compact(v)}</text>`;
    }
    const pts = rows.map((r, i) => [x(i), y(r.cash)]);
    const line = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    const area = `${pts[0][0].toFixed(1)},${y(0).toFixed(1)} ${line} ${pts[pts.length - 1][0].toFixed(1)},${y(0).toFixed(1)}`;
    const last = pts[pts.length - 1];
    const ticks = rows.map((r, i) => `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="var(--ink-3)" font-size="10">${r.label}</text>`).join("");
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:320px;display:block" role="img" aria-label="Cash and bank balance at each month end">
      ${grid}<polygon points="${area}" fill="var(--c5)" opacity="0.12"/>
      <polyline fill="none" stroke="var(--c5)" stroke-width="2" stroke-linejoin="round" points="${line}"/>
      <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.4" fill="var(--c5)" stroke="var(--card)" stroke-width="2"/>${ticks}</svg>`;
  }

  // ══ Dashboard ═════════════════════════════════════════════════════════════
  /** The database's own check that the books are whole — shown, not claimed. */
  function proofHtml(p) {
    const P = ZL.isPersonal();
    const eqPlusResult = ZL.num(p.equity) + ZL.num(p.result);
    const rows = [
      [p.unbalanced === 0, "Every posted entry balances",
        p.unbalanced === 0 ? `${p.entries} entr${p.entries === 1 ? "y" : "ies"} checked, debits against credits` : `${p.unbalanced} entr${p.unbalanced === 1 ? "y does" : "ies do"} not balance`],
      [ZL.cents(p.total_debit) === ZL.cents(p.total_credit), "Total debits equal total credits", `${M(p.total_debit, { symbol: true })} on each side`],
      [ZL.cents(p.assets) === ZL.cents(p.liabilities) + ZL.cents(eqPlusResult),
        P ? "What you own = what you owe + net worth" : "Assets = liabilities + equity",
        `${M(p.assets)} = ${M(p.liabilities)} + ${M(eqPlusResult)}`],
      [p.numbering_gaps === 0, "Journal numbers run without gaps", p.numbering_gaps === 0 ? "Nothing posted has been removed" : `${p.numbering_gaps} number(s) missing`],
      [p.lines_on_headings === 0, "Nothing posted to a heading", "Every line sits on a real account"],
      ...(P || !p.control_accounts || !p.control_accounts.length ? [] : [[ZL.cents(p.subledger_difference) === 0 && !p.allocation_errors,
        "Customer and supplier balances tie to the ledger",
        ZL.cents(p.subledger_difference) === 0 ? p.control_accounts.map((x) => `${x.name} ${M(x.ledger)}`).join(" · ")
          : `${M(p.subledger_difference)} on ${p.control_accounts.filter((x) => ZL.cents(x.difference)).map((x) => x.name).join(", ")} isn't backed by invoices or bills`]]),
      [true, "Audit trail is append-only", `${p.audit_events} event${p.audit_events === 1 ? "" : "s"} recorded; none can be edited or deleted`],
    ];
    const ok = rows.every((r) => r[0]);
    return `<section class="card zl-proof">
      <header><div><h3>${ok ? "Your books are whole" : "Something needs attention"}</h3><p>Checked by the database · ${ZL.dateTime(p.checked_at)}</p></div>
        <button type="button" class="zl-btn sm ghost" id="zl-recheck" style="margin-left:auto">Check again</button></header>
      <ul>${rows.map(([good, t, d]) => `<li class="${good ? "ok" : "bad"}"><i aria-hidden="true">${good ? TICK : "!"}</i>
        <span><b>${t}</b><small>${E(d)}</small></span></li>`).join("")}</ul>
    </section>`;
  }

  ZL.register("dashboard", {
    title: "Dashboard",
    perm: "report.view",
    async render(ctx) {
      const P = ZL.isPersonal();
      const today = ctx.today, year = +today.slice(0, 4), month = +today.slice(5, 7);
      const canJ = ZL.can("journal.view");
      const canRecord = ZL.can("journal.create") && ZL.can("journal.post");
      const trade = !P && canJ;
      const [months, prevYear, bal, recent, proof, opening, accounts, arAge, apAge] = await Promise.all([
        ZL.rpc("monthly_summary", { p_company: cid(), p_year: year }),
        month === 1 ? ZL.rpc("monthly_summary", { p_company: cid(), p_year: year - 1 }) : Promise.resolve(null),
        ZL.rpc("account_balances", { p_company: cid(), p_from: ZL.monthStart(today), p_to: today }),
        canJ ? ZL.select("journal_entries", "id,reference,date,description,source,status,total_debit",
          (q) => q.eq("company_id", cid()).neq("status", "DRAFT").order("posted_at", { ascending: false }).limit(6)) : Promise.resolve([]),
        ZL.rpc("books_proof", { p_company: cid() }),
        canJ ? ZL.count("journal_entries", (q) => q.eq("company_id", cid()).eq("source", "OPENING_BALANCE").eq("status", "POSTED").is("reversal_of_id", null)) : Promise.resolve(0),
        ZL.accounts(),
        trade ? ZL.rpc("trade_aging", { p_company: cid(), p_side: "AR", p_as_at: today }).catch(() => []) : Promise.resolve([]),
        trade ? ZL.rpc("trade_aging", { p_company: cid(), p_side: "AP", p_as_at: today }).catch(() => []) : Promise.resolve([]),
      ]);
      const MN = ZL.MONTHS;
      const shape = (m) => m && ({ revenue: ZL.num(m.revenue), cos: ZL.num(m.cost_of_sales), expenses: ZL.num(m.cost_of_sales) + ZL.num(m.expenses),
        profit: ZL.num(m.profit), cash: ZL.num(m.cash), entries: m.entries });
      const rows = months.slice(0, month).map((m) => Object.assign({ label: MN[m.month - 1] }, shape(m)));
      const now = rows[month - 1];
      const prev = shape(month === 1 ? prevYear && prevYear[11] : months[month - 2]);
      const total = (f) => ZL.sum(bal.filter(f), (a) => a.closing);
      const assets = total((a) => a.type === "ASSET");
      const owed = -total((a) => a.type === "LIABILITY");
      const cashNow = total((a) => a.is_cash); // as at today, not month end
      const hour = new Date().getHours();
      const first = (ZL.user.name || "").split(/\s+/)[0];
      const greeting = `${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}${first ? ", " + first : ""}`;

      const pctChange = (a, b) => (b == null || b === 0 ? null : ((a - b) / Math.abs(b)) * 100);
      const tile = (label, v, p, goodWhenUp = true) => {
        const d = pctChange(v, p);
        const dir = d === null || Math.abs(d) < 0.05 ? "" : (d > 0) === goodWhenUp ? "up" : "down";
        return `<div><div class="klabel">${label}</div><div class="kval num">${M(v, { symbol: true })}</div>
          <div class="delta ${dir}">${d === null ? "&nbsp;" : `<b>${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)}%</b> vs ${MN[(month + 10) % 12]}`}</div></div>`;
      };
      const kpis = P
        ? tile("Net worth", assets - owed, null) + tile("Cash and bank", cashNow, prev && prev.cash) +
          tile(`Income · ${MN[month - 1]}`, now.revenue, prev && prev.revenue) + tile(`Spending · ${MN[month - 1]}`, now.expenses, prev && prev.expenses, false)
        : tile("Cash and bank", cashNow, prev && prev.cash) + tile(`Revenue · ${MN[month - 1]}`, now.revenue, prev && prev.revenue) +
          tile(`Expenses · ${MN[month - 1]}`, now.expenses, prev && prev.expenses, false) + tile(`Net profit · ${MN[month - 1]}`, now.profit, prev && prev.profit);

      const spend = bal.filter((a) => (a.type === "EXPENSE" || a.type === "COST_OF_SALES") && ZL.cents(a.period_debit) - ZL.cents(a.period_credit) > 0)
        .map((a) => ({ n: a.name, a: (ZL.cents(a.period_debit) - ZL.cents(a.period_credit)) / 100 }))
        .sort((x, y) => y.a - x.a);
      const hues = ["var(--c1)", "var(--c2)", "var(--c4)", "var(--c5)", "var(--c3)", "var(--c6)"];
      const spendHtml = spend.length ? `<div class="hbars">` + spend.slice(0, 6).map((r, i) => `
          <div class="hbar"><div class="t"><span>${E(r.n)}</span></div><div class="v num">${M(r.a)}</div>
            <div class="track"><i style="width:${((r.a / spend[0].a) * 100).toFixed(1)}%;background:${hues[i]}"></i></div></div>`).join("") + `</div>`
        : `<div class="zl-empty" style="padding-top:8px"><p>Nothing ${P ? "spent" : "expensed"} in ${MN[month - 1]} yet.</p></div>`;

      const quick = canRecord ? `<button type="button" class="zl-btn" data-quick="IN">+ Money in</button><button type="button" class="zl-btn primary" data-quick="OUT">+ Money out</button>` : "";
      const recentHtml = canJ ? `<section class="card">
          <header><div><h3>Latest activity</h3><p>The most recent entries in the ledger</p></div>
            <button type="button" class="zl-btn sm ghost" id="zl-d-all" style="margin-left:auto">View all</button></header>
          ${recent.length ? `<div class="tablewrap"><table><tbody>${recent.map((e) => `<tr class="click" data-open-journal="${e.id}">
              <td class="nil" style="white-space:nowrap;width:1%">${ZL.date(e.date)}</td>
              <td><div style="font-weight:500">${E(e.description || "—")}</div><div class="hint">${E(e.reference || "")} · ${nice(e.source)}</div></td>
              <td>${e.status === "REVERSED" ? '<span class="chip warn">Reversed</span>' : ""}</td>
              <td class="r num" style="font-weight:600;white-space:nowrap">${M(e.total_debit)}</td></tr>`).join("")}</tbody></table></div>`
            : `<div class="zl-empty" style="padding-top:8px"><p>Nothing posted yet.</p></div>`}
        </section>` : "";

      // Who owes whom: receivables and payables by age, with the most overdue first.
      const owedCard = (side, rows) => {
        const AR = side === "AR";
        const n = (r, k) => ZL.num(r[k]);
        const over = (r) => n(r, "d1_30") + n(r, "d31_60") + n(r, "d61_90") + n(r, "d91_120") + n(r, "d120_plus");
        const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
        const totalBal = sum((r) => n(r, "balance")), overdue = sum(over);
        const buckets = [["Not due", "not_due", "var(--c5)"], ["1–30", "d1_30", "var(--c1)"], ["31–60", "d31_60", "var(--c4)"],
          ["61–90", "d61_90", "var(--c2)"], ["90+", null, "var(--bad)"]].map(([l, k, c]) =>
          ({ l, c, v: k ? sum((r) => n(r, k)) : sum((r) => n(r, "d91_120") + n(r, "d120_plus")) }));
        const gross = buckets.reduce((s, b) => s + b.v, 0);
        const late = rows.filter((r) => over(r) > 0).sort((a, b) => (n(b, "d120_plus") + n(b, "d91_120")) - (n(a, "d120_plus") + n(a, "d91_120")) || over(b) - over(a)).slice(0, 4);
        return `<section class="card zl-owed">
          <header><div><h3>${AR ? "Customers owe you" : "You owe suppliers"}</h3><p>${rows.length} ${AR ? "customer" : "supplier"}${rows.length === 1 ? "" : "s"} with an open balance</p></div>
            <button type="button" class="zl-btn sm ghost" data-go="${AR ? "araging" : "apaging"}" style="margin-left:auto">Aging</button></header>
          <div class="zl-owed-top"><div><div class="klabel">Outstanding</div><div class="kval num">${M(totalBal, { symbol: true })}</div></div>
            <div><div class="klabel">Overdue</div><div class="kval num" style="${overdue > 0 ? "color:var(--bad)" : ""}">${M(overdue, { symbol: true })}</div></div></div>
          ${gross > 0 ? `<div class="zl-owed-bar" role="img" aria-label="Open balance by age">${buckets.filter((b) => b.v > 0).map((b) =>
              `<i style="width:${((b.v / gross) * 100).toFixed(2)}%;background:${b.c}" title="${b.l} days: ${M(b.v)}"></i>`).join("")}</div>
            <div class="zl-owed-key">${buckets.map((b) => `<span><i style="background:${b.c}"></i>${b.l}${b.l === "Not due" ? "" : " days"} <b class="num">${M(b.v)}</b></span>`).join("")}</div>` : ""}
          ${late.length ? `<div class="tablewrap"><table><tbody>${late.map((r) => `<tr class="click" data-contact="${r.contact_id}">
              <td><div style="font-weight:500">${E(r.name)}</div><div class="hint">${E(r.code)}${n(r, "d91_120") + n(r, "d120_plus") > 0 ? ' · <span style="color:var(--bad)">over 90 days</span>' : ""}</div></td>
              <td class="r num" style="color:var(--bad)">${M(over(r))}</td>
              ${canRecord ? `<td class="r" style="width:1%"><button type="button" class="zl-btn sm" data-settle="${AR ? "RECEIPT" : "PAYMENT"}" data-c="${r.contact_id}">${AR ? "Receive" : "Pay"}</button></td>` : ""}</tr>`).join("")}</tbody></table></div>`
            : `<p class="hint" style="padding:4px 20px 18px">${rows.length ? "Nothing overdue. " : ""}${AR ? "Every customer is within terms." : "Every bill is within terms."}</p>`}
        </section>`;
      };
      const owedHtml = trade && (arAge.length || apAge.length) ? `<div class="grid2">${owedCard("AR", arAge)}${owedCard("AP", apAge)}</div>` : "";

      const started = proof.entries > 0;
      const steps = `
        <section class="card">
          <header><div><h3>Get started</h3><p>Three steps, then your reports fill themselves.</p></div></header>
          <ol class="zl-steps">
            <li><span class="n done">${TICK}</span><div><b>Books created</b><span class="hint">${accounts.length} ${P ? "accounts and categories" : "accounts, including SST"} and twelve monthly periods for ${year}.</span></div><span></span></li>
            <li><span class="n${opening ? " done" : ""}">${opening ? TICK : "2"}</span><div><b>Enter opening balances</b><span class="hint">What your bank, cash${P ? ", savings and loans" : ", assets and liabilities"} held on day one. One form; it balances itself.</span></div>
              ${canRecord && !opening ? `<button type="button" class="zl-btn" id="zl-d-ob">Enter balances</button>` : "<span></span>"}</li>
            <li><span class="n">3</span><div><b>Record money in and out</b><span class="hint">${P ? "Salary, groceries, bills, transfers" : "Receipts, bills, expenses"} — each becomes a posted, balanced journal.</span></div>
              ${canRecord ? `<span class="zl-actions" style="flex-wrap:nowrap"><button type="button" class="zl-btn sm" data-quick="IN">Money in</button><button type="button" class="zl-btn sm" data-quick="OUT">Money out</button></span>` : "<span></span>"}</li>
            <li><span class="n">4</span><div><b>Read your reports</b><span class="hint">${P ? "Income and spending, and your net worth" : "Profit and loss, balance sheet and trial balance"} — always up to date.</span></div>
              <button type="button" class="zl-btn sm ghost" id="zl-d-pl">Open</button></li>
          </ol>
        </section>`;

      return ZL.header(greeting, `${ZL.company.name} · ${monthName(today)}`, quick) + `
        <div class="kpi-head zl-kpis">${kpis}</div>
        ${owedHtml}
        ${started ? `
        <div class="grid2">
          <section class="card">
            <header><div><h3>${P ? "Income and spending" : "Revenue, expenses and profit"}</h3><p>${year}, month by month</p></div></header>
            <div class="chartbox">
              <div class="legend"><span><i style="background:var(--c1)"></i>${P ? "Income" : "Revenue"}</span><span><i style="background:var(--c2)"></i>${P ? "Spending" : "Expenses"}</span><span><i class="l" style="background:var(--c4)"></i>${P ? "Saved" : "Net profit"}</span></div>
              <div class="tablewrap">${trendChart(rows)}</div>
            </div>
          </section>
          <section class="card"><header><div><h3>Where the money went</h3><p>${monthName(today)}</p></div></header>${spendHtml}</section>
        </div>
        <div class="grid2">${recentHtml || "<div></div>"}${proofHtml(proof)}</div>`
        : `<div class="grid2">${steps}${proofHtml(proof)}</div>`}`;
    },
    after(root) {
      const on = (id, f) => { const el = root.querySelector("#" + id); if (el) el.addEventListener("click", f); };
      root.querySelectorAll("[data-quick]").forEach((b) => b.addEventListener("click", () => ZL.quick(b.dataset.quick)));
      on("zl-d-ob", () => ZL.openingBalances());
      on("zl-d-pl", () => go("pl"));
      on("zl-d-all", () => go("journals"));
      on("zl-recheck", () => ZL.refresh());
      root.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));
      root.querySelectorAll("[data-contact]").forEach((r) => r.addEventListener("click", (ev) => {
        if (ev.target.closest("button")) return;
        ZL.open("contact", { id: r.dataset.contact });
      }));
      root.querySelectorAll("[data-settle]").forEach((b) => b.addEventListener("click", () => ZL.tradePay && ZL.tradePay(b.dataset.settle, { contact_id: b.dataset.c })));
      wireJournalLinks(root);
    },
  });

  function wireJournalLinks(root) {
    root.querySelectorAll("[data-open-journal]").forEach((el) => el.addEventListener("click", (ev) => {
      if (ev.target.closest("button:not([data-open-journal]),a,select,input")) return;
      ZL.open("journal", { id: el.dataset.openJournal });
    }));
  }
  ZL.wireJournalLinks = wireJournalLinks;

  // ══ Chart of accounts ═════════════════════════════════════════════════════
  /** Accounts in tree order (parents before children) with depth. */
  function tree(accounts) {
    const kids = new Map();
    accounts.forEach((a) => {
      const k = a.parent_id || "root";
      if (!kids.has(k)) kids.set(k, []);
      kids.get(k).push(a);
    });
    kids.forEach((list) => list.sort((x, y) => x.code.localeCompare(y.code, "en", { numeric: true })));
    const out = [];
    const ids = new Set(accounts.map((a) => a.id));
    const walk = (k, depth) => (kids.get(k) || []).forEach((a) => { out.push({ a, depth }); walk(a.id, depth + 1); });
    walk("root", 0);
    // Orphans (parent not visible) still appear.
    accounts.filter((a) => a.parent_id && !ids.has(a.parent_id)).forEach((a) => { out.push({ a, depth: 0 }); walk(a.id, 1); });
    return out;
  }

  ZL.register("coa", {
    title: "Chart of accounts",
    perm: "account.view",
    async render(ctx) {
      const canBal = ZL.can("report.view") || ZL.can("ledger.view");
      const [accounts, bal] = await Promise.all([
        ZL.accounts(true),
        canBal ? ZL.rpc("account_balances", { p_company: cid(), p_from: null, p_to: ctx.today }) : Promise.resolve([]),
      ]);
      const closing = new Map(bal.map((b) => [b.account_id, ZL.cents(b.closing)]));
      // Headings show the total of everything beneath them.
      const byId = new Map(accounts.map((a) => [a.id, a]));
      const roll = new Map();
      accounts.forEach((a) => {
        const c = closing.get(a.id) || 0;
        if (!c) return;
        let p = a;
        while (p) { roll.set(p.id, (roll.get(p.id) || 0) + c); p = p.parent_id ? byId.get(p.parent_id) : null; }
      });
      const moved = accounts.filter((a) => a.is_postable && (closing.get(a.id) || 0) !== 0).length;
      const canEdit = ZL.can("account.edit"), canDel = ZL.can("account.delete"), canGL = ZL.can("ledger.view");
      const lock = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-label="System account" style="vertical-align:-1px;color:var(--ink-3)"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
      const rows = tree(accounts).map(({ a, depth }) => {
        const b = roll.get(a.id) || 0;
        const actions = [
          canEdit ? `<button type="button" class="zl-btn sm ghost" data-acc-edit="${a.id}">Edit</button>` : "",
          canEdit && !a.is_system ? `<button type="button" class="zl-btn sm ghost" data-acc-toggle="${a.id}">${a.is_active ? "Archive" : "Restore"}</button>` : "",
          canDel && !a.is_system ? `<button type="button" class="zl-btn sm ghost" data-acc-del="${a.id}" style="color:var(--bad)">Delete</button>` : "",
        ].join("");
        return `<tr data-type="${a.type}" data-moved="${b !== 0 ? 1 : 0}" data-text="${E((a.code + " " + a.name).toLowerCase())}"
            ${canGL && a.is_postable ? `class="click" data-acc-gl="${a.id}"` : ""}${a.is_active ? "" : ' style="opacity:.62"'}>
          <td class="code">${E(a.code)}</td>
          <td style="padding-left:${16 + depth * 18}px${a.is_postable ? "" : ";font-weight:600"}">${E(a.is_postable ? a.name : titleCase(a.name))}
            ${a.is_system ? lock : ""}${a.is_cash ? ' <span class="chip">Cash</span>' : ""}${a.is_active ? "" : ' <span class="chip">Archived</span>'}</td>
          <td class="nil">${typeLabel(a.type)}</td>
          <td class="r num${b ? "" : " nil"}"${a.is_postable ? "" : ' style="font-weight:600"'}>${canBal && b ? M(natural(a.type, b) / 100) : "—"}</td>
          <td class="r" style="width:1%;white-space:nowrap"><div class="zl-row-actions">${actions}</div></td>
        </tr>`;
      }).join("");
      return ZL.header(ZL.T("Chart of accounts", "Accounts & categories"),
          `${accounts.length} accounts · ${moved} with a balance`,
          ZL.can("account.create") ? btn("zl-acc-new", "+ New account", "primary") : "") + `
        <div class="toolbar">
          <label class="field in">${searchIcon}<input id="asearch" type="search" placeholder="Search code or name" aria-label="Search accounts"></label>
          <label class="field"><select id="atype" aria-label="Filter by type"><option value="">All types</option>${TYPES.filter((t) => !ZL.isPersonal() || t !== "COST_OF_SALES").map((t) => `<option value="${t}">${typeLabel(t)}</option>`).join("")}</select></label>
          <label class="field"><select id="amoved" aria-label="Filter by balance"><option value="">Every account</option><option value="1">With a balance</option></select></label>
          <span class="count" id="acount"></span>
        </div>
        <section class="card"><div class="tablewrap"><table>
          <thead><tr><th style="width:84px">Code</th><th>Name</th><th>Type</th><th class="r">Balance today</th><th></th></tr></thead>
          <tbody id="abody">${rows}</tbody>
        </table></div></section>
        <p class="hint">Bold rows are headings: they group accounts and never take postings. ${lock} marks accounts the system relies on. ${canGL ? "Select an account to see its ledger." : ""}</p>`;
    },
    after(root, ctx) {
      const byId = () => new Map((ZL._accounts || []).map((a) => [a.id, a]));
      root.querySelectorAll("[data-acc-gl]").forEach((tr) => tr.addEventListener("click", (ev) => {
        if (ev.target.closest("button")) return;
        ZL.open("gl", { account: tr.dataset.accGl });
      }));
      const nb = root.querySelector("#zl-acc-new");
      if (nb) nb.addEventListener("click", () => newAccount());
      root.querySelectorAll("[data-acc-edit]").forEach((b) => b.addEventListener("click", () => editAccount(byId().get(b.dataset.accEdit))));
      root.querySelectorAll("[data-acc-toggle]").forEach((b) => b.addEventListener("click", async () => {
        const a = byId().get(b.dataset.accToggle);
        const archiving = a.is_active;
        if (archiving && !(await ZL.confirm({ title: `Archive ${a.code} ${a.name}?`, message: "It stays in reports and history but can't receive new postings. You can restore it any time.", confirmLabel: "Archive" }))) return;
        try {
          await ZL.rpc("update_account", { p_id: a.id, p_name: a.name, p_description: a.description, p_is_active: !archiving });
          ZL.toast(`${a.code} ${a.name} ${archiving ? "archived" : "restored"}.`);
          ZL.invalidate(); ZL.refresh();
        } catch (e) { ZL.toast(ZL.errorText(e), "bad"); }
      }));
      root.querySelectorAll("[data-acc-del]").forEach((b) => b.addEventListener("click", async () => {
        const a = byId().get(b.dataset.accDel);
        if (!(await ZL.confirm({ title: `Delete ${a.code} ${a.name}?`, message: "Only accounts that have never been used can be deleted. This can't be undone.", confirmLabel: "Delete account", danger: true }))) return;
        try {
          await ZL.rpc("delete_account", { p_id: a.id });
          ZL.toast(`${a.code} ${a.name} deleted.`);
          ZL.invalidate(); ZL.refresh();
        } catch (e) { ZL.toast(ZL.errorText(e), "bad"); }
      }));
    },
  });

  async function newAccount() {
    const accounts = await ZL.accounts();
    const headings = accounts.filter((a) => !a.is_postable && a.is_active);
    const created = await ZL.form({
      title: "New account",
      intro: "Sub-accounts take their parent heading's type and classification.",
      confirmLabel: "Create account",
      fields: [
        { name: "code", label: "Code", required: true, placeholder: "e.g. 1133", hint: "Letters, digits, dots or dashes — up to 20." },
        { name: "name", label: "Name", required: true, placeholder: "e.g. RHB Current Account" },
        { name: "parent", label: "Parent heading", type: "select", value: "",
          options: [{ value: "", label: "None — a top-level account" }].concat(headings.map((h) => ({ value: h.id, label: `${h.code} · ${h.name} (${typeLabel(h.type)})` }))) },
        { name: "type", label: "Type (top-level accounts only)", type: "select", value: "ASSET", options: TYPES.map((t) => ({ value: t, label: typeLabel(t) })) },
        { name: "sub", label: "Classification", type: "select", value: "",
          options: [{ value: "", label: "Same as the parent heading" }].concat(SUB_TYPES.map((s) => ({ value: s, label: nice(s) }))) },
        { name: "heading", label: "This is a heading — it groups other accounts and takes no postings", type: "checkbox" },
        { name: "cash", label: "Cash or bank account", type: "checkbox", hint: "Counted as cash on the dashboard." },
        { name: "description", label: "Description", type: "textarea" },
      ],
      submit: (v) => {
        const parent = accounts.find((a) => a.id === v.parent);
        return ZL.rpc("create_account", {
          p_company: cid(), p_code: v.code, p_name: v.name, p_type: parent ? parent.type : v.type,
          p_sub_type: v.sub || null, p_parent_id: v.parent || null, p_description: v.description || null,
          p_is_postable: !v.heading, p_is_cash: !!v.cash,
        });
      },
    });
    if (created) { ZL.toast("Account created."); ZL.invalidate(); ZL.refresh(); }
  }

  async function editAccount(a) {
    if (!a) return;
    const locked = ["2150", "3300", ZL.isPersonal() ? "3100" : "3200"].includes(a.code);
    const done = await ZL.form({
      title: `Edit ${a.code}`,
      intro: "The type is fixed once an account exists. A new code keeps all history — entries point at the account, not the code.",
      fields: [
        ...(locked ? [] : [{ name: "code", label: "Code", required: true, value: a.code, hint: "Letters, digits, dots or dashes; up to 20." }]),
        { name: "name", label: "Name", required: true, value: a.name },
        { name: "description", label: "Description", type: "textarea", value: a.description || "" },
        ...(a.is_system ? [] : [{ name: "active", label: "Active — can receive postings", type: "checkbox", value: a.is_active }]),
      ],
      submit: async (v) => {
        if (!locked && v.code !== a.code) await ZL.rpc("change_account_code", { p_id: a.id, p_code: v.code });
        return ZL.rpc("update_account", { p_id: a.id, p_name: v.name, p_description: v.description || null, p_is_active: a.is_system ? true : !!v.active });
      },
    });
    if (done) { ZL.toast("Account updated."); ZL.invalidate(); ZL.refresh(); }
  }

  // ══ Journals — list ═══════════════════════════════════════════════════════
  const cleanTerm = (s) => String(s || "").replace(/[,()*%\\:"']/g, " ").trim().slice(0, 80);

  ZL.register("journals", {
    title: "Journals",
    perm: "journal.view",
    async render(ctx) {
      const p = ctx.params;
      const status = p.status || "", from = p.from || "", to = p.to || "", term = cleanTerm(p.q), size = p.limit || 100;
      const [{ rows, count }, drafts] = await Promise.all([
        ZL.page("journal_entries", "id,reference,date,description,status,source,total_debit,created_by,reversal_of_id,created_at",
          (q) => {
            q = q.eq("company_id", cid());
            if (status) q = q.eq("status", status);
            if (from) q = q.gte("date", from);
            if (to) q = q.lte("date", to);
            if (term) q = q.or(`reference.ilike.*${term}*,description.ilike.*${term}*`);
            return q.order("date", { ascending: false }).order("created_at", { ascending: false });
          }, 0, size),
        ZL.count("journal_entries", (q) => q.eq("company_id", cid()).eq("status", "DRAFT")),
      ]);
      const people = await ZL.people(rows.map((r) => r.created_by));
      const seg = [["", "All"], ["DRAFT", "Drafts"], ["POSTED", "Posted"], ["REVERSED", "Reversed"]].map(([v, l]) =>
        `<button type="button" data-jstatus="${v}" aria-pressed="${status === v}">${l}${v === "DRAFT" && drafts ? ` (${drafts})` : ""}</button>`).join("");
      const filtered = status || from || to || term;
      return ZL.header("Journals", `${count} entr${count === 1 ? "y" : "ies"}${drafts ? ` · ${drafts} draft${drafts === 1 ? "" : "s"} waiting` : ""}`,
          ZL.can("journal.create") ? btn("zl-j-new", "+ New journal", "primary") : "") + `
        <div class="toolbar">
          <label class="field in">${searchIcon}<input id="zl-jq" type="search" value="${E(p.q || "")}" placeholder="Reference or description" aria-label="Search journals"></label>
          <div class="seg" role="group" aria-label="Status">${seg}</div>
          <label class="field"><span class="hint">From</span><input id="zl-jfrom" type="date" value="${E(from)}" aria-label="From date"></label>
          <label class="field"><span class="hint">To</span><input id="zl-jto" type="date" value="${E(to)}" aria-label="To date"></label>
          ${ZL.applyButton("zl-japply")}
          ${filtered ? btn("zl-jclear", "Clear", "ghost sm") : ""}
          ${ZL.can("report.export") && rows.length ? btn("zl-jcsv", "Export CSV", "ghost") : ""}
          <span class="count"><b>${rows.length}</b> of ${count}</span>
        </div>
        ${rows.length ? `<section class="card"><div class="tablewrap"><table>
          <thead><tr><th>Date</th><th>Reference</th><th>Description</th><th>Status</th><th class="r">Amount</th><th>By</th></tr></thead>
          <tbody>${rows.map((e) => `<tr class="click" data-open-journal="${e.id}">
            <td class="nil" style="white-space:nowrap">${ZL.date(e.date)}</td>
            <td style="white-space:nowrap">${refCell(e)}</td>
            <td class="trunc"><span style="font-weight:500">${E(e.description || "—")}</span> <span class="hint">· ${nice(e.source)}</span>${e.reversal_of_id ? ' <span class="chip">Reversal</span>' : ""}</td>
            <td>${statusChip(e.status)}</td>
            <td class="r num" style="font-weight:600">${M(e.total_debit)}</td>
            <td class="nil" style="white-space:nowrap">${E(people[e.created_by] || "—")}</td></tr>`).join("")}</tbody>
        </table></div>
        ${count > rows.length ? `<div class="proofrow"><span>Showing the latest ${rows.length} of ${count}.</span><span class="figs">${btn("zl-jmore", "Load 100 more", "sm")}</span></div>` : ""}
        </section>`
        : ZL.empty(filtered ? "No journals match" : "No journals yet",
          filtered ? "Try a different search, status or date range." : "Journals you create appear here — drafts first, then posted with a JV reference.",
          !filtered && ZL.can("journal.create") ? `<p style="margin-top:12px">${btn("zl-j-new2", "Create the first journal", "primary")}</p>` : "")}
        <p class="hint">A journal must balance to the sen before it posts. Posted journals are never edited or deleted — they're reversed.</p>`;
    },
    after(root, ctx) {
      const p = ctx.params;
      const reopen = (patch) => ZL.open("journals", Object.assign({}, p, { limit: 100, focus: null }, patch));
      ["zl-j-new", "zl-j-new2"].forEach((id) => {
        const b = root.querySelector("#" + id);
        if (b) b.addEventListener("click", () => ZL.open("journal", { isNew: true }));
      });
      root.querySelectorAll("[data-jstatus]").forEach((b) => b.addEventListener("click", () => reopen({ status: b.dataset.jstatus })));
      const q = root.querySelector("#zl-jq");
      q.addEventListener("input", ZL.debounce(() => reopen({ q: q.value, focus: "q" }), 400));
      if (p.focus === "q") { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      ZL.wireApply(root, ["zl-jfrom", "zl-jto"], "zl-japply", () => {
        const from = root.querySelector("#zl-jfrom").value, to = root.querySelector("#zl-jto").value;
        if (from && to && from > to) { ZL.toast("The start date is after the end date.", "warn"); return; }
        reopen({ from, to });
      });
      const clear = root.querySelector("#zl-jclear");
      if (clear) clear.addEventListener("click", () => ZL.open("journals", {}));
      const more = root.querySelector("#zl-jmore");
      if (more) more.addEventListener("click", () => ZL.open("journals", Object.assign({}, p, { limit: (p.limit || 100) + 100, focus: null })));
      const csv = root.querySelector("#zl-jcsv");
      if (csv) csv.addEventListener("click", () => exportJournals(p));
      wireJournalLinks(root);
    },
  });

  async function exportJournals(p) {
    try {
      const term = cleanTerm(p.q);
      const rows = await ZL.select("journal_entries", "reference,date,description,status,source,total_debit,total_credit,journal_lines(line_no,description,debit,credit,account_id)",
        (q) => {
          q = q.eq("company_id", cid());
          if (p.status) q = q.eq("status", p.status);
          if (p.from) q = q.gte("date", p.from);
          if (p.to) q = q.lte("date", p.to);
          if (term) q = q.or(`reference.ilike.*${term}*,description.ilike.*${term}*`);
          return q.order("date").order("created_at").limit(1000);
        });
      const acc = new Map((await ZL.accounts()).map((a) => [a.id, a]));
      const out = [["Reference", "Date", "Status", "Source", "Description", "Line", "Account code", "Account", "Line narrative", "Debit", "Credit"]];
      rows.forEach((e) => (e.journal_lines || []).sort((a, b) => a.line_no - b.line_no).forEach((l) => {
        const a = acc.get(l.account_id) || {};
        out.push([e.reference || "DRAFT", e.date, e.status, e.source, e.description || "", l.line_no, a.code, a.name, l.description || "",
          ZL.num(l.debit).toFixed(2), ZL.num(l.credit).toFixed(2)]);
      }));
      ZL.csv(`journals-${ZL.today()}.csv`, out);
      if (rows.length === 1000) ZL.toast("Exported the first 1,000 journals — narrow the dates for the rest.", "warn");
    } catch (e) { ZL.toast(ZL.errorText(e), "bad"); }
  }

  // ══ Journal — editor and detail ═══════════════════════════════════════════
  ZL.register("journal", {
    title: "Journal",
    perm: "journal.view",
    nav: "journals",
    detail: true,
    async render(ctx) {
      const p = ctx.params;
      const accounts = await ZL.accounts();
      if (p.isNew || p.copyFrom) {
        if (!ZL.can("journal.create")) return ZL.noAccess("New journal", "journal.create");
        let lines = [], description = "", memo = "";
        if (p.copyFrom) {
          const [src] = await ZL.select("journal_entries", "description,memo", (q) => q.eq("id", p.copyFrom));
          lines = await ZL.select("journal_lines", "account_id,line_no,description,debit,credit", (q) => q.eq("journal_entry_id", p.copyFrom).order("line_no"));
          if (src) { description = src.description || ""; memo = src.memo || ""; }
        }
        if (p.preset === "opening") description = "Opening balances";
        const numbering = ZL.can("journal.post") ? await ZL.numbering.load(ctx.today).catch(() => []) : [];
        return editorHtml({ date: ctx.today, description, memo, lines, isNew: true, numbering }, accounts);
      }
      const [entry] = await ZL.select("journal_entries", "*", (q) => q.eq("id", p.id).eq("company_id", cid()));
      if (!entry) {
        return ZL.header("Journal", "") + ZL.empty("Journal not found",
          "It may have been a draft that was deleted, or it belongs to another company.", `<p style="margin-top:12px">${btn("zl-back", "Back to journals")}</p>`);
      }
      const lines = await ZL.select("journal_lines", "account_id,line_no,description,debit,credit", (q) => q.eq("journal_entry_id", entry.id).order("line_no"));
      if (entry.status === "DRAFT" && ZL.can("journal.edit")) {
        const numbering = ZL.can("journal.post") ? await ZL.numbering.load(entry.date).catch(() => []) : [];
        return editorHtml(Object.assign({}, entry, { lines, numbering }), accounts);
      }
      ctx.entry = entry;
      return detailHtml(entry, lines, accounts) + '<div data-attach></div>';
    },
    after(root, ctx) {
      const back = root.querySelector("#zl-back");
      if (back) back.addEventListener("click", () => go("journals"));
      if (root.querySelector("#zl-lines")) wireEditor(root, ctx);
      else if (root.querySelector("#zl-jd")) wireDetail(root, ctx);
      const slot = root.querySelector("[data-attach]");
      if (slot && ZL.capture && ctx.entry) {
        // A document's journal shows the document's files too.
        ZL.select("trade_docs", "id", (q) => q.eq("journal_entry_id", ctx.entry.id)).catch(() => [])
          .then((docs) => ZL.capture.panel(slot, "JOURNAL", ctx.entry.id, { extra: docs.map((d) => ["TRADE_DOC", d.id]), posted: ctx.entry.status !== "DRAFT" }));
      }
    },
  });

  function accountOptions(accounts, selected) {
    const usable = accounts.filter((a) => a.is_postable && (a.is_active || a.id === selected));
    return `<option value="">Choose account…</option>` + TYPES.map((t) => {
      const list = usable.filter((a) => a.type === t);
      return list.length ? `<optgroup label="${typeLabel(t)}">${list.map((a) =>
        `<option value="${a.id}"${a.id === selected ? " selected" : ""}>${E(a.code)} · ${E(a.name)}${a.is_active ? "" : " (archived)"}</option>`).join("")}</optgroup>` : "";
    }).join("");
  }

  function lineRow(accounts, l, n) {
    const d = ZL.cents(l.debit), c = ZL.cents(l.credit);
    return `<tr data-line>
      <td class="num">${n}</td>
      <td style="min-width:240px"><select class="zl-input" data-f="account" aria-label="Account, line ${n}">${accountOptions(accounts.filter((a) => !a.is_control || a.id === l.account_id), l.account_id)}</select></td>
      <td style="min-width:180px"><input class="zl-input" data-f="description" value="${E(l.description || "")}" placeholder="Line narrative (optional)" aria-label="Narrative, line ${n}" maxlength="500"></td>
      <td style="width:150px"><input class="zl-input num" data-f="debit" inputmode="decimal" value="${d ? M(d / 100) : ""}" placeholder="0.00" aria-label="Debit, line ${n}"></td>
      <td style="width:150px"><input class="zl-input num" data-f="credit" inputmode="decimal" value="${c ? M(c / 100) : ""}" placeholder="0.00" aria-label="Credit, line ${n}"></td>
      <td style="width:40px"><button type="button" class="iconbtn" data-remove aria-label="Remove line ${n}" title="Remove line">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></td>
    </tr>`;
  }

  function editorHtml(j, accounts) {
    const lines = j.lines && j.lines.length ? j.lines.slice() : [];
    while (lines.length < 2) lines.push({});
    const title = j.isNew ? "New journal" : "Draft journal";
    const canPost = ZL.can("journal.post");
    editorHtml.accounts = accounts;
    editorHtml.numbering = j.numbering || [];
    const numFields = ZL.numbering.fields(editorHtml.numbering, "JOURNAL");
    return ZL.header(title, j.isNew ? "Debits must equal credits before it can post. The JV number is given on posting." : `Draft · last saved ${ZL.dateTime(j.updated_at)}`,
        btn("zl-jback", "← Journals", "ghost")) + `
      <section class="card" id="zl-je" data-id="${j.id || ""}" data-version="${j.version || ""}">
        <div class="zl-je-head">
          <label class="zl-field"><span>Date <i>*</i></span><input class="zl-input" type="date" id="zl-jdate" value="${E(j.date)}" required></label>
          <label class="zl-field"><span>Description</span><input class="zl-input" id="zl-jdesc" value="${E(j.description || "")}" placeholder="What this entry records" maxlength="500"></label>
          <label class="zl-field"><span>Memo</span><input class="zl-input" id="zl-jmemo" value="${E(j.memo || "")}" placeholder="Internal note (optional)" maxlength="2000"></label>
        </div>
        ${numFields.length ? `<div class="zl-je-num">${numFields.map((f) => ZL.fieldHtml(f)).join("")}</div>` : ""}
        <div class="tablewrap"><table class="zl-lines">
          <thead><tr><th style="width:36px">#</th><th>Account</th><th>Narrative</th><th class="r">Debit</th><th class="r">Credit</th><th></th></tr></thead>
          <tbody id="zl-lines">${lines.map((l, i) => lineRow(accounts, l, i + 1)).join("")}</tbody>
          <tfoot><tr><td></td><td colspan="2">${btn("zl-addline", "+ Add line", "sm")}</td>
            <td class="r num mono" id="zl-tdr">0.00</td><td class="r num mono" id="zl-tcr">0.00</td><td></td></tr></tfoot>
        </table></div>
        <div class="proofrow" id="zl-proof"></div>
      </section>
      <div id="zl-je-err"></div>
      <div class="zl-actions" style="justify-content:flex-end">
        ${!j.isNew && ZL.can("journal.delete") ? btn("zl-jdel", "Delete draft", "danger") + '<span style="flex:1"></span>' : ""}
        ${btn("zl-jcancel", "Cancel", "ghost")}
        ${btn("zl-jsave", "Save draft")}
        ${canPost ? btn("zl-jpost", "Save &amp; post", "primary") : ""}
      </div>
      <p class="hint" style="text-align:right">${canPost ? "Posting gives the next JV number and locks the entry; a later correction is a reversal." : "Your role can save drafts; someone with posting rights posts them."}</p>`;
  }

  function wireEditor(root, ctx) {
    const accounts = editorHtml.accounts;
    const numCtl = ZL.numbering.wire(root, editorHtml.numbering, "JOURNAL",
      { dateInput: root.querySelector("#zl-jdate"), autoHint: "Given when you post." });
    const body = root.querySelector("#zl-lines");
    const card = root.querySelector("#zl-je");
    let id = card.dataset.id || null;
    let version = card.dataset.version ? Number(card.dataset.version) : null;
    let dirty = false;
    const onUnload = (ev) => { if (dirty) { ev.preventDefault(); ev.returnValue = ""; } };
    window.addEventListener("beforeunload", onUnload);
    const leave = (fn) => async () => {
      if (dirty && !(await ZL.confirm({ title: "Discard changes?", message: "This journal has changes that haven't been saved.", confirmLabel: "Discard" }))) return;
      dirty = false;
      window.removeEventListener("beforeunload", onUnload);
      fn();
    };

    const renumber = () => body.querySelectorAll("tr").forEach((tr, i) => { tr.cells[0].textContent = String(i + 1); });
    const totals = () => {
      let dr = 0, cr = 0, bad = false, n = 0;
      body.querySelectorAll("tr").forEach((tr) => {
        const d = ZL.parseAmount(tr.querySelector('[data-f="debit"]').value);
        const c = ZL.parseAmount(tr.querySelector('[data-f="credit"]').value);
        if (Number.isNaN(d) || Number.isNaN(c)) { bad = true; return; }
        dr += Math.round(d * 100); cr += Math.round(c * 100);
        if (d || c) n++;
      });
      return { dr, cr, bad, n };
    };
    const refresh = () => {
      const t = totals();
      root.querySelector("#zl-tdr").textContent = M(t.dr / 100);
      root.querySelector("#zl-tcr").textContent = M(t.cr / 100);
      const proof = root.querySelector("#zl-proof");
      if (t.bad) proof.innerHTML = `<span style="color:var(--bad);font-weight:500">An amount isn't a number — use digits like 1,250.00.</span>`;
      else if (t.dr === 0 && t.cr === 0) proof.innerHTML = `<span class="hint">Enter a debit or a credit on each line. Blank lines are ignored.</span>`;
      else if (t.dr === t.cr) proof.innerHTML = `<span class="ok">${TICK}Balanced</span><span class="figs"><span>Lines <b class="num">${t.n}</b></span><span>Total <b class="num mono">${M(t.dr / 100)}</b></span></span>`;
      else proof.innerHTML = `<span style="color:var(--bad);font-weight:500">Out of balance by <span class="mono">${M(Math.abs(t.dr - t.cr) / 100)}</span></span>
        <span class="figs">${btn("zl-fill", `Put ${M(Math.abs(t.dr - t.cr) / 100)} on a new line`, "sm")}</span>`;
      const fill = proof.querySelector("#zl-fill");
      if (fill) fill.addEventListener("click", () => {
        const diff = t.dr - t.cr;
        let tr = [...body.querySelectorAll("tr")].find((r) => !ZL.parseAmount(r.querySelector('[data-f="debit"]').value) && !ZL.parseAmount(r.querySelector('[data-f="credit"]').value));
        if (!tr) { addLine(); tr = body.lastElementChild; }
        tr.querySelector(`[data-f="${diff > 0 ? "credit" : "debit"}"]`).value = M(Math.abs(diff) / 100);
        dirty = true; refresh();
        tr.querySelector('[data-f="account"]').focus();
      });
    };
    const addLine = () => {
      body.insertAdjacentHTML("beforeend", lineRow(accounts, {}, body.children.length + 1));
    };

    body.addEventListener("input", (ev) => {
      dirty = true;
      const f = ev.target.dataset.f;
      if ((f === "debit" || f === "credit") && ev.target.value.trim()) {
        const other = ev.target.closest("tr").querySelector(`[data-f="${f === "debit" ? "credit" : "debit"}"]`);
        if (other.value) other.value = ""; // a line is either a debit or a credit
      }
      refresh();
    });
    body.addEventListener("change", () => { dirty = true; });
    body.addEventListener("focusout", (ev) => {
      const f = ev.target.dataset.f;
      if (f !== "debit" && f !== "credit") return;
      const v = ZL.parseAmount(ev.target.value);
      if (!Number.isNaN(v)) ev.target.value = v ? M(v) : "";
    });
    body.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && ev.target.matches("input")) {
        ev.preventDefault();
        const tr = ev.target.closest("tr");
        if (tr === body.lastElementChild) addLine();
        tr.nextElementSibling.querySelector('[data-f="account"]').focus();
      }
    });
    body.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-remove]");
      if (!b) return;
      if (body.children.length <= 2) { b.closest("tr").querySelectorAll("input").forEach((i) => { i.value = ""; }); b.closest("tr").querySelector("select").value = ""; }
      else b.closest("tr").remove();
      dirty = true; renumber(); refresh();
    });
    root.querySelector("#zl-addline").addEventListener("click", () => { addLine(); body.lastElementChild.querySelector("select").focus(); });
    ["#zl-jdate", "#zl-jdesc", "#zl-jmemo"].forEach((s) => root.querySelector(s).addEventListener("input", () => { dirty = true; }));

    const errBox = root.querySelector("#zl-je-err");
    const collect = (forPost) => {
      const date = root.querySelector("#zl-jdate").value;
      if (!date) throw new ZL.ZLError("VALIDATION", "Choose a journal date.");
      const lines = [];
      [...body.querySelectorAll("tr")].forEach((tr, i) => {
        const account = tr.querySelector('[data-f="account"]').value;
        const d = ZL.parseAmount(tr.querySelector('[data-f="debit"]').value);
        const c = ZL.parseAmount(tr.querySelector('[data-f="credit"]').value);
        if (Number.isNaN(d) || Number.isNaN(c)) throw new ZL.ZLError("VALIDATION", `Line ${i + 1}: the amount isn't a number.`);
        if (!d && !c) return;
        if (!account) throw new ZL.ZLError("VALIDATION", `Line ${i + 1}: choose an account.`);
        lines.push({ account_id: account, description: tr.querySelector('[data-f="description"]').value.trim(), debit: d, credit: c });
      });
      if (!lines.length) throw new ZL.ZLError("VALIDATION", "Enter at least one line with an amount.");
      if (forPost) {
        const t = totals();
        if (lines.length < 2) throw new ZL.ZLError("JOURNAL_TOO_FEW_LINES", "A journal needs at least two lines to post.");
        if (t.dr !== t.cr) throw new ZL.ZLError("JOURNAL_UNBALANCED", `Debits (${M(t.dr / 100)}) don't equal credits (${M(t.cr / 100)}).`);
      }
      return { date, description: root.querySelector("#zl-jdesc").value.trim(), memo: root.querySelector("#zl-jmemo").value.trim(), lines };
    };
    const buttons = [...root.querySelectorAll(".zl-actions .zl-btn")];
    const busy = (on) => buttons.forEach((b) => { b.disabled = on; });
    const remember = () => {
      ZL.params = { id };
      ZL.paramsRoute = "journal";
      try { sessionStorage.setItem("zl.params", JSON.stringify({ route: "journal", params: { id } })); } catch (_) { /* ignore */ }
    };

    const save = async (post) => {
      errBox.innerHTML = "";
      let data, num = {};
      try { data = collect(post); if (post) num = numCtl.read(); } catch (e) { errBox.innerHTML = ZL.errorBox(e); return; }
      busy(true);
      try {
        const saved = await ZL.rpc("save_journal", {
          p_company: cid(), p_id: id, p_date: data.date, p_description: data.description || null,
          p_memo: data.memo || null, p_lines: data.lines, p_version: version,
        });
        id = saved.id; version = saved.version;
        card.dataset.id = id; card.dataset.version = version;
        const h1 = root.querySelector("h1");
        if (h1) h1.textContent = "Draft journal";
        remember();
        dirty = false;
        if (!post) {
          ZL.toast("Draft saved. It isn't in the ledger until it's posted.");
          window.removeEventListener("beforeunload", onUnload);
          ZL.open("journal", { id });
          return;
        }
        try {
          const r = await ZL.rpc("post_journal", { p_id: id, p_series: num.p_series || null, p_reference: num.p_doc_no || null });
          ZL.toast(`Posted ${r.reference} · ${M(r.total, { symbol: true })}`);
          window.removeEventListener("beforeunload", onUnload);
          ZL.open("journal", { id });
        } catch (e) {
          errBox.innerHTML = `<div class="zl-err" role="alert"><b>Saved as a draft, but not posted.</b> ${E(ZL.errorText(e))}</div>`;
          busy(false);
        }
      } catch (e) {
        errBox.innerHTML = ZL.errorBox(e);
        busy(false);
      }
    };
    root.querySelector("#zl-jsave").addEventListener("click", () => save(false));
    const postBtn = root.querySelector("#zl-jpost");
    if (postBtn) postBtn.addEventListener("click", () => save(true));
    root.querySelector("#zl-jcancel").addEventListener("click", leave(() => (id && !ctx.params.isNew ? ZL.open("journal", { id }) : go("journals"))));
    root.querySelector("#zl-jback").addEventListener("click", leave(() => go("journals")));
    const del = root.querySelector("#zl-jdel");
    if (del) del.addEventListener("click", async () => {
      if (!(await ZL.confirm({ title: "Delete this draft?", message: "Drafts were never in the ledger, so deleting one changes no balances. The deletion is recorded in the audit trail.", confirmLabel: "Delete draft", danger: true }))) return;
      try {
        await ZL.rpc("delete_journal", { p_id: id });
        dirty = false;
        window.removeEventListener("beforeunload", onUnload);
        ZL.toast("Draft deleted.");
        go("journals");
      } catch (e) { errBox.innerHTML = ZL.errorBox(e); }
    });
    // Navigating away through the rail drops the unload guard.
    document.querySelectorAll("[data-route]").forEach((b) => b.addEventListener("click", () => window.removeEventListener("beforeunload", onUnload), { once: true }));
    refresh();
    if (ctx.params.isNew) root.querySelector("#zl-jdesc").focus();
  }

  async function detailHtml(e, lines, accounts) {
    const acc = new Map(accounts.map((a) => [a.id, a]));
    const [people, reversedBy, original, period] = await Promise.all([
      ZL.people([e.created_by, e.posted_by]),
      e.status === "REVERSED" ? ZL.select("journal_entries", "id,reference,date", (q) => q.eq("reversal_of_id", e.id)) : Promise.resolve([]),
      e.reversal_of_id ? ZL.select("journal_entries", "id,reference,date", (q) => q.eq("id", e.reversal_of_id)) : Promise.resolve([]),
      e.fiscal_period_id && ZL.can("period.view") ? ZL.select("fiscal_periods", "name,status", (q) => q.eq("id", e.fiscal_period_id)) : Promise.resolve([]),
    ]);
    const dr = ZL.sum(lines, (l) => l.debit), cr = ZL.sum(lines, (l) => l.credit);
    const title = e.reference || "Draft journal";
    const canReverse = e.status === "POSTED" && !e.reversal_of_id && ZL.can("journal.reverse");
    const banner = reversedBy[0]
      ? `<div class="zl-banner">This entry was reversed by <button type="button" class="zl-ref" data-open-journal="${reversedBy[0].id}">${E(reversedBy[0].reference)}</button> on ${ZL.date(reversedBy[0].date)}. Both stay in the ledger and net to zero.</div>`
      : original[0] ? `<div class="zl-banner info">This entry reverses <button type="button" class="zl-ref" data-open-journal="${original[0].id}">${E(original[0].reference)}</button> dated ${ZL.date(original[0].date)}.</div>`
      : e.status === "DRAFT" ? `<div class="zl-banner">This is a draft — it isn't in the ledger. Your role can't edit drafts.</div>` : "";
    return ZL.header(title, e.description || "No description",
        `${btn("zl-jback", "← Journals", "ghost")}
          ${e.doc_no ? btn("zl-jvoucher", e.doc_no, "primary") : ""}
          ${btn("zl-jprint", "Print")}
          ${ZL.can("journal.create") ? btn("zl-jdup", "Duplicate") : ""}
          ${canReverse ? btn("zl-jrev", "Reverse", "danger") : ""}`) +
      banner + `
      <section class="card" id="zl-jd">
        <div class="tablewrap"><table>
          <thead><tr><th style="width:36px">#</th><th>Account</th><th>Narrative</th><th class="r">Debit</th><th class="r">Credit</th></tr></thead>
          <tbody>${lines.map((l) => {
            const a = acc.get(l.account_id) || { code: "?", name: "Unknown account" };
            return `<tr><td class="nil num">${l.line_no}</td>
              <td>${ZL.can("ledger.view") ? `<button type="button" class="zl-ref" style="color:inherit;font:inherit" data-acc-gl="${l.account_id}"><span class="code mono">${E(a.code)}</span>${E(a.name)}</button>` : `<span class="code mono">${E(a.code)}</span>${E(a.name)}`}</td>
              <td class="nil">${E(l.description || "")}</td>
              <td class="r">${amt(l.debit)}</td><td class="r">${amt(l.credit)}</td></tr>`;
          }).join("")}</tbody>
          <tfoot><tr><td></td><td colspan="2" style="font-weight:600">Totals</td>
            <td class="r num mono" style="font-weight:600">${M(dr)}</td><td class="r num mono" style="font-weight:600">${M(cr)}</td></tr></tfoot>
        </table></div>
        <div class="proofrow">${ZL.cents(dr) === ZL.cents(cr) ? `<span class="ok">${TICK}This entry balances</span>` : `<span style="color:var(--bad)">Out of balance by ${M(Math.abs(dr - cr))}</span>`}
          <span class="figs"><span>Debit <b class="num mono">${M(dr)}</b></span><span>Credit <b class="num mono">${M(cr)}</b></span></span></div>
      </section>
      <section class="card">
        <div class="zl-kv">
          <div>Date<b>${ZL.date(e.date)}</b></div>
          <div>Status<b>${nice(e.status)}</b></div>
          <div>Source<b>${nice(e.source)}</b></div>
          <div>Period<b>${period[0] ? E(period[0].name) : "—"}</b></div>
          <div>Created by<b>${E(people[e.created_by] || "—")}</b></div>
          <div>Created<b>${ZL.dateTime(e.created_at)}</b></div>
          <div>Posted by<b>${E(people[e.posted_by] || "—")}</b></div>
          <div>Posted<b>${ZL.dateTime(e.posted_at)}</b></div>
          ${e.memo ? `<div style="grid-column:1/-1">Memo<b>${E(e.memo)}</b></div>` : ""}
        </div>
      </section>
      <p class="hint">Posted entries are never edited. A correction is a reversal, so the history always shows what happened.</p>`;
  }

  function wireDetail(root, ctx) {
    wireJournalLinks(root);
    root.querySelectorAll("[data-acc-gl]").forEach((b) => b.addEventListener("click", () => ZL.open("gl", { account: b.dataset.accGl })));
    const id = ctx.params.id;
    const rev = root.querySelector("#zl-jrev");
    if (rev) rev.addEventListener("click", async () => {
      const ref = root.querySelector("h1").textContent;
      const r = await ZL.form({
        title: `Reverse ${ref}`,
        intro: "Posts an equal and opposite journal. The original stays in the ledger, marked reversed, and the two net to zero.",
        confirmLabel: "Post reversal",
        danger: true,
        fields: [
          { name: "date", label: "Reversal date", type: "date", value: ZL.today(), required: true, hint: "Usually today, or the first day of the next period." },
          { name: "reason", label: "Reason", type: "textarea", placeholder: "e.g. Posted to the wrong account" },
        ],
        submit: (v) => ZL.rpc("reverse_journal", { p_id: id, p_date: v.date, p_reason: v.reason || null }),
      });
      if (r) { ZL.toast(`Reversed ${r.reversed} with ${r.reference}`); ZL.open("journal", { id: r.id }); }
    });
    const dup = root.querySelector("#zl-jdup");
    if (dup) dup.addEventListener("click", () => ZL.open("journal", { copyFrom: id }));
    root.querySelector("#zl-jprint").addEventListener("click", () => window.print());
    const voucher = root.querySelector("#zl-jvoucher");
    if (voucher) voucher.addEventListener("click", () => ZL.voucher(id));
    root.querySelector("#zl-jback").addEventListener("click", () => go("journals"));
  }

  // ══ General ledger ════════════════════════════════════════════════════════
  ZL.register("gl", {
    title: "General ledger",
    perm: "ledger.view",
    async render(ctx) {
      const p = ctx.params;
      const accounts = await ZL.accounts();
      const postable = accounts.filter((a) => a.is_postable);
      const account = postable.find((a) => a.id === p.account) || postable.find((a) => a.code === (ZL.isPersonal() ? "1120" : "1131")) || postable.find((a) => a.is_cash) || postable[0];
      if (!account) return ZL.header("General ledger", "") + ZL.empty("No accounts", "Create an account first.");
      const to = p.to || ctx.today, from = p.from || ZL.yearStart(to);
      const gl = await ZL.rpc("general_ledger", { p_company: cid(), p_account: account.id, p_from: from, p_to: to });
      const lines = gl.lines || [];
      const opening = ZL.num(gl.opening);
      const dr = ZL.sum(lines, (l) => l.debit), cr = ZL.sum(lines, (l) => l.credit);
      const closing = (ZL.cents(opening) + ZL.cents(dr) - ZL.cents(cr)) / 100;
      const lastBal = lines.length ? ZL.num(lines[lines.length - 1].balance) : opening;
      const ok = ZL.cents(lastBal) === ZL.cents(closing);
      p.account = account.id; p.from = from; p.to = to;
      return ZL.header("General ledger", `${account.name} · ${account.code} — closing balance ${ZL.drcr(closing)}`,
          ZL.can("report.export") ? btn("zl-glcsv", "Export CSV", "ghost") : "") + `
        <div class="toolbar">
          <label class="field" style="min-width:280px;flex:1;max-width:420px"><span class="hint">Account</span>
            <select id="zl-glacc" aria-label="Account">${accountOptions(accounts, account.id).replace('<option value="">Choose account…</option>', "")}</select></label>
          <label class="field"><span class="hint">From</span><input id="zl-glfrom" type="date" value="${E(from)}" aria-label="From date"></label>
          <label class="field"><span class="hint">To</span><input id="zl-glto" type="date" value="${E(to)}" aria-label="To date"></label>
          ${ZL.applyButton("zl-glapply")}
          <span class="count"><b>${lines.length}</b> line${lines.length === 1 ? "" : "s"}</span>
        </div>
        <section class="card"><div class="tablewrap"><table>
          <thead><tr><th>Date</th><th>Journal</th><th>Description</th><th class="r">Debit</th><th class="r">Credit</th><th class="r">Balance</th></tr></thead>
          <tbody>
            <tr><td class="nil" style="white-space:nowrap">${ZL.date(from)}</td><td class="nil">—</td><td style="font-weight:500">Opening balance</td>
              <td class="r nil">—</td><td class="r nil">—</td><td class="r num mono" style="font-weight:500">${ZL.drcr(opening)}</td></tr>
            ${lines.map((l) => `<tr class="click" data-open-journal="${l.entry_id}">
              <td class="nil" style="white-space:nowrap">${ZL.date(l.date)}</td>
              <td style="white-space:nowrap"><span class="zl-ref">${E(l.reference)}</span>${l.status === "REVERSED" ? ' <span class="chip warn">Reversed</span>' : ""}</td>
              <td class="trunc">${E(l.description || "—")} <span class="hint">· ${nice(l.source)}</span></td>
              <td class="r">${amt(l.debit)}</td><td class="r">${amt(l.credit)}</td>
              <td class="r num mono" style="font-weight:500">${ZL.drcr(l.balance)}</td></tr>`).join("")}
            ${lines.length ? "" : `<tr><td colspan="6" class="nil" style="text-align:center;padding:22px">No postings to this account between ${ZL.date(from)} and ${ZL.date(to)}.</td></tr>`}
          </tbody>
          <tfoot><tr><td colspan="3" style="font-weight:600">Closing balance</td>
            <td class="r num mono" style="font-weight:600">${M(dr)}</td><td class="r num mono" style="font-weight:600">${M(cr)}</td>
            <td class="r num mono" style="font-weight:600">${ZL.drcr(closing)}</td></tr></tfoot>
        </table></div>
        <div class="proofrow">${ok ? `<span class="ok">${TICK}Opening + debits − credits = closing</span>` : `<span style="color:var(--bad)">Running balance doesn't reconcile — reload the page.</span>`}
          <span class="figs"><span>Opening <b class="num mono">${ZL.drcr(opening)}</b></span><span>Debits <b class="num mono">${M(dr)}</b></span>
          <span>Credits <b class="num mono">${M(cr)}</b></span><span>Closing <b class="num mono">${ZL.drcr(closing)}</b></span></span></div>
        </section>
        <p class="hint"><b>Dr</b> means the account is in debit, <b>Cr</b> in credit. Select a line to open its journal.</p>`;
    },
    after(root, ctx) {
      const p = ctx.params;
      const reopen = (patch) => ZL.open("gl", Object.assign({}, p, patch));
      root.querySelector("#zl-glacc").addEventListener("change", (ev) => reopen({ account: ev.target.value }));
      ZL.wireApply(root, ["zl-glfrom", "zl-glto"], "zl-glapply", () => {
        const from = root.querySelector("#zl-glfrom").value || null, to = root.querySelector("#zl-glto").value || null;
        if (from && to && from > to) { ZL.toast("The start date is after the end date.", "warn"); return; }
        reopen({ from, to });
      });
      wireJournalLinks(root);
      const csv = root.querySelector("#zl-glcsv");
      if (csv) csv.addEventListener("click", async () => {
        try {
          const gl = await ZL.rpc("general_ledger", { p_company: cid(), p_account: p.account, p_from: p.from, p_to: p.to });
          const out = [["Account", `${gl.account.code} ${gl.account.name}`], ["From", p.from, "To", p.to], [],
            ["Date", "Reference", "Narrative", "Source", "Status", "Debit", "Credit", "Balance (Dr +, Cr −)"],
            [p.from, "", "Opening balance", "", "", "", "", ZL.num(gl.opening).toFixed(2)]];
          (gl.lines || []).forEach((l) => out.push([l.date, l.reference, l.description || "", l.source, l.status,
            ZL.num(l.debit).toFixed(2), ZL.num(l.credit).toFixed(2), ZL.num(l.balance).toFixed(2)]));
          ZL.csv(`ledger-${gl.account.code}-${p.from}-to-${p.to}.csv`, out);
        } catch (e) { ZL.toast(ZL.errorText(e), "bad"); }
      });
    },
  });

  // ══ Fiscal periods ════════════════════════════════════════════════════════
  ZL.register("periods", {
    title: "Fiscal periods",
    perm: "period.view",
    async render(ctx) {
      const all = await ZL.rpc("period_summary", { p_company: cid() });
      const years = [...new Set(all.map((p) => p.year))].sort((a, b) => b - a);
      const thisYear = +ctx.today.slice(0, 4);
      const year = ctx.params.year && years.includes(ctx.params.year) ? ctx.params.year : years.includes(thisYear) ? thisYear : years[0];
      const rows = all.filter((p) => p.year === year);
      const current = all.find((p) => p.start_date <= ctx.today && ctx.today <= p.end_date);
      const canClose = ZL.can("period.close"), canReopen = ZL.can("period.reopen");
      const generate = ZL.can("period.create") ? btn("zl-pgen", "+ Generate a year", "primary") : "";
      if (!all.length) {
        return ZL.header("Fiscal periods", "Monthly periods that control where postings may land", "") +
          ZL.empty("No fiscal periods", "Generate a fiscal year to start posting.", generate ? `<p style="margin-top:12px">${generate}</p>` : "");
      }
      return ZL.header("Fiscal periods",
          `FY ${year} · ${rows.filter((p) => p.status === "OPEN").length} open, ${rows.filter((p) => p.status === "CLOSED").length} closed · ${current ? `today is in ${current.name}${current.status === "CLOSED" ? " (closed)" : ""}` : "no period covers today — generate the year"}`,
          generate) + `
        <div class="toolbar">
          ${years.length > 1 ? `<div class="seg" role="group" aria-label="Fiscal year">${years.map((y) => `<button type="button" data-pyear="${y}" aria-pressed="${y === year}">FY ${y}</button>`).join("")}</div>` : ""}
          <span class="hint">A closed period refuses every posting dated in it. Reopening needs a reason, which goes in the audit trail.</span>
        </div>
        <section class="card"><div class="tablewrap"><table>
          <thead><tr><th>Period</th><th>Dates</th><th>Status</th><th class="r">Posted</th><th class="r">Drafts</th><th>Last change</th><th class="r">Action</th></tr></thead>
          <tbody>${rows.map((p) => `<tr>
            <td style="font-weight:500">${E(p.name)}${current && current.id === p.id ? ' <span class="chip">Current</span>' : ""}</td>
            <td class="nil" style="white-space:nowrap">${ZL.date(p.start_date)} – ${ZL.date(p.end_date)}</td>
            <td>${p.status === "CLOSED" ? '<span class="chip">Closed</span>' : `<span class="chip ok">${TICK}Open</span>`}</td>
            <td class="r num${p.posted ? "" : " nil"}">${p.posted || "—"}</td>
            <td class="r">${p.drafts ? `<span class="chip warn">${p.drafts}</span>` : '<span class="nil">—</span>'}</td>
            <td class="hint">${p.status === "CLOSED" && p.closed_at ? "Closed " + ZL.dateTime(p.closed_at)
              : p.reopened_at ? `Reopened ${ZL.dateTime(p.reopened_at)}${p.reopen_reason ? " — " + E(p.reopen_reason) : ""}` : ""}</td>
            <td class="r">${p.status === "OPEN" && canClose ? `<button type="button" class="zl-btn sm" data-pclose="${p.id}" data-name="${E(p.name)}" data-drafts="${p.drafts}">Close</button>`
              : p.status === "CLOSED" && canReopen ? `<button type="button" class="zl-btn sm" data-preopen="${p.id}" data-name="${E(p.name)}">Reopen</button>` : ""}</td>
          </tr>`).join("")}</tbody>
        </table></div></section>`;
    },
    after(root, ctx) {
      root.querySelectorAll("[data-pyear]").forEach((b) => b.addEventListener("click", () => ZL.open("periods", { year: Number(b.dataset.pyear) })));
      root.querySelectorAll("[data-pclose]").forEach((b) => b.addEventListener("click", async () => {
        const drafts = Number(b.dataset.drafts);
        if (drafts) {
          ZL.toast(`${b.dataset.name} has ${drafts} draft journal${drafts === 1 ? "" : "s"}. Post or delete ${drafts === 1 ? "it" : "them"} first.`, "warn");
          return;
        }
        if (!(await ZL.confirm({ title: `Close ${b.dataset.name}?`, message: "Nothing can be posted or reversed into it until it's reopened. Use this once the month's figures are final.", confirmLabel: "Close period" }))) return;
        try {
          await ZL.rpc("close_period", { p_id: b.dataset.pclose });
          ZL.toast(`${b.dataset.name} closed.`);
          ZL.refresh();
        } catch (e) { ZL.toast(ZL.errorText(e), "bad"); }
      }));
      root.querySelectorAll("[data-preopen]").forEach((b) => b.addEventListener("click", async () => {
        const done = await ZL.form({
          title: `Reopen ${b.dataset.name}`,
          intro: "Reopening lets entries post into a month whose figures were final. The reason is kept in the audit trail.",
          confirmLabel: "Reopen period",
          fields: [{ name: "reason", label: "Reason", type: "textarea", required: true, placeholder: "e.g. Late supplier bill for August" }],
          submit: (v) => ZL.rpc("reopen_period", { p_id: b.dataset.preopen, p_reason: v.reason }),
        });
        if (done) { ZL.toast(`${b.dataset.name} reopened.`); ZL.refresh(); }
      }));
      const gen = root.querySelector("#zl-pgen");
      if (gen) gen.addEventListener("click", async () => {
        const years = [...root.querySelectorAll("[data-pyear]")].map((x) => Number(x.dataset.pyear));
        const shown = ctx.params.year || +ctx.today.slice(0, 4);
        const suggest = years.length ? Math.max(...years) + 1 : shown;
        const n = await ZL.form({
          title: "Generate a fiscal year",
          intro: "Creates twelve monthly periods. Periods that already exist are left alone.",
          confirmLabel: "Generate",
          fields: [{ name: "year", label: "Fiscal year", type: "number", value: String(suggest), required: true }],
          submit: (v) => ZL.rpc("generate_fiscal_year", { p_company: cid(), p_year: parseInt(v.year, 10) }),
        });
        if (n !== null) { ZL.toast(n ? `${n} periods created.` : "Those periods already exist."); ZL.refresh(); }
      });
    },
  });
})();
