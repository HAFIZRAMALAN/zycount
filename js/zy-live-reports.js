/* ═══════════════════════════════════════════════════════════════════════════
 * Zycount live workspace — reports: trial balance, profit and loss (income and
 * spending), balance sheet (net worth). Every figure is summed by the database
 * from posted journal lines (account_balances); nothing is stored or typed in.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const ZL = window.ZL;
  const E = ZL.esc;
  const M = ZL.money;
  const cid = () => ZL.company.company_id;
  const btn = (id, label, cls = "") => `<button type="button" class="zl-btn ${cls}" id="${id}">${label}</button>`;

  // ── periods ────────────────────────────────────────────────────────────
  const shiftMonths = (iso, n) => {
    const [y, m, d] = iso.split("-").map(Number);
    const srcLast = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const t = new Date(Date.UTC(y, m - 1 + n, 1));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(d === srcLast ? last : Math.min(d, last)); // month end stays month end
    return t.toISOString().slice(0, 10);
  };
  const monthsSpan = (from, to) => (+to.slice(0, 4) - +from.slice(0, 4)) * 12 + (+to.slice(5, 7) - +from.slice(5, 7)) + 1;

  function presets(today) {
    const y = +today.slice(0, 4), m = +today.slice(5, 7);
    const ms = (yy, mm) => `${yy}-${String(mm).padStart(2, "0")}-01`;
    const lmY = m === 1 ? y - 1 : y, lmM = m === 1 ? 12 : m - 1;
    const q0 = Math.floor((m - 1) / 3) * 3 + 1;
    return {
      month: { label: "This month", from: ms(y, m), to: today },
      lastmonth: { label: "Last month", from: ms(lmY, lmM), to: ZL.monthEnd(ms(lmY, lmM)) },
      quarter: { label: "This quarter", from: ms(y, q0), to: today },
      ytd: { label: "This year to date", from: `${y}-01-01`, to: today },
      lastyear: { label: "Last year", from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
    };
  }

  /** Period picker: preset select plus from/to dates. */
  function rangeControls(p, today) {
    const ps = presets(today);
    return `<label class="field"><select id="zl-rp" aria-label="Period">${Object.entries(ps).map(([k, v]) =>
        `<option value="${k}"${p.preset === k ? " selected" : ""}>${v.label}</option>`).join("")}
        <option value="custom"${p.preset === "custom" ? " selected" : ""}>Custom dates</option></select></label>
      <label class="field"><input id="zl-rfrom" type="date" value="${E(p.from)}" aria-label="From"></label>
      <span class="hint">to</span>
      <label class="field"><input id="zl-rto" type="date" value="${E(p.to)}" aria-label="To"></label>
      ${ZL.applyButton("zl-rapply")}`;
  }
  function wireRange(root, route, p, today) {
    const ps = presets(today);
    root.querySelector("#zl-rp").addEventListener("change", (ev) => {
      const k = ev.target.value;
      if (k === "custom") return;
      ZL.open(route, Object.assign({}, p, { preset: k, from: ps[k].from, to: ps[k].to, compare: undefined }));
    });
    const custom = () => {
      const from = root.querySelector("#zl-rfrom").value, to = root.querySelector("#zl-rto").value;
      if (!from || !to) { ZL.toast("Choose both dates.", "warn"); return; }
      if (from > to) { ZL.toast("The start date is after the end date.", "warn"); return; }
      ZL.open(route, Object.assign({}, p, { preset: "custom", from, to }));
    };
    const markCustom = () => { root.querySelector("#zl-rp").value = "custom"; };
    root.querySelector("#zl-rfrom").addEventListener("input", markCustom);
    root.querySelector("#zl-rto").addEventListener("input", markCustom);
    ZL.wireApply(root, ["zl-rfrom", "zl-rto"], "zl-rapply", custom);
  }
  function resolveRange(p, today, fallback) {
    const ps = presets(today);
    if (p.from && p.to) return Object.assign({ preset: p.preset || "custom" }, p);
    const k = p.preset && ps[p.preset] ? p.preset : fallback;
    return Object.assign({}, p, { preset: k, from: ps[k].from, to: ps[k].to });
  }

  async function letterhead(title, when) {
    const info = await ZL.companyInfo();
    const P = ZL.isPersonal();
    const org = P ? info.name : [info.name, info.registration_no].filter(Boolean).join(" · ");
    return `<div class="letterhead">
      <div><h2>${E(title)}</h2><div class="org">${E(org)}</div><div class="when">${E(when)} · Ringgit Malaysia</div></div>
      <div class="stamp">${P ? "Prepared by Zycount" : "Unaudited<br>management accounts"}</div></div>`;
  }

  /** Statement body rows: [{kind:"grp"|"ind"|"sub"|"tot"|"tot soft", label, code?, id?, now, prev}] */
  function stmtRows(rows, hasPrev, canGL) {
    return rows.map((r) => {
      if (r.kind === "grp") return `<tr class="grp"><td colspan="${hasPrev ? 3 : 2}">${E(r.label)}</td></tr>`;
      if (r.kind === "note") return `<tr class="ind"><td colspan="${hasPrev ? 3 : 2}" class="nil">${E(r.label)}</td></tr>`;
      const cell = (v, dim) => `<td class="r num${dim ? " nil" : ""}">${v == null ? "" : ZL.cents(v) ? M(v) : "–"}</td>`;
      const label = r.kind === "ind" && r.id && canGL
        ? `<button type="button" class="zl-ref" style="color:inherit;font:inherit;text-align:left" data-gl="${r.id}">${E(r.label)}</button>`
        : E(r.label);
      const cls = r.kind + (r.head ? " zl-head" : "") + (r.deep ? " zl-deep" : "");
      return `<tr class="${cls}"><td>${label}${r.code ? ` <span class="code">${E(r.code)}</span>` : ""}</td>${cell(r.now)}${hasPrev ? cell(r.prev, true) : ""}</tr>`;
    }).join("");
  }

  const style = document.createElement("style");
  style.textContent = `
  .stmt tr.zl-head td{color:var(--ink)!important;font-weight:500;padding-top:12px}
  html .stmt tr.zl-deep td:first-child,html.zl-live .stmt tr.zl-deep td:first-child{padding-left:64px}
  @media (max-width:900px){html.zl-live .stmt tr.zl-deep td:first-child{padding-left:40px}}`;
  document.head.appendChild(style);

  const balances = (from, to) => ZL.rpc("account_balances", { p_company: cid(), p_from: from, p_to: to });

  function exportButton() { return ZL.can("report.export") ? btn("zl-rcsv", "Export CSV", "ghost") : ""; }
  function wireCommon(root, route, p, today, csvRows) {
    root.querySelectorAll("[data-gl]").forEach((b) => b.addEventListener("click", () =>
      ZL.open("gl", { account: b.dataset.gl, from: p.from || ZL.yearStart(p.to || p.asAt), to: p.to || p.asAt })));
    const csv = root.querySelector("#zl-rcsv");
    if (csv) csv.addEventListener("click", () => ZL.csv(csvRows.name, csvRows.rows));
    const pr = root.querySelector("#zl-rprint");
    if (pr) pr.addEventListener("click", () => window.print());
  }

  // ══ Profit and loss / Income and spending ═════════════════════════════════
  ZL.register("pl", {
    title: "Profit & loss",
    perm: "report.view",
    async render(ctx) {
      const P = ZL.isPersonal();
      const p = resolveRange(ctx.params, ctx.today, "ytd");
      const compare = p.compare || (p.preset === "ytd" || p.preset === "lastyear" ? "ly" : "prev");
      const span = p.preset === "quarter" ? 3 : monthsSpan(p.from, p.to);
      const cmp = compare === "none" ? null : compare === "ly"
        ? { from: shiftMonths(p.from, -12), to: shiftMonths(p.to, -12) }
        : { from: shiftMonths(p.from, -span), to: shiftMonths(p.to, -span) };
      const [now, prev, accounts] = await Promise.all([balances(p.from, p.to), cmp ? balances(cmp.from, cmp.to) : Promise.resolve([]), ZL.accounts()]);
      const byId = new Map(accounts.map((a) => [a.id, a]));
      const prevMap = new Map(prev.map((b) => [b.account_id, b]));
      // Income is credit-natural, spending debit-natural; both shown positive.
      const move = (b, credit) => b ? (credit ? ZL.cents(b.period_credit) - ZL.cents(b.period_debit) : ZL.cents(b.period_debit) - ZL.cents(b.period_credit)) / 100 : 0;
      const pick = (f, credit) => now.filter((b) => b.is_postable && f(b))
        .map((b) => ({ id: b.account_id, code: b.code, label: b.name, parent: b.parent_id, now: move(b, credit), prev: cmp ? move(prevMap.get(b.account_id), credit) : null }))
        .filter((r) => ZL.cents(r.now) || ZL.cents(r.prev));
      const tot = (rows) => ({ now: ZL.sum(rows, (r) => r.now), prev: cmp ? ZL.sum(rows, (r) => r.prev) : null });
      const sub = (label, t, kind = "sub") => ({ kind, label, now: t.now, prev: t.prev });
      const minus = (a, b) => ({ now: (ZL.cents(a.now) - ZL.cents(b.now)) / 100, prev: cmp ? (ZL.cents(a.prev) - ZL.cents(b.prev)) / 100 : null });
      const plus = (a, b) => ({ now: (ZL.cents(a.now) + ZL.cents(b.now)) / 100, prev: cmp ? (ZL.cents(a.prev) + ZL.cents(b.prev)) / 100 : null });

      let rows = [], net, revenueTotal;
      if (P) {
        const income = pick((b) => b.type === "REVENUE", true);
        const spending = pick((b) => b.type === "EXPENSE" || b.type === "COST_OF_SALES", false);
        const ti = tot(income), ts = tot(spending);
        revenueTotal = ti;
        rows.push({ kind: "grp", label: "Income" }, ...income.map((r) => Object.assign({ kind: "ind" }, r)));
        if (!income.length) rows.push({ kind: "note", label: "No income recorded in this period." });
        rows.push(sub("Total income", ti), { kind: "grp", label: "Spending" });
        // Spending grouped under its heading (Home, Food, Transport…).
        const groups = new Map();
        spending.forEach((r) => { const h = byId.get(r.parent); const k = h ? h.name : "Other"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
        groups.forEach((list, heading) => {
          rows.push({ kind: "ind", label: heading, now: null, prev: null, head: true });
          list.forEach((r) => rows.push(Object.assign({ kind: "ind", deep: true }, r)));
        });
        if (!spending.length) rows.push({ kind: "note", label: "No spending recorded in this period." });
        rows.push(sub("Total spending", ts));
        net = minus(ti, ts);
        rows.push(sub(ZL.cents(net.now) >= 0 ? "Saved in this period" : "Overspent in this period", net, "tot"));
      } else {
        const rev = pick((b) => b.type === "REVENUE" && b.sub_type !== "OTHER_INCOME", true);
        const cos = pick((b) => b.type === "COST_OF_SALES", false);
        const opex = pick((b) => b.type === "EXPENSE" && b.sub_type !== "OTHER_EXPENSE", false);
        const oi = pick((b) => b.type === "REVENUE" && b.sub_type === "OTHER_INCOME", true);
        const oe = pick((b) => b.type === "EXPENSE" && b.sub_type === "OTHER_EXPENSE", false);
        const tRev = tot(rev), tCos = tot(cos), tOpex = tot(opex), tOi = tot(oi), tOe = tot(oe);
        revenueTotal = tRev;
        const gp = minus(tRev, tCos), op = minus(gp, tOpex);
        net = minus(plus(op, tOi), tOe);
        const section = (label, list, total, totalLabel) => {
          rows.push({ kind: "grp", label });
          if (list.length) rows.push(...list.map((r) => Object.assign({ kind: "ind" }, r)));
          else rows.push({ kind: "note", label: "Nothing posted." });
          rows.push(sub(totalLabel, total));
        };
        section("Revenue", rev, tRev, "Total revenue");
        if (cos.length) section("Cost of sales", cos, tCos, "Total cost of sales");
        rows.push(sub("Gross profit", gp, "tot soft"));
        section("Operating expenses", opex, tOpex, "Total operating expenses");
        rows.push(sub("Operating profit", op, "tot soft"));
        if (oi.length) section("Other income", oi, tOi, "Total other income");
        if (oe.length) section("Other expenses and finance costs", oe, tOe, "Total other expenses");
        rows.push(sub(ZL.cents(net.now) >= 0 ? "Net profit for the period" : "Net loss for the period", net, "tot"));
      }
      const title = P ? "Income & spending" : "Profit & loss";
      const when = `${ZL.date(p.from)} to ${ZL.date(p.to)}`;
      const colNow = monthsSpan(p.from, p.to) === 1 && p.from.slice(8) === "01" ? new Date(`${p.from}T00:00:00Z`).toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }) : "This period";
      const colPrev = cmp ? (compare === "ly" ? "Last year" : "Previous") : "";
      const margin = ZL.cents(revenueTotal.now) ? (net.now / revenueTotal.now) * 100 : null;
      const csvRows = [[title, when], [], ["Line", "Code", colNow, ...(cmp ? [colPrev] : [])]]
        .concat(rows.filter((r) => r.kind !== "grp" && r.kind !== "note").map((r) => [r.label, r.code || "", ZL.num(r.now).toFixed(2), ...(cmp ? [ZL.num(r.prev).toFixed(2)] : [])]));
      this._csv = { name: `${P ? "income-and-spending" : "profit-and-loss"}-${p.from}-to-${p.to}.csv`, rows: csvRows };
      Object.assign(ctx.params, { preset: p.preset, from: p.from, to: p.to, compare });
      return ZL.header(title, P ? "What came in, what went out, and what you kept." : "Revenue, costs and the result for the period.",
          btn("zl-rprint", "Print", "ghost") + exportButton()) + `
        <div class="toolbar">${rangeControls(p, ctx.today)}
          <label class="field"><span class="hint">Compare</span><select id="zl-rcmp" aria-label="Compare with">
            <option value="prev"${compare === "prev" ? " selected" : ""}>Previous period</option>
            <option value="ly"${compare === "ly" ? " selected" : ""}>Same period last year</option>
            <option value="none"${compare === "none" ? " selected" : ""}>No comparison</option></select></label>
        </div>
        <section class="stmt">
          ${await letterhead(P ? "Income and spending" : "Statement of profit or loss", `For ${when}`)}
          <div class="tablewrap"><table>
            <thead><tr><th></th><th class="r">${colNow}</th>${cmp ? `<th class="r">${colPrev}</th>` : ""}</tr></thead>
            <tbody>${stmtRows(rows, !!cmp, ZL.can("ledger.view"))}</tbody>
          </table></div>
          <div class="proofrow"><span class="ok">${TICK}Summed from posted journals — ${P ? "every line opens its ledger" : "every line traces to its ledger"}</span>
            <span class="figs">${margin == null ? "" : `<span>${P ? "Savings rate" : "Net margin"} <b class="num">${margin.toFixed(1)}%</b></span>`}
              <span>${P ? "Kept" : "Result"} <b class="num">${M(net.now, { symbol: true })}</b></span></span></div>
        </section>`;
    },
    after(root, ctx) {
      const p = ctx.params;
      wireRange(root, "pl", p, ctx.today);
      root.querySelector("#zl-rcmp").addEventListener("change", (ev) => ZL.open("pl", Object.assign({}, p, { compare: ev.target.value })));
      wireCommon(root, "pl", p, ctx.today, ZL.modules.pl._csv);
    },
  });

  // ══ Balance sheet / Net worth ═════════════════════════════════════════════
  ZL.register("bs", {
    title: "Balance sheet",
    perm: "report.view",
    async render(ctx) {
      const P = ZL.isPersonal();
      const asAt = ctx.params.asAt || ctx.today;
      const compare = ctx.params.compare || (P ? "lm" : "ly");
      const cmpDate = compare === "none" ? null : compare === "lm"
        ? ZL.addDays(ZL.monthStart(asAt), -1)
        : `${+asAt.slice(0, 4) - 1}-12-31`;
      const [now, prev, accounts] = await Promise.all([
        balances(ZL.yearStart(asAt), asAt),
        cmpDate ? balances(ZL.yearStart(cmpDate), cmpDate) : Promise.resolve([]),
        ZL.accounts(),
      ]);
      const byId = new Map(accounts.map((a) => [a.id, a]));
      const prevMap = new Map(prev.map((b) => [b.account_id, b]));
      const nat = (b) => (b ? ZL.natural(b.type, ZL.cents(b.closing)) / 100 : 0);
      const pick = (f) => now.filter((b) => b.is_postable && f(b))
        .map((b) => ({ id: b.account_id, code: b.code, label: b.name, parent: b.parent_id, now: nat(b), prev: cmpDate ? nat(prevMap.get(b.account_id)) : null }))
        .filter((r) => ZL.cents(r.now) || ZL.cents(r.prev));
      const tot = (rows) => ({ now: ZL.sum(rows, (r) => r.now), prev: cmpDate ? ZL.sum(rows, (r) => r.prev) : null });
      const sub = (label, t, kind = "sub") => ({ kind, label, now: t.now, prev: t.prev });
      const pl = (b) => b.type === "REVENUE" || b.type === "EXPENSE" || b.type === "COST_OF_SALES";
      // Results not yet closed into equity: this year's, and any earlier years'.
      const resultOf = (list, field) => list.filter(pl).reduce((s, b) => s + (field === "year"
        ? ZL.cents(b.period_credit) - ZL.cents(b.period_debit) : -ZL.cents(b.opening)), 0) / 100;
      const yearNow = resultOf(now, "year"), yearPrev = cmpDate ? resultOf(prev, "year") : null;
      const priorNow = resultOf(now, "prior"), priorPrev = cmpDate ? resultOf(prev, "prior") : null;

      const rows = [];
      const grouped = (list) => {
        const groups = new Map();
        list.forEach((r) => { const h = byId.get(r.parent); const k = h ? h.name : "Other"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
        return groups;
      };
      let tA, tL, tE;
      if (P) {
        const own = pick((b) => b.type === "ASSET"), owe = pick((b) => b.type === "LIABILITY");
        rows.push({ kind: "grp", label: "What I own" });
        grouped(own).forEach((list, h) => { rows.push({ kind: "ind", head: true, label: h, now: null, prev: null }, ...list.map((r) => Object.assign({ kind: "ind", deep: true }, r))); });
        if (!own.length) rows.push({ kind: "note", label: "Nothing recorded yet." });
        tA = tot(own);
        rows.push(sub("Total I own", tA), { kind: "grp", label: "What I owe" });
        grouped(owe).forEach((list, h) => { rows.push({ kind: "ind", head: true, label: h, now: null, prev: null }, ...list.map((r) => Object.assign({ kind: "ind", deep: true }, r))); });
        if (!owe.length) rows.push({ kind: "note", label: "No debts recorded." });
        tL = tot(owe);
        rows.push(sub("Total I owe", tL));
        const nw = { now: (ZL.cents(tA.now) - ZL.cents(tL.now)) / 100, prev: cmpDate ? (ZL.cents(tA.prev) - ZL.cents(tL.prev)) / 100 : null };
        rows.push(sub("Net worth", nw, "tot"), { kind: "grp", label: "How my net worth is made up" });
        const eq = pick((b) => b.type === "EQUITY");
        rows.push(...eq.map((r) => Object.assign({ kind: "ind" }, r)));
        rows.push({ kind: "ind", label: "Saved this year", now: yearNow, prev: yearPrev });
        if (ZL.cents(priorNow) || ZL.cents(priorPrev)) rows.push({ kind: "ind", label: "Saved in earlier years", now: priorNow, prev: priorPrev });
        tE = { now: (ZL.sum(eq, (r) => r.now) * 100 + ZL.cents(yearNow) + ZL.cents(priorNow)) / 100,
          prev: cmpDate ? (ZL.sum(eq, (r) => r.prev) * 100 + ZL.cents(yearPrev) + ZL.cents(priorPrev)) / 100 : null };
        rows.push(sub("Net worth", tE, "tot soft"));
      } else {
        const nca = pick((b) => b.type === "ASSET" && b.sub_type === "NON_CURRENT_ASSET");
        const ca = pick((b) => b.type === "ASSET" && b.sub_type !== "NON_CURRENT_ASSET");
        const cl = pick((b) => b.type === "LIABILITY" && b.sub_type !== "NON_CURRENT_LIABILITY");
        const ncl = pick((b) => b.type === "LIABILITY" && b.sub_type === "NON_CURRENT_LIABILITY");
        const eq = pick((b) => b.type === "EQUITY");
        const block = (label, list, total) => {
          if (!list.length) return;
          rows.push({ kind: "grp", label }, ...list.map((r) => Object.assign({ kind: "ind" }, r)), sub(total, tot(list)));
        };
        block("Non-current assets", nca, "Total non-current assets");
        block("Current assets", ca, "Total current assets");
        tA = tot(nca.concat(ca));
        rows.push(sub("Total assets", tA, "tot"));
        block("Current liabilities", cl, "Total current liabilities");
        block("Non-current liabilities", ncl, "Total non-current liabilities");
        tL = tot(cl.concat(ncl));
        rows.push(sub("Total liabilities", tL, "tot soft"));
        rows.push({ kind: "grp", label: "Equity" }, ...eq.map((r) => Object.assign({ kind: "ind" }, r)));
        rows.push({ kind: "ind", label: "Profit for the year to date", now: yearNow, prev: yearPrev });
        if (ZL.cents(priorNow) || ZL.cents(priorPrev)) rows.push({ kind: "ind", label: "Results of earlier years not yet closed", now: priorNow, prev: priorPrev });
        tE = { now: (ZL.sum(eq, (r) => r.now) * 100 + ZL.cents(yearNow) + ZL.cents(priorNow)) / 100,
          prev: cmpDate ? (ZL.sum(eq, (r) => r.prev) * 100 + ZL.cents(yearPrev) + ZL.cents(priorPrev)) / 100 : null };
        rows.push(sub("Total equity", tE));
        rows.push(sub("Total liabilities and equity", { now: (ZL.cents(tL.now) + ZL.cents(tE.now)) / 100, prev: cmpDate ? (ZL.cents(tL.prev) + ZL.cents(tE.prev)) / 100 : null }, "tot"));
      }
      const diff = (ZL.cents(tA.now) - ZL.cents(tL.now) - ZL.cents(tE.now)) / 100;
      const title = P ? "Net worth" : "Balance sheet";
      const colNow = ZL.date(asAt), colPrev = cmpDate ? ZL.date(cmpDate) : "";
      this._csv = { name: `${P ? "net-worth" : "balance-sheet"}-${asAt}.csv`,
        rows: [[title, `As at ${asAt}`], [], ["Line", "Code", asAt, ...(cmpDate ? [cmpDate] : [])]]
          .concat(rows.filter((r) => r.kind !== "grp" && r.kind !== "note").map((r) => [r.label, r.code || "", ZL.num(r.now).toFixed(2), ...(cmpDate ? [ZL.num(r.prev).toFixed(2)] : [])])) };
      Object.assign(ctx.params, { asAt, compare });
      return ZL.header(title, P ? "Everything you own, less everything you owe." : "What the business owns, owes and has retained.",
          btn("zl-rprint", "Print", "ghost") + exportButton()) + `
        <div class="toolbar">
          <label class="field"><span class="hint">As at</span><input id="zl-basat" type="date" value="${E(asAt)}" aria-label="As at"></label>
          ${ZL.applyButton("zl-bapply")}
          <label class="field"><span class="hint">Compare</span><select id="zl-bcmp" aria-label="Compare with">
            <option value="lm"${compare === "lm" ? " selected" : ""}>End of last month</option>
            <option value="ly"${compare === "ly" ? " selected" : ""}>End of last year</option>
            <option value="none"${compare === "none" ? " selected" : ""}>No comparison</option></select></label>
        </div>
        <section class="stmt">
          ${await letterhead(P ? "Statement of net worth" : "Statement of financial position", `As at ${ZL.date(asAt)}`)}
          <div class="tablewrap"><table>
            <thead><tr><th></th><th class="r">${colNow}</th>${cmpDate ? `<th class="r">${colPrev}</th>` : ""}</tr></thead>
            <tbody>${stmtRows(rows, !!cmpDate, ZL.can("ledger.view"))}</tbody>
          </table></div>
          <div class="proofrow">${ZL.cents(diff) === 0
            ? `<span class="ok">${TICK}${P ? "What you own − what you owe = net worth" : "Assets = liabilities + equity"}</span>`
            : `<span style="color:var(--bad);font-weight:500">Out by ${M(diff)} — check the trial balance</span>`}
            <span class="figs"><span>${P ? "Own" : "Assets"} <b class="num">${M(tA.now)}</b></span><span>${P ? "Owe" : "Liabilities"} <b class="num">${M(tL.now)}</b></span>
              <span>${P ? "Net worth" : "Equity"} <b class="num">${M(tE.now)}</b></span><span>Difference <b class="num">${M(diff)}</b></span></span></div>
        </section>`;
    },
    after(root, ctx) {
      const p = ctx.params;
      ZL.wireApply(root, ["zl-basat"], "zl-bapply", () => {
        const asAt = root.querySelector("#zl-basat").value;
        if (!asAt) { ZL.toast("Choose a date.", "warn"); return; }
        ZL.open("bs", Object.assign({}, p, { asAt }));
      });
      root.querySelector("#zl-bcmp").addEventListener("change", (ev) => ZL.open("bs", Object.assign({}, p, { compare: ev.target.value })));
      wireCommon(root, "bs", { to: p.asAt, from: ZL.yearStart(p.asAt) }, ctx.today, ZL.modules.bs._csv);
    },
  });

  // ══ Trial balance ═════════════════════════════════════════════════════════
  ZL.register("tb", {
    title: "Trial balance",
    perm: "report.view",
    async render(ctx) {
      const p = resolveRange(ctx.params, ctx.today, "ytd");
      const bal = await balances(p.from, p.to);
      const rows = bal.filter((b) => b.is_postable && (p.zero || ZL.cents(b.closing) || ZL.cents(b.period_debit) || ZL.cents(b.period_credit)));
      const cd = (b) => Math.max(0, ZL.cents(b.closing)), cc = (b) => Math.max(0, -ZL.cents(b.closing));
      const tPd = rows.reduce((s, b) => s + ZL.cents(b.period_debit), 0), tPc = rows.reduce((s, b) => s + ZL.cents(b.period_credit), 0);
      const tCd = rows.reduce((s, b) => s + cd(b), 0), tCc = rows.reduce((s, b) => s + cc(b), 0);
      const ok = tCd === tCc && tPd === tPc;
      const cell = (c) => (c ? `<td class="r num">${M(c / 100)}</td>` : `<td class="r nil">–</td>`);
      this._csv = { name: `trial-balance-${p.from}-to-${p.to}.csv`, rows: [["Trial balance", `${p.from} to ${p.to}`], [],
        ["Code", "Account", "Period debit", "Period credit", "Closing debit", "Closing credit"]]
        .concat(rows.map((b) => [b.code, b.name, (ZL.cents(b.period_debit) / 100).toFixed(2), (ZL.cents(b.period_credit) / 100).toFixed(2), (cd(b) / 100).toFixed(2), (cc(b) / 100).toFixed(2)]))
        .concat([["", "Totals", (tPd / 100).toFixed(2), (tPc / 100).toFixed(2), (tCd / 100).toFixed(2), (tCc / 100).toFixed(2)]]) };
      Object.assign(ctx.params, { preset: p.preset, from: p.from, to: p.to });
      return ZL.header("Trial balance", "Every account's balance. Debits must equal credits.", btn("zl-rprint", "Print", "ghost") + exportButton()) + `
        <div class="toolbar">${rangeControls(p, ctx.today)}
          <label class="field in"><input id="tsearch" type="search" placeholder="Search accounts" aria-label="Search the trial balance"></label>
          <label class="zl-check" style="font-size:13px"><input type="checkbox" id="zl-tzero"${p.zero ? " checked" : ""}><span>Show zero balances</span></label>
          <span class="count" id="tcount"></span>
        </div>
        <section class="card"><div class="tablewrap"><table>
          <thead><tr><th>Account</th><th class="r">Debit (period)</th><th class="r">Credit (period)</th><th class="r">Closing debit</th><th class="r">Closing credit</th></tr></thead>
          <tbody id="tbody">${rows.map((b) => `<tr class="click" data-gl="${b.account_id}" data-text="${E((b.code + " " + b.name).toLowerCase())}">
            <td><span class="code" style="display:inline-block;min-width:44px">${E(b.code)}</span>${E(b.name)}${b.is_active ? "" : ' <span class="chip">Archived</span>'}</td>
            ${cell(ZL.cents(b.period_debit))}${cell(ZL.cents(b.period_credit))}${cell(cd(b))}${cell(cc(b))}</tr>`).join("")}
            ${rows.length ? "" : `<tr><td colspan="5" class="nil" style="text-align:center;padding:22px">No balances in this period yet.</td></tr>`}</tbody>
          <tfoot><tr><td style="font-weight:600">Totals</td>
            <td class="r num" style="font-weight:600">${M(tPd / 100)}</td><td class="r num" style="font-weight:600">${M(tPc / 100)}</td>
            <td class="r num" style="font-weight:600">${M(tCd / 100)}</td><td class="r num" style="font-weight:600">${M(tCc / 100)}</td></tr></tfoot>
        </table></div>
        <div class="proofrow">${ok ? `<span class="ok">${TICK}Debits equal credits</span>` : `<span style="color:var(--bad);font-weight:500">Out of balance — contact support</span>`}
          <span class="figs"><span>Closing debit <b class="num">${M(tCd / 100)}</b></span><span>Closing credit <b class="num">${M(tCc / 100)}</b></span>
            <span>Difference <b class="num">${M((tCd - tCc) / 100)}</b></span></span></div>
        </section>`;
    },
    after(root, ctx) {
      const p = ctx.params;
      wireRange(root, "tb", p, ctx.today);
      root.querySelector("#zl-tzero").addEventListener("change", (ev) => ZL.open("tb", Object.assign({}, p, { zero: ev.target.checked })));
      root.querySelectorAll("tr[data-gl]").forEach((tr) => tr.addEventListener("click", () => ZL.open("gl", { account: tr.dataset.gl, from: p.from, to: p.to })));
      const csv = root.querySelector("#zl-rcsv");
      if (csv) csv.addEventListener("click", () => ZL.csv(ZL.modules.tb._csv.name, ZL.modules.tb._csv.rows));
      const pr = root.querySelector("#zl-rprint");
      if (pr) pr.addEventListener("click", () => window.print());
    },
  });
})();
