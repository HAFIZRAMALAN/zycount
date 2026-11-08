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
  function stmtRows(rows, hasPrev, canGL, pctBase) {
    const span = 2 + (hasPrev ? 1 : 0) + (pctBase ? 1 : 0);
    return rows.map((r) => {
      if (r.kind === "grp") return `<tr class="grp"><td colspan="${span}">${E(r.label)}${r.term ? " " + ZL.term(r.term, "?") : ""}</td></tr>`;
      if (r.kind === "note") return `<tr class="ind"><td colspan="${span}" class="nil">${E(r.label)}</td></tr>`;
      const cell = (v, dim) => `<td class="r num${dim ? " nil" : ""}">${v == null ? "" : ZL.cents(v) ? M(v) : "–"}</td>`;
      const pct = pctBase ? `<td class="r num nil">${r.now == null || !ZL.cents(pctBase) ? "" : ((r.now / pctBase) * 100).toFixed(1) + "%"}</td>` : "";
      const label = r.kind === "ind" && r.id && canGL
        ? `<button type="button" class="zl-ref" style="color:inherit;font:inherit;text-align:left" data-gl="${r.id}">${E(r.label)}</button>`
        : E(r.label);
      const cls = r.kind + (r.head ? " zl-head" : "") + (r.deep ? " zl-deep" : "");
      return `<tr class="${cls}"><td>${label}${r.code ? ` <span class="code">${E(r.code)}</span>` : ""}${r.help ? `<div class="hint" style="font-weight:400">${r.help}</div>` : ""}</td>${cell(r.now)}${pct}${hasPrev ? cell(r.prev, true) : ""}</tr>`;
    }).join("");
  }

  /** Plain-language summary of a P&L: what came in, what it cost, what was kept. */
  function plSummary(P, revenue, costs, net, prevNet) {
    const r = ZL.num(revenue), c = ZL.num(costs), n = ZL.num(net);
    const max = Math.max(r, c, 0.01);
    const kept = r > 0 ? n / r : null;
    const change = prevNet != null && ZL.cents(prevNet) ? ((n - prevNet) / Math.abs(prevNet)) * 100 : null;
    return `<section class="card zr-sum">
      <div class="zr-eq"><div><span>${P ? "Came in" : "Sales & income"}</span><b class="num" style="color:var(--ar)">${M(r, { symbol: true })}</b></div>
        <i>−</i><div><span>${P ? "Went out" : "All costs"}</span><b class="num" style="color:var(--ap)">${M(c, { symbol: true })}</b></div>
        <i>=</i><div><span>${n >= 0 ? (P ? "You kept" : "Profit") : (P ? "Overspent" : "Loss")}</span><b class="num" style="color:${n >= 0 ? "var(--good,#16a34a)" : "var(--bad)"}">${M(Math.abs(n), { symbol: true })}</b></div></div>
      <div class="zr-bars"><div><span>In</span><i style="width:${(r / max) * 100}%;background:var(--ar)"></i></div><div><span>Out</span><i style="width:${(c / max) * 100}%;background:var(--ap)"></i></div></div>
      <p class="hint" style="margin:8px 0 0">${kept == null ? (P ? "Nothing came in during this period." : "No sales in this period yet.")
        : n >= 0 ? `${P ? "You kept" : "The business kept"} <b>RM ${(kept).toFixed(2)}</b> of every RM 1 ${P ? "that came in" : "of sales"} after ${P ? "spending" : "every cost"}.`
        : `${P ? "You spent" : "Costs were"} <b>RM ${(c / r).toFixed(2)}</b> for every RM 1 ${P ? "that came in" : "of sales"}.`}
        ${change == null ? "" : Math.abs(change) < 0.5 ? " The same as the comparison period." : ` ${n >= (prevNet || 0) ? "Up" : "Down"} <b>${Math.abs(change).toFixed(0)}%</b> on the comparison period.`}</p>
    </section>`;
  }

  const style = document.createElement("style");
  style.textContent = `
  .stmt tr.zl-head td{color:var(--ink)!important;font-weight:500;padding-top:12px}
  .zr-sum{padding:16px 20px;margin-bottom:14px}
  .zr-eq{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .zr-eq>div span{display:block;font-size:12.5px;color:var(--ink-3)}
  .zr-eq>div b{font-size:22px;font-weight:600}
  .zr-eq>i{font-style:normal;font-size:20px;color:var(--ink-3)}
  .zr-bars{display:grid;gap:5px;margin-top:12px;max-width:520px}
  .zr-bars div{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink-3)}
  .zr-bars span{width:28px}.zr-bars i{display:block;height:8px;border-radius:99px;min-width:2px}
  .zr-month td,.zr-month th{white-space:nowrap}
  .zr-month .zr-stick{position:sticky;left:0;background:var(--card);z-index:1;min-width:200px}
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

  // ── P&L by month: one column per month (up to 12) plus a total ────────────
  async function plMonthly(ctx, p) {
    const P = ZL.isPersonal();
    let months = [];
    for (let m = ZL.monthStart(p.from); m <= p.to; m = shiftMonths(m, 1)) {
      months.push({ from: m < p.from ? p.from : m, to: ZL.monthEnd(m) > p.to ? p.to : ZL.monthEnd(m),
        label: new Date(`${m}T00:00:00Z`).toLocaleString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }) });
      if (months.length > 36) break;
    }
    const cut = months.length > 12;
    if (cut) months = months.slice(-12);
    const all = await Promise.all(months.map((m) => balances(m.from, m.to)));
    const acc = new Map();
    all.forEach((list, i) => list.filter((b) => b.is_postable && ["REVENUE", "EXPENSE", "COST_OF_SALES"].includes(b.type)).forEach((b) => {
      if (!acc.has(b.account_id)) acc.set(b.account_id, { id: b.account_id, code: b.code, name: b.name, type: b.type, sub: b.sub_type, v: months.map(() => 0) });
      const credit = b.type === "REVENUE";
      acc.get(b.account_id).v[i] = (credit ? ZL.cents(b.period_credit) - ZL.cents(b.period_debit) : ZL.cents(b.period_debit) - ZL.cents(b.period_credit)) / 100;
    }));
    const list = (f) => [...acc.values()].filter(f).filter((a) => a.v.some((x) => ZL.cents(x))).sort((a, b) => a.code.localeCompare(b.code));
    const sumV = (rows) => months.map((_, i) => rows.reduce((s, r) => s + ZL.cents(r.v[i]), 0) / 100);
    const op = (a, b, sign) => a.map((x, i) => (ZL.cents(x) + sign * ZL.cents(b[i])) / 100);
    const rows = [];
    const section = (label, items, totalLabel) => {
      rows.push({ kind: "grp", label });
      items.forEach((a) => rows.push({ kind: "ind", id: a.id, code: a.code, label: a.name, v: a.v }));
      if (!items.length) rows.push({ kind: "note", label: "Nothing posted." });
      const t = sumV(items);
      rows.push({ kind: "sub", label: totalLabel, v: t });
      return t;
    };
    let net;
    if (P) {
      const inc = section("Income", list((a) => a.type === "REVENUE"), "Total income");
      const sp = section("Spending", list((a) => a.type !== "REVENUE"), "Total spending");
      net = op(inc, sp, -1);
      rows.push({ kind: "tot", label: "Kept", v: net });
    } else {
      const rev = section("Revenue", list((a) => a.type === "REVENUE" && a.sub !== "OTHER_INCOME"), "Total revenue");
      const cosItems = list((a) => a.type === "COST_OF_SALES");
      const cos = cosItems.length ? section("Cost of sales", cosItems, "Total cost of sales") : months.map(() => 0);
      const gp = op(rev, cos, -1);
      rows.push({ kind: "tot soft", label: "Gross profit", v: gp });
      const opex = section("Operating expenses", list((a) => a.type === "EXPENSE" && a.sub !== "OTHER_EXPENSE"), "Total operating expenses");
      let res = op(gp, opex, -1);
      rows.push({ kind: "tot soft", label: "Operating profit", v: res });
      const oiItems = list((a) => a.type === "REVENUE" && a.sub === "OTHER_INCOME");
      if (oiItems.length) res = op(res, section("Other income", oiItems, "Total other income"), 1);
      const oeItems = list((a) => a.type === "EXPENSE" && a.sub === "OTHER_EXPENSE");
      if (oeItems.length) res = op(res, section("Other expenses and finance costs", oeItems, "Total other expenses"), -1);
      net = res;
      rows.push({ kind: "tot", label: "Net profit / (loss)", v: net });
    }
    const total = (v) => v.reduce((s, x) => s + ZL.cents(x), 0) / 100;
    const canGL = ZL.can("ledger.view");
    const cells = (v) => v.map((x) => `<td class="r num">${ZL.cents(x) ? M(x) : '<span class="nil">–</span>'}</td>`).join("") + `<td class="r num" style="font-weight:600">${M(total(v))}</td>`;
    const body = rows.map((r) => {
      if (r.kind === "grp") return `<tr class="grp"><td colspan="${months.length + 2}">${E(r.label)}</td></tr>`;
      if (r.kind === "note") return `<tr class="ind"><td colspan="${months.length + 2}" class="nil">${E(r.label)}</td></tr>`;
      const label = r.kind === "ind" && canGL ? `<button type="button" class="zl-ref" style="color:inherit;font:inherit;text-align:left" data-gl="${r.id}">${E(r.label)}</button>` : E(r.label);
      return `<tr class="${r.kind}"><td class="zr-stick">${label}${r.code ? ` <span class="code">${E(r.code)}</span>` : ""}</td>${cells(r.v)}</tr>`;
    }).join("");
    const best = net.reduce((bi, x, i) => (x > net[bi] ? i : bi), 0);
    const worst = net.reduce((bi, x, i) => (x < net[bi] ? i : bi), 0);
    ZL.modules.pl._csv = { name: `${P ? "income-and-spending" : "profit-and-loss"}-by-month-${p.from}-to-${p.to}.csv`,
      rows: [["Line", "Code", ...months.map((m) => m.label), "Total"]].concat(rows.filter((r) => r.v).map((r) => [r.label, r.code || "", ...r.v.map((x) => ZL.num(x).toFixed(2)), total(r.v).toFixed(2)])) };
    Object.assign(ctx.params, { preset: p.preset, from: p.from, to: p.to, view: "month" });
    return ZL.header(P ? "Income & spending by month" : "Profit & loss by month", "Each month side by side — spot the good months, the slow ones and the costs that creep up.",
        btn("zl-rprint", "Print", "ghost") + exportButton()) + `
      <div class="toolbar">${rangeControls(p, ctx.today)}
        <div class="seg" role="group" aria-label="View"><button type="button" data-plview="" aria-pressed="false">Statement</button><button type="button" data-plview="month" aria-pressed="true">By month</button></div></div>
      ${cut ? `<p class="hint" style="margin:-4px 0 10px">Showing the last 12 months of the range.</p>` : ""}
      <section class="stmt">
        ${await letterhead(P ? "Income and spending by month" : "Profit or loss by month", `${ZL.date(p.from)} to ${ZL.date(p.to)}`)}
        <div class="tablewrap"><table class="zr-month">
          <thead><tr><th class="zr-stick"></th>${months.map((m) => `<th class="r">${E(m.label)}</th>`).join("")}<th class="r">Total</th></tr></thead>
          <tbody>${body}</tbody></table></div>
        <div class="proofrow"><span class="ok">${TICK}Every month summed from posted journals</span>
          <span class="figs">${months.length > 1 ? `<span>Best month <b>${E(months[best].label)}</b></span><span>Weakest <b>${E(months[worst].label)}</b></span>` : ""}
            <span>${P ? "Kept" : "Result"} <b class="num">${M(total(net), { symbol: true })}</b></span></span></div>
      </section>`;
  }

  // ══ Profit and loss / Income and spending ═════════════════════════════════
  ZL.register("pl", {
    title: "Profit & loss",
    perm: "report.view",
    async render(ctx) {
      const P = ZL.isPersonal();
      const p = resolveRange(ctx.params, ctx.today, "ytd");
      if (ctx.params.view === "month") return plMonthly(ctx, p);
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

      let rows = [], net, revenueTotal, costTotal, incomeTotal;
      if (P) {
        const income = pick((b) => b.type === "REVENUE", true);
        const spending = pick((b) => b.type === "EXPENSE" || b.type === "COST_OF_SALES", false);
        const ti = tot(income), ts = tot(spending);
        revenueTotal = ti;
        incomeTotal = ti;
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
        costTotal = ts;
        rows.push(sub(ZL.cents(net.now) >= 0 ? "Saved in this period" : "Overspent in this period", net, "tot"));
      } else {
        const rev = pick((b) => b.type === "REVENUE" && b.sub_type !== "OTHER_INCOME", true);
        const cos = pick((b) => b.type === "COST_OF_SALES", false);
        const opex = pick((b) => b.type === "EXPENSE" && b.sub_type !== "OTHER_EXPENSE", false);
        const oi = pick((b) => b.type === "REVENUE" && b.sub_type === "OTHER_INCOME", true);
        const oe = pick((b) => b.type === "EXPENSE" && b.sub_type === "OTHER_EXPENSE", false);
        const tRev = tot(rev), tCos = tot(cos), tOpex = tot(opex), tOi = tot(oi), tOe = tot(oe);
        revenueTotal = tRev;
        incomeTotal = plus(tRev, tOi);
        costTotal = plus(plus(tCos, tOpex), tOe);
        const gp = minus(tRev, tCos), op = minus(gp, tOpex);
        net = minus(plus(op, tOi), tOe);
        const section = (label, list, total, totalLabel, term) => {
          rows.push({ kind: "grp", label, term });
          if (list.length) rows.push(...list.map((r) => Object.assign({ kind: "ind" }, r)));
          else rows.push({ kind: "note", label: "Nothing posted." });
          rows.push(sub(totalLabel, total));
        };
        section("Revenue", rev, tRev, "Total revenue");
        if (cos.length) section("Cost of sales", cos, tCos, "Total cost of sales", "gross");
        rows.push(Object.assign(sub("Gross profit", gp, "tot soft"), { help: "Sales minus the direct cost of what you sold" }));
        section("Operating expenses", opex, tOpex, "Total operating expenses", "opex");
        rows.push(Object.assign(sub("Operating profit", op, "tot soft"), { help: "What the day-to-day business earned, before other income and finance costs" }));
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
        ${ZL.tip("pl", P ? "Reading this page" : "How to read a profit & loss", P ? "Income at the top, spending grouped below, and what you kept at the bottom. Click any line to see every entry behind it."
          : `Sales at the top, then each kind of cost. ${ZL.term("gross", "Gross profit")} shows whether selling makes money; the bottom line is what the business earned in the period. Profit isn't cash — see ${ZL.term("cf", "cash flow")}.`)}
        ${plSummary(P, incomeTotal.now, costTotal.now, net.now, cmp ? net.prev : null)}
        <div class="toolbar">${rangeControls(p, ctx.today)}
          <div class="seg" role="group" aria-label="View"><button type="button" data-plview="" aria-pressed="true">Statement</button><button type="button" data-plview="month" aria-pressed="false">By month</button></div>
          <label class="zl-check" style="font-size:13px"><input type="checkbox" id="zl-rpct"${ctx.params.pct ? " checked" : ""}><span>% of ${P ? "income" : "sales"}</span></label>
          <label class="field"><span class="hint">Compare</span><select id="zl-rcmp" aria-label="Compare with">
            <option value="prev"${compare === "prev" ? " selected" : ""}>Previous period</option>
            <option value="ly"${compare === "ly" ? " selected" : ""}>Same period last year</option>
            <option value="none"${compare === "none" ? " selected" : ""}>No comparison</option></select></label>
        </div>
        <section class="stmt">
          ${await letterhead(P ? "Income and spending" : "Statement of profit or loss", `For ${when}`)}
          <div class="tablewrap"><table>
            <thead><tr><th></th><th class="r">${colNow}</th>${ctx.params.pct ? `<th class="r">%</th>` : ""}${cmp ? `<th class="r">${colPrev}</th>` : ""}</tr></thead>
            <tbody>${stmtRows(rows, !!cmp, ZL.can("ledger.view"), ctx.params.pct ? (P ? incomeTotal.now : revenueTotal.now) : null)}</tbody>
          </table></div>
          <div class="proofrow"><span class="ok">${TICK}Summed from posted journals — ${P ? "every line opens its ledger" : "every line traces to its ledger"}</span>
            <span class="figs">${margin == null ? "" : `<span>${P ? "Savings rate" : "Net margin"} <b class="num">${margin.toFixed(1)}%</b></span>`}
              <span>${P ? "Kept" : "Result"} <b class="num">${M(net.now, { symbol: true })}</b></span></span></div>
        </section>`;
    },
    after(root, ctx) {
      const p = ctx.params;
      wireRange(root, "pl", p, ctx.today);
      const cmpSel = root.querySelector("#zl-rcmp");
      if (cmpSel) cmpSel.addEventListener("change", (ev) => ZL.open("pl", Object.assign({}, p, { compare: ev.target.value })));
      const pct = root.querySelector("#zl-rpct");
      if (pct) pct.addEventListener("change", (ev) => ZL.open("pl", Object.assign({}, p, { pct: ev.target.checked || undefined })));
      root.querySelectorAll("[data-plview]").forEach((b) => b.addEventListener("click", () => ZL.open("pl", Object.assign({}, p, { view: b.dataset.plview || undefined }))));
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

  // ══ Cash flow (indirect method, proved against the cash accounts) ══════════
  ZL.register("cf", {
    title: "Cash flow",
    perm: "report.view",
    async render(ctx) {
      const P = ZL.isPersonal();
      const p = resolveRange(ctx.params, ctx.today, "ytd");
      const bal = await balances(p.from, p.to);
      const mv = (b) => ZL.cents(b.period_debit) - ZL.cents(b.period_credit); // debit-positive movement, in cents
      const pl = bal.filter((b) => b.is_postable && ["REVENUE", "EXPENSE", "COST_OF_SALES"].includes(b.type));
      const profit = -pl.reduce((s, b) => s + mv(b), 0);
      const cash = bal.filter((b) => b.is_postable && b.is_cash);
      const cashOpen = cash.reduce((s, b) => s + ZL.cents(b.opening), 0), cashMove = cash.reduce((s, b) => s + mv(b), 0);
      const bs = bal.filter((b) => b.is_postable && !b.is_cash && ["ASSET", "LIABILITY", "EQUITY"].includes(b.type) && mv(b) !== 0);
      const isDep = (b) => b.type === "ASSET" && /accumulated|depreciation|susut/i.test(b.name);
      const ops = [], inv = [], fin = [];
      bs.forEach((b) => {
        const effect = -mv(b); // more of an asset = cash spent; more owed = cash kept
        const up = b.type === "ASSET" ? mv(b) > 0 : mv(b) < 0;
        const line = { id: b.account_id, code: b.code, effect,
          label: isDep(b) ? `Add back: ${b.name} (not cash)` : `${up ? "Increase" : "Decrease"} in ${b.name}` };
        if (isDep(b)) ops.push(line);
        else if (b.type === "ASSET" && b.sub_type === "NON_CURRENT_ASSET") inv.push(line);
        else if (b.type === "EQUITY" || (b.type === "LIABILITY" && b.sub_type === "NON_CURRENT_LIABILITY")) fin.push(line);
        else ops.push(line);
      });
      const t = (l) => l.reduce((s, x) => s + x.effect, 0);
      const tOps = profit + t(ops), tInv = t(inv), tFin = t(fin);
      const net = tOps + tInv + tFin;
      const ok = net === cashMove;
      const canGL = ZL.can("ledger.view");
      const row = (x) => `<tr class="ind"><td>${x.id && canGL ? `<button type="button" class="zl-ref" style="color:inherit;font:inherit;text-align:left" data-gl="${x.id}">${E(x.label)}</button>` : E(x.label)}${x.code ? ` <span class="code">${E(x.code)}</span>` : ""}</td>
        <td class="r num">${x.effect ? M(x.effect / 100) : "–"}</td></tr>`;
      const block = (title, help, lines, total, totalLabel) => `<tr class="grp"><td colspan="2">${E(title)} <span class="hint" style="font-weight:400;text-transform:none;letter-spacing:0">— ${help}</span></td></tr>
        ${lines.map(row).join("") || `<tr class="ind"><td colspan="2" class="nil">Nothing in this period.</td></tr>`}
        <tr class="sub"><td>${E(totalLabel)}</td><td class="r num">${M(total / 100)}</td></tr>`;
      const c2 = (x) => (x / 100).toFixed(2);
      this._csv = { name: `cash-flow-${p.from}-to-${p.to}.csv`, rows: [["Cash flow", `${p.from} to ${p.to}`], [], ["Line", "Code", "Amount"],
        [P ? "Saved in the period" : "Profit for the period", "", c2(profit)], ...ops.map((x) => [x.label, x.code, c2(x.effect)]),
        ["Net cash from operating activities", "", c2(tOps)], ...inv.map((x) => [x.label, x.code, c2(x.effect)]),
        ["Net cash from investing activities", "", c2(tInv)], ...fin.map((x) => [x.label, x.code, c2(x.effect)]),
        ["Net cash from financing activities", "", c2(tFin)], ["Net change in cash", "", c2(net)],
        ["Cash at start", "", c2(cashOpen)], ["Cash at end", "", c2(cashOpen + cashMove)]] };
      Object.assign(ctx.params, { preset: p.preset, from: p.from, to: p.to });
      const when = `${ZL.date(p.from)} to ${ZL.date(p.to)}`;
      const did = (v) => (v >= 0 ? "brought in" : "used");
      return ZL.header("Cash flow", "Why your bank and cash balances moved — and why profit and cash are not the same.", btn("zl-rprint", "Print", "ghost") + exportButton()) +
        ZL.tip("cf", "Profit isn't cash", `You can make a profit and still be short of cash — for example when customers haven't paid yet and ${ZL.term("AR", "receivables")} go up. This page starts from ${P ? "what you saved" : "the profit"} and explains every difference.`) + `
        <section class="card zr-sum"><div class="zr-eq">
          <div><span>Cash at start</span><b class="num">${M(cashOpen / 100, { symbol: true })}</b></div><i>${net >= 0 ? "+" : "−"}</i>
          <div><span>Net change</span><b class="num" style="color:${net >= 0 ? "var(--ar)" : "var(--ap)"}">${M(Math.abs(net) / 100, { symbol: true })}</b></div><i>=</i>
          <div><span>Cash at end</span><b class="num">${M((cashOpen + cashMove) / 100, { symbol: true })}</b></div></div>
          <p class="hint" style="margin:8px 0 0">${P ? "Everyday money" : "Trading"} ${did(tOps)} <b>${M(Math.abs(tOps) / 100, { symbol: true })}</b>;
            ${P ? "buying things that last" : "buying equipment and other assets"} ${did(tInv)} <b>${M(Math.abs(tInv) / 100, { symbol: true })}</b>;
            ${P ? "loans and savings moves" : "loans and owner money"} ${did(tFin)} <b>${M(Math.abs(tFin) / 100, { symbol: true })}</b>.</p></section>
        <div class="toolbar">${rangeControls(p, ctx.today)}</div>
        <section class="stmt">
          ${await letterhead("Statement of cash flows", `For ${when} · indirect method`)}
          <div class="tablewrap"><table><thead><tr><th></th><th class="r">RM</th></tr></thead><tbody>
            <tr class="ind"><td>${P ? "Saved in the period" : "Profit for the period"} <span class="hint">(from ${P ? "income & spending" : "profit & loss"})</span></td><td class="r num">${M(profit / 100)}</td></tr>
            ${block("Operating activities", P ? "everyday money in and out" : "cash from selling and running the business", ops, tOps, "Net cash from operating activities")}
            ${block("Investing activities", P ? "buying or selling things that last, like a car" : "buying or selling equipment, vehicles and other long-term assets", inv, tInv, "Net cash from investing activities")}
            ${block("Financing activities", P ? "loans taken or repaid, and long-term savings moves" : "loans taken or repaid, and money the owners put in or took out", fin, tFin, "Net cash from financing activities")}
            <tr class="tot"><td>Net change in cash</td><td class="r num">${M(net / 100)}</td></tr>
            <tr class="ind"><td>Cash and bank at ${ZL.date(p.from)}</td><td class="r num">${M(cashOpen / 100)}</td></tr>
            <tr class="tot soft"><td>Cash and bank at ${ZL.date(p.to)}</td><td class="r num">${M((cashOpen + cashMove) / 100)}</td></tr>
          </tbody></table></div>
          <div class="proofrow">${ok ? `<span class="ok">${TICK}Ties to the movement in your cash and bank accounts</span>`
            : `<span style="color:var(--bad);font-weight:500">Differs from the cash accounts by ${M((net - cashMove) / 100)} — check the trial balance</span>`}
            <span class="figs"><span>Cash accounts moved <b class="num">${M(cashMove / 100)}</b></span></span></div>
        </section>`;
    },
    after(root, ctx) {
      wireRange(root, "cf", ctx.params, ctx.today);
      wireCommon(root, "cf", ctx.params, ctx.today, ZL.modules.cf._csv);
    },
  });

  // ══ SST summary ═════════════════════════════════════════════════════════════
  ZL.register("sst", {
    title: "SST summary",
    perm: "report.view",
    business: true,
    async render(ctx) {
      const p = resolveRange(ctx.params, ctx.today, "lastmonth");
      const r = await ZL.rpc("sst_summary", { p_company: cid(), p_from: p.from, p_to: p.to });
      const out = r.by_code.filter((x) => x.side === "AR"), inp = r.by_code.filter((x) => x.side === "AP");
      const sum = (l, k) => l.reduce((s, x) => s + ZL.cents(x[k]), 0) / 100;
      const glOut = r.accounts.filter((a) => a.role === "OUTPUT"), glIn = r.accounts.filter((a) => a.role === "INPUT");
      const glOutT = sum(glOut, "movement"), glInT = sum(glIn, "movement");
      const docOut = sum(out, "tax"), docIn = sum(inp, "tax");
      const table = (list, side) => list.length ? `<table><thead><tr><th>Tax code</th><th class="r">Rate</th><th class="r">Documents</th><th class="r">Taxable value</th><th class="r">Tax</th></tr></thead><tbody>
          ${list.map((x) => `<tr><td><b>${E(x.code)}</b> <span class="hint">${E(x.name)}</span></td><td class="r num">${ZL.num(x.rate)}%</td><td class="r num">${x.documents}</td>
            <td class="r num">${M(x.taxable)}</td><td class="r num">${M(x.tax)}</td></tr>`).join("")}</tbody>
          <tfoot><tr><td colspan="3"><b>Total from ${side === "AR" ? "sales" : "purchase"} documents</b></td><td class="r num"><b>${M(sum(list, "taxable"))}</b></td><td class="r num"><b>${M(sum(list, "tax"))}</b></td></tr></tfoot></table>`
        : `<p class="nil" style="padding:14px 18px">No ${side === "AR" ? "sales" : "purchases"} with SST in this period.</p>`;
      const proof = (gl, docs, label) => {
        if (!gl.length) return "";
        const d = (ZL.cents(sum(gl, "movement")) - ZL.cents(docs)) / 100;
        return `<div class="proofrow"><span>${gl.map((a) => `${E(a.code)} ${E(a.name)} in the ledger: <b class="num">${M(a.movement)}</b>`).join(" · ")}</span>
          <span class="figs">${ZL.cents(d) === 0 ? `<span class="ok">${TICK}Matches the ${label} documents</span>` : `<span>Entered outside documents (cash book or journals) <b class="num">${M(d)}</b></span>`}</span></div>`;
      };
      Object.assign(ctx.params, { preset: p.preset, from: p.from, to: p.to });
      const due = ZL.monthEnd(shiftMonths(ZL.monthStart(p.to), 1));
      this._csv = { name: `sst-${p.from}-to-${p.to}.csv`, rows: [["SST summary", `${p.from} to ${p.to}`], [], ["Side", "Code", "Rate", "Documents", "Taxable", "Tax"]]
        .concat(r.by_code.map((x) => [x.side === "AR" ? "Output (sales)" : "Input (purchases)", x.code, x.rate, x.documents, ZL.num(x.taxable).toFixed(2), ZL.num(x.tax).toFixed(2)]))
        .concat([[], ["Output tax in the ledger", "", "", "", "", glOutT.toFixed(2)], ["Input tax in the ledger", "", "", "", "", glInT.toFixed(2)]]) };
      return ZL.header("SST summary", "Sales and service tax for the period — the figures for your SST-02 return.", btn("zl-rprint", "Print", "ghost") + exportButton()) +
        ZL.tip("sst", "What goes on the SST-02", `Declare the <b>output tax</b> you charged customers for each taxable period (usually two months) and pay it by the end of the following month. Input tax on purchases is shown for reference; most businesses can't claim it back. ${ZL.term("sst", "More about SST")}`) + `
        <section class="card zr-sum"><div class="zr-eq">
          <div><span>Output tax (you charged)</span><b class="num" style="color:var(--ar)">${M(glOut.length ? glOutT : docOut, { symbol: true })}</b></div>
          <div><span>Input tax (you were charged)</span><b class="num" style="color:var(--ap)">${M(glIn.length ? glInT : docIn, { symbol: true })}</b></div>
          <div><span>Pay Customs by</span><b>${ZL.date(due)}</b></div></div></section>
        <div class="toolbar">${rangeControls(p, ctx.today)}</div>
        <h3 style="font-size:14px;margin:6px 0 8px;display:flex;gap:8px;align-items:center">${ZL.sideTag("AR")} Output tax on sales</h3>
        <section class="card"><div class="tablewrap">${table(out, "AR")}</div>${proof(glOut, docOut, "sales")}</section>
        <h3 style="font-size:14px;margin:18px 0 8px;display:flex;gap:8px;align-items:center">${ZL.sideTag("AP")} Input tax on purchases</h3>
        <section class="card"><div class="tablewrap">${table(inp, "AP")}</div>${proof(glIn, docIn, "purchase")}</section>`;
    },
    after(root, ctx) {
      wireRange(root, "sst", ctx.params, ctx.today);
      wireCommon(root, "sst", ctx.params, ctx.today, ZL.modules.sst._csv);
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
