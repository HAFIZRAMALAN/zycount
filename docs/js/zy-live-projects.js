/* ═══════════════════════════════════════════════════════════════════════════
 * Zycount live workspace — projects (Phase 3.5).
 *
 * A project is a tag on lines: a sales or purchase document names one for all
 * its lines, a manual journal per line. Nothing about the double entry changes;
 * the profit and loss can then be read per project (project_pl). A closed
 * project takes no new postings (phase3_5_projects migration).
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const ZL = window.ZL;
  const E = ZL.esc;
  const M = ZL.money;
  const cid = () => ZL.company.company_id;

  /** The books' projects, active first. */
  ZL.projects = () => ZL.select("projects", "id,code,name,status,contact_id,start_date,end_date,notes",
    (q) => q.eq("company_id", cid()).order("status").order("code"));

  async function editProject(p) {
    const customers = await ZL.select("contacts", "id,name,code,is_active", (q) => q.eq("company_id", cid()).eq("kind", "CUSTOMER").order("name"));
    const r = await ZL.form({ title: p ? `Edit ${p.code}` : "New project", confirmLabel: p ? "Save" : "Add project", wide: true,
      intro: "Tag sales, purchases and journals with a project to see its own profit and loss. Closing a project stops new postings to it; what's already posted stays.",
      fields: [
        { name: "code", label: "Code", required: true, half: true, value: (p && p.code) || "", placeholder: "e.g. RENO-01" },
        { name: "name", label: "Name", required: true, half: true, value: (p && p.name) || "", placeholder: "e.g. Renovation, Jalan Ampang" },
        { name: "contact_id", label: "Customer (optional)", type: "select", half: true, value: (p && p.contact_id) || "",
          options: [{ value: "", label: "None" }].concat(customers.filter((c) => c.is_active || (p && c.id === p.contact_id)).map((c) => ({ value: c.id, label: `${c.name} · ${c.code}` }))) },
        { name: "status", label: "Status", type: "select", half: true, value: (p && p.status) || "ACTIVE",
          options: [{ value: "ACTIVE", label: "Active — can be posted to" }, { value: "CLOSED", label: "Closed — no new postings" }] },
        { name: "start_date", label: "Start", type: "date", half: true, value: (p && p.start_date) || "" },
        { name: "end_date", label: "End", type: "date", half: true, value: (p && p.end_date) || "" },
        { name: "notes", label: "Notes", type: "textarea", value: (p && p.notes) || "" },
      ],
      submit: (v) => ZL.rpc("save_project", { p_company: cid(), p_id: p ? p.id : null, p_data: v }) });
    if (r) { ZL.toast(`Project ${r.code} saved.`); ZL.refresh(); }
  }

  // ── Projects list ─────────────────────────────────────────────────────────
  ZL.register("projects", {
    title: "Projects",
    perm: "journal.view",
    business: true,
    async render(ctx) {
      const [projs, pl] = await Promise.all([ZL.projects(),
        ZL.can("report.view") ? ZL.rpc("project_pl", { p_company: cid() }).catch(() => []) : Promise.resolve([])]);
      ctx.projs = projs;
      const tot = new Map();
      pl.forEach((r) => {
        const k = r.project_id || "";
        const t = tot.get(k) || { rev: 0, exp: 0 };
        if (r.type === "REVENUE") t.rev += ZL.cents(r.amount); else t.exp += ZL.cents(r.amount);
        tot.set(k, t);
      });
      const canEdit = ZL.can("journal.create");
      const actions = `<div class="zl-actions" style="display:flex;gap:8px;flex-wrap:wrap">
          ${canEdit ? `<button type="button" class="zl-btn primary" id="zl-pjadd">New project</button>` : ""}
          ${ZL.can("report.view") ? `<button type="button" class="zl-btn" onclick="ZL.open('projectpl')">P&amp;L by project</button>` : ""}</div>`;
      const row = (p) => { const t = tot.get(p.id) || { rev: 0, exp: 0 };
        return `<tr class="click" data-pj="${p.id}"${p.status === "ACTIVE" ? "" : ' style="opacity:.65"'}>
          <td class="mono">${E(p.code)}</td><td>${E(p.name)}</td>
          <td>${p.status === "ACTIVE" ? "Active" : '<span class="hint">Closed</span>'}</td>
          <td class="nil">${p.start_date ? E(ZL.date(p.start_date)) : ""}${p.end_date ? ` – ${E(ZL.date(p.end_date))}` : ""}</td>
          <td class="r num">${M(t.rev / 100)}</td><td class="r num">${M(t.exp / 100)}</td>
          <td class="r num"${t.rev - t.exp < 0 ? ' style="color:var(--bad)"' : ""}><b>${M((t.rev - t.exp) / 100)}</b></td></tr>`; };
      return ZL.header("Projects", "Jobs, contracts or sites you want to see the profit of. Choose the project on a sales or purchase document, or on a journal line.", actions) +
        (projs.length ? `<section class="card"><div class="tablewrap"><table>
          <thead><tr><th>Code</th><th>Project</th><th>Status</th><th>Dates</th><th class="r">Income</th><th class="r">Costs</th><th class="r">Profit</th></tr></thead>
          <tbody>${projs.map(row).join("")}</tbody></table></div></section>
          <p class="hint" style="margin-top:8px">All time, from posted entries. Click a project to edit or close it.</p>`
          : ZL.empty("No projects yet", "Add a project, then pick it on your invoices, bills and journals. Its own profit and loss shows here and under Reports.",
              canEdit ? `<button type="button" class="zl-btn" id="zl-pjadd2">New project</button>` : ""));
    },
    after(root, ctx) {
      ["#zl-pjadd", "#zl-pjadd2"].forEach((s) => { const b = root.querySelector(s); if (b) b.addEventListener("click", () => editProject(null)); });
      root.querySelectorAll("[data-pj]").forEach((tr) => tr.addEventListener("click", () => {
        const p = ctx.projs.find((x) => x.id === tr.dataset.pj);
        if (ZL.can("journal.create")) editProject(p); else ZL.open("projectpl", { project: p.id });
      }));
    },
  });

  // ── Profit and loss by project ────────────────────────────────────────────
  ZL.register("projectpl", {
    title: "P&L by project",
    perm: "report.view",
    business: true,
    async render(ctx) {
      const p = ctx.params || {};
      const from = p.from || `${ZL.today().slice(0, 4)}-01-01`, to = p.to || ZL.today();
      const [projs, rows] = await Promise.all([ZL.projects(), ZL.rpc("project_pl", { p_company: cid(), p_from: from, p_to: to })]);
      // Columns: each project with something in the dates (in code order), then "Not in a project", then the total.
      const used = new Set(rows.map((r) => r.project_id || ""));
      const cols = projs.filter((x) => used.has(x.id)).map((x) => ({ id: x.id, label: x.code, title: x.name }));
      if (used.has("")) cols.push({ id: "", label: "No project", title: "Lines not tagged with a project" });
      const accs = new Map();
      rows.forEach((r) => {
        const a = accs.get(r.account_id) || { code: r.code, name: r.name, type: r.type, by: new Map() };
        a.by.set(r.project_id || "", (a.by.get(r.project_id || "") || 0) + ZL.cents(r.amount));
        accs.set(r.account_id, a);
      });
      const list = [...accs.values()].sort((a, b) => a.code.localeCompare(b.code));
      const rev = list.filter((a) => a.type === "REVENUE"), exp = list.filter((a) => a.type !== "REVENUE");  // cost of sales and expenses
      const sum = (as, k) => as.reduce((s, a) => s + (k == null ? [...a.by.values()].reduce((x, y) => x + y, 0) : (a.by.get(k) || 0)), 0);
      const cell = (sen, strong) => `<td class="r num"${sen < 0 && strong ? ' style="color:var(--bad)"' : ""}>${strong ? "<b>" : ""}${sen ? M(sen / 100) : '<span class="nil">–</span>'}${strong ? "</b>" : ""}</td>`;
      const accRow = (a) => `<tr><td><span class="mono">${E(a.code)}</span> ${E(a.name)}</td>${cols.map((c) => cell(a.by.get(c.id) || 0)).join("")}${cell(sum([a]))}</tr>`;
      const totRow = (label, as, cls = "") => `<tr class="${cls}"><td><b>${label}</b></td>${cols.map((c) => cell(sum(as, c.id), true)).join("")}${cell(sum(as), true)}</tr>`;
      const net = `<tr class="grand"><td>Net profit</td>${cols.map((c) => cell(sum(rev, c.id) - sum(exp, c.id), true)).join("")}${cell(sum(rev) - sum(exp), true)}</tr>`;
      ctx.csv = [["Account"].concat(cols.map((c) => c.label), ["Total"])]
        .concat(list.map((a) => [`${a.code} ${a.name}`].concat(cols.map((c) => (a.by.get(c.id) || 0) / 100), [sum([a]) / 100])))
        .concat([["Net profit"].concat(cols.map((c) => (sum(rev, c.id) - sum(exp, c.id)) / 100), [(sum(rev) - sum(exp)) / 100])]);
      return ZL.header("P&L by project", "Income and costs per project. The columns add up to your whole profit and loss for the dates.",
          `<button type="button" class="zl-btn ghost" onclick="ZL.open('projects')">Projects</button>`) +
        `<div class="zl-toolbar" style="display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin-bottom:12px">
          <label class="zl-field"><span>From</span><input class="zl-input" type="date" id="zl-ppf" value="${E(from)}"></label>
          <label class="zl-field"><span>To</span><input class="zl-input" type="date" id="zl-ppt" value="${E(to)}"></label>
          <button type="button" class="zl-btn" id="zl-ppgo">Show</button>
          <button type="button" class="zl-btn sm ghost" id="zl-ppcsv" style="margin-left:auto">Export CSV</button></div>` +
        (list.length ? `<section class="card"><div class="tablewrap"><table>
          <thead><tr><th>Account</th>${cols.map((c) => `<th class="r" title="${E(c.title)}">${E(c.label)}</th>`).join("")}<th class="r">Total</th></tr></thead>
          <tbody>${rev.length ? `<tr><td colspan="${cols.length + 2}" class="hint">Income</td></tr>${rev.map(accRow).join("")}${totRow("Total income", rev)}` : ""}
            ${exp.length ? `<tr><td colspan="${cols.length + 2}" class="hint">Costs and expenses</td></tr>${exp.map(accRow).join("")}${totRow("Total costs", exp)}` : ""}</tbody>
          <tfoot>${net}</tfoot></table></div></section>`
          : ZL.empty("Nothing posted in these dates", "Change the dates, or tag invoices, bills and journals with a project."));
    },
    after(root, ctx) {
      root.querySelector("#zl-ppgo").addEventListener("click", () =>
        ZL.open("projectpl", { from: root.querySelector("#zl-ppf").value || null, to: root.querySelector("#zl-ppt").value || null }));
      root.querySelector("#zl-ppcsv").addEventListener("click", () => ZL.csv(`pl-by-project-${ZL.today()}.csv`, ctx.csv || []));
    },
  });
})();
