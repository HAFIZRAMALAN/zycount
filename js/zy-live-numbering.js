/* ═══════════════════════════════════════════════════════════════════════════
 * Zycount live workspace — numbering.
 * Every set of books has numbering series for payment vouchers (PV), receipts
 * (OR) and journals (JV). Each series is automatic, automatic-but-editable or
 * manual; formats use {YYYY} {YY} {MM} and one running number {####}. The
 * database assigns and checks every number (see document_numbering migration);
 * this file shows the series, edits them and puts the number field on forms.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const ZL = window.ZL;
  const E = ZL.esc;
  const cid = () => ZL.company.company_id;

  const KIND_OF = { IN: "RECEIPT", OUT: "PAYMENT", JOURNAL: "JOURNAL" };
  const KIND_LABEL = () => ({
    PAYMENT: ZL.T("Payment vouchers", "Money out"), RECEIPT: ZL.T("Official receipts", "Money in"), JOURNAL: "Journals",
    QUOTATION: "Quotations", INVOICE: "Sales invoices", CASH_SALE: "Cash sales", DEBIT_NOTE: "Debit notes", CREDIT_NOTE: "Credit notes",
    PURCHASE_ORDER: "Purchase orders", BILL: "Purchase invoices", CASH_PURCHASE: "Cash purchases", SUPPLIER_DN: "Supplier debit notes", SUPPLIER_CN: "Supplier credit notes",
    CONTRA: "Contras",
  });
  const SALES_KINDS = ["QUOTATION", "INVOICE", "CASH_SALE", "DEBIT_NOTE", "CREDIT_NOTE"];
  const PURCHASE_KINDS = ["PURCHASE_ORDER", "BILL", "CASH_PURCHASE", "SUPPLIER_DN", "SUPPLIER_CN"];
  const kindsFor = () => ["PAYMENT", "RECEIPT", "JOURNAL"].concat(ZL.isPersonal() ? [] : SALES_KINDS.concat(PURCHASE_KINDS, ["CONTRA"]));
  const moneyKind = (k) => k === "PAYMENT" || k === "RECEIPT";
  const MODE_LABEL = { AUTO: "Automatic only", AUTO_EDITABLE: "Automatic, or key your own", MANUAL: "Keyed by hand" };
  const RESET_LABEL = { YEARLY: "Every year", MONTHLY: "Every month", NEVER: "Never" };
  const isMoney = (a) => a.is_postable && a.is_active && (a.is_cash || (ZL.isPersonal() && a.type === "LIABILITY" && a.sub_type === "CURRENT_LIABILITY"));

  /** The number a format gives on a date — mirrors _format_number in SQL. */
  const formatNumber = (fmt, iso, n) => {
    const d = iso || ZL.today();
    const m = String(fmt || "").match(/\{(#+)\}/);
    const w = m ? m[1].length : 0;
    return String(fmt || "").replace(/\{YYYY\}/g, d.slice(0, 4)).replace(/\{YY\}/g, d.slice(2, 4))
      .replace(/\{MM\}/g, d.slice(5, 7)).replace(/\{#+\}/, String(n).padStart(Math.max(w, String(n).length), "0"));
  };

  ZL.numbering = {
    KIND_OF,
    formatNumber,
    /** Series with the next numbers for a date. Always fresh: numbers move. */
    load: (date) => ZL.rpc("document_series_overview", { p_company: cid(), p_date: date || ZL.today() }),
    /** The series the database would choose: linked to the account, else the default. */
    pick(rows, kind, moneyAccount, seriesId) {
      const live = rows.filter((r) => r.kind === kind && r.is_active);
      return live.find((r) => seriesId && r.id === seriesId) || live.find((r) => moneyAccount && r.money_account_id === moneyAccount)
        || live.find((r) => r.is_default) || live[0] || null;
    },
    /** Form fields (for ZL.form) — a series choice and the number. Empty when numbering is off.
     *  preset: { series, no } — a series and number already chosen (e.g. on a saved draft). */
    fields(rows, kind, moneyAccount, preset = {}) {
      const live = rows.filter((r) => r.kind === kind && r.is_active);
      if (!live.length) return [];
      const s = this.pick(rows, kind, moneyAccount, preset.series);
      return [
        { name: "series", label: "Numbering", type: "select", half: true, value: s.id,
          options: live.map((r) => ({ value: r.id, label: `${r.name} (${r.code})` })) },
        { name: "doc_no", label: `${s.code} no.`, half: true, value: preset.no || (s.mode === "MANUAL" ? "" : s.next_preview) },
      ];
    },
    /**
     * Keeps the number field in step with the series, bank account and date.
     * opts: { money?: () => accountId, moneyInput?, dateInput?, autoHint?, initial?: number keyed earlier, series?: chosen series id }
     * Returns { read() } → { p_series, p_doc_no } (throws when a manual number is missing).
     */
    wire(root, rows, kind, opts = {}) {
      const sel = root.querySelector('[name="series"]');
      const inp = root.querySelector('[name="doc_no"]');
      if (!sel || !inp) return { read: () => ({}) };
      let list = rows, typed = !!opts.initial, chosen = !!opts.series;
      if (opts.initial) inp.value = opts.initial;
      const label = inp.closest("label");
      let hint = label.querySelector("small");
      if (!hint) { hint = document.createElement("small"); label.appendChild(hint); }
      const current = () => list.find((r) => r.id === sel.value) || this.pick(list, kind, opts.money && opts.money());
      const apply = () => {
        const s = current();
        if (!s) return;
        const live = list.filter((r) => r.kind === kind && r.is_active);
        sel.closest("label").hidden = live.length < 2;
        label.classList.toggle("half", live.length >= 2);
        label.querySelector("span").innerHTML = `${E(s.code)} no.${s.mode === "MANUAL" ? ' <i aria-hidden="true">*</i>' : ""}`;
        inp.readOnly = s.mode === "AUTO";
        inp.classList.toggle("zl-auto", s.mode === "AUTO");
        if (s.mode === "AUTO") { inp.value = s.next_preview; hint.textContent = opts.autoHint || "Given automatically when you save."; }
        else if (s.mode === "AUTO_EDITABLE") { if (!typed) inp.value = s.next_preview; hint.textContent = "Next number shown — or type your own."; }
        else { if (!typed) inp.value = ""; inp.placeholder = "Key in the number"; hint.textContent = "This series is numbered by hand."; }
      };
      sel.addEventListener("change", () => { chosen = true; typed = false; apply(); });
      inp.addEventListener("input", () => { typed = true; });
      if (opts.moneyInput) opts.moneyInput.addEventListener("change", () => {
        if (chosen) return;
        const s = this.pick(list, kind, opts.money());
        if (s && s.id !== sel.value) { sel.value = s.id; typed = false; apply(); }
      });
      if (opts.dateInput) opts.dateInput.addEventListener("change", ZL.debounce(async () => {
        const d = opts.dateInput.value;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
        try { list = await this.load(d); apply(); } catch (_) { /* keep the last preview */ }
      }, 300));
      apply();
      return {
        read() {
          const s = current();
          if (!s) return {};
          const v = inp.value.trim();
          if (s.mode === "AUTO") return { p_series: s.id, p_doc_no: null };
          if (s.mode === "AUTO_EDITABLE") return { p_series: s.id, p_doc_no: v && v !== s.next_preview ? v : null };
          if (!v) throw new ZL.ZLError("VALIDATION", `Enter the ${s.code} number.`);
          return { p_series: s.id, p_doc_no: v };
        },
      };
    },
  };

  // ── Series editor ─────────────────────────────────────────────────────────
  async function editSeries(row, kindForNew) {
    const isNew = !row;
    const accounts = (await ZL.accounts()).filter(isMoney);
    const P = ZL.isPersonal();
    const r = row || { kind: kindForNew || "PAYMENT", code: "", name: "", title: "", format: "", reset: "YEARLY", mode: "AUTO_EDITABLE",
      money_account_id: null, is_default: false, is_active: true, next_number: 1, used: 0 };
    const kindSel = (k) => `<option value="${k}"${r.kind === k ? " selected" : ""}>${E(KIND_LABEL()[k])}</option>`;
    const radio = (m, desc) => `<label class="zl-check"><input type="radio" name="mode" value="${m}"${r.mode === m ? " checked" : ""}>
      <span>${MODE_LABEL[m]}<small>${desc}</small></span></label>`;
    const body = `<div class="zl-form" id="zl-sform">
        ${isNew ? `<label class="zl-field half"><span>Numbers</span><select class="zl-input" name="kind">${kindsFor().map(kindSel).join("")}</select></label>
          <label class="zl-field half"><span>Code <i>*</i></span><input class="zl-input" name="code" maxlength="10" placeholder="e.g. CV" value="${E(r.code)}" autocomplete="off"></label>` : ""}
        <label class="zl-field half"><span>Name <i>*</i></span><input class="zl-input" name="name" maxlength="60" value="${E(r.name)}" placeholder="e.g. Cash voucher"></label>
        <label class="zl-field half" data-money-only="title"><span>Printed title</span><input class="zl-input" name="title" maxlength="60" value="${E(r.title || "")}" placeholder="Uses the template title"></label>
        <label class="zl-field"><span>Format <i>*</i></span><input class="zl-input mono" name="format" maxlength="40" value="${E(r.format)}" placeholder="e.g. CV/{YY}/{####}" autocomplete="off">
          <span class="zl-tokens">${["{YYYY}", "{YY}", "{MM}", "{####}", "{######}", "-", "/"].map((t) => `<button type="button" class="zl-btn sm ghost" data-token="${t}">${t}</button>`).join("")}</span>
          <small>{YYYY} year · {YY} short year · {MM} month · {####} running number (3 to 10 #)</small></label>
        <label class="zl-field half"><span>Restarts</span><select class="zl-input" name="reset"${!isNew && r.used ? " disabled" : ""}>
          ${Object.entries(RESET_LABEL).map(([k, v]) => `<option value="${k}"${r.reset === k ? " selected" : ""}>${v}</option>`).join("")}</select>
          ${!isNew && r.used ? "<small>Fixed once the series is in use.</small>" : ""}</label>
        <label class="zl-field half"><span>Next number</span><input class="zl-input num" type="number" name="next" min="1" max="99999999" step="1" value="${E(r.next_number || 1)}"></label>
        <div class="zl-field"><span>Numbering</span>
          ${radio("AUTO_EDITABLE", "Zycount fills in the next number; anyone can type their own instead. Recommended.")}
          ${radio("AUTO", "Zycount gives every number, in order — nobody can type one.")}
          ${radio("MANUAL", "You key every number, e.g. from a printed voucher book. Zycount checks it isn't used twice.")}</div>
        <label class="zl-field" data-money-only><span>Use automatically for</span><select class="zl-input" name="money">
          <option value="">Any bank or cash account</option>${accounts.map((a) => `<option value="${a.id}"${a.id === r.money_account_id ? " selected" : ""}>${E(a.name)} · ${E(a.code)}</option>`).join("")}</select>
          <small>Link a bank, cash or card account and this series is picked whenever money moves through it.</small></label>
        <label class="zl-check"><input type="checkbox" name="default"${r.is_default ? " checked disabled" : ""}><span>Default for <span data-kind-word></span><small>${r.is_default ? "To change it, make another series the default." : "Used when no series is linked to the account."}</small></span></label>
        <label class="zl-check"><input type="checkbox" name="active"${r.is_active ? " checked" : ""}${r.is_default ? " disabled" : ""}><span>Active<small>Inactive series keep their numbers but can't be chosen.</small></span></label>
        <div class="zl-banner info" id="zl-sprev" style="grid-column:1/-1"></div>
      </div>`;
    const actions = [{ label: "Cancel" }];
    if (!isNew && !r.used && !r.is_default) actions.unshift({ label: "Remove", danger: true, onClick: async ({ close }) => {
      if (!(await ZL.confirm({ title: `Remove ${r.name}?`, message: "It has never been used, so no entry changes.", confirmLabel: "Remove", danger: true }))) return;
      await ZL.rpc("delete_document_series", { p_id: r.id });
      close(); ZL.toast("Series removed."); ZL.refresh();
    } });
    let m;
    const val = (n) => { const el = m.root.querySelector(`[name="${n}"]`); return el ? el.value.trim() : ""; };
    const kindNow = () => (isNew ? val("kind") : r.kind);
    const modeNow = () => (m.root.querySelector('[name="mode"]:checked') || {}).value || "AUTO_EDITABLE";
    actions.push({ label: isNew ? "Add series" : "Save", primary: true, onClick: async ({ close }) => {
      const next = Number(val("next"));
      if (!Number.isInteger(next) || next < 1) throw new ZL.ZLError("VALIDATION", "The next number is a whole number from 1.");
      await ZL.rpc("save_document_series", {
        p_company: cid(), p_id: isNew ? null : r.id, p_kind: kindNow(), p_code: isNew ? val("code").toUpperCase() : r.code,
        p_name: val("name"), p_title: kindNow() === "JOURNAL" ? null : val("title") || null, p_format: val("format"),
        p_reset: m.root.querySelector('[name="reset"]').value, p_mode: modeNow(),
        p_money_account: moneyKind(kindNow()) ? val("money") || null : null,
        p_is_default: m.root.querySelector('[name="default"]').checked, p_is_active: m.root.querySelector('[name="active"]').checked,
        p_next_number: isNew || next !== Number(r.next_number) ? next : null,
      });
      close();
      ZL.toast(isNew ? "Series added." : "Series saved.");
      ZL.refresh();
    } });
    m = ZL.modal({ title: isNew ? "Add a numbering series" : `${r.name} (${r.code})`, wide: true, body, actions });
    const draw = () => {
      const k = kindNow();
      m.root.querySelectorAll("[data-money-only]").forEach((el) => { el.hidden = !moneyKind(k) && !(el.dataset.moneyOnly === "title" && k !== "JOURNAL"); });
      m.root.querySelector("[data-kind-word]").textContent = { PAYMENT: P ? "money out" : "payments", RECEIPT: P ? "money in" : "receipts", JOURNAL: "journals" }[k] || KIND_LABEL()[k].toLowerCase();
      const fmt = val("format"), n = Math.max(1, Number(val("next")) || 1);
      const ok = /\{#{3,10}\}/.test(fmt);
      const note = k === "JOURNAL" && modeNow() !== "AUTO"
        ? " Money in and out, opening balances and reversals still take the next automatic number." : "";
      m.root.querySelector("#zl-sprev").innerHTML = ok
        ? `Next: <b class="mono">${E(formatNumber(fmt, ZL.today(), n))}</b>, then <span class="mono">${E(formatNumber(fmt, ZL.today(), n + 1))}</span>.${modeNow() === "MANUAL" ? " (Shown for reference — this series is keyed by hand.)" : ""}${E(note)}`
        : "Add a running number such as {####} to see the next number.";
    };
    const fmtInput = m.root.querySelector('[name="format"]');
    m.root.querySelectorAll("[data-token]").forEach((b) => b.addEventListener("click", () => {
      const t = b.dataset.token, s = fmtInput.selectionStart ?? fmtInput.value.length, e = fmtInput.selectionEnd ?? s;
      fmtInput.value = (fmtInput.value.slice(0, s) + t + fmtInput.value.slice(e)).slice(0, 40);
      fmtInput.focus(); fmtInput.setSelectionRange(s + t.length, s + t.length); draw();
    }));
    const code = m.root.querySelector('[name="code"]');
    if (code) code.addEventListener("input", () => {
      code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!fmtInput.dataset.touched) fmtInput.value = code.value ? `${code.value}-{YYYY}-{######}` : "";
      draw();
    });
    fmtInput.addEventListener("input", () => { fmtInput.dataset.touched = "1"; });
    m.root.addEventListener("input", draw);
    m.root.addEventListener("change", draw);
    draw();
  }

  // ── Page ──────────────────────────────────────────────────────────────────
  ZL.register("numbering", {
    title: "Numbering",
    perm: "company.view",
    async render() {
      const [rows, accounts] = await Promise.all([ZL.numbering.load(ZL.today()), ZL.accounts()]);
      const acc = new Map(accounts.map((a) => [a.id, a]));
      const edit = ZL.can("company.edit");
      const section = (kind, title, kinds) => {
        const list = rows.filter((r) => (kinds || [kind]).includes(r.kind));
        return `<section class="card" style="margin-bottom:16px">
          <div class="zl-sec-h"><h3>${E(title || KIND_LABEL()[kind])}</h3>${edit ? `<button type="button" class="zl-btn sm ghost" data-snew="${kind}">+ Add series</button>` : ""}</div>
          <div class="tablewrap"><table>
          <thead><tr><th>Series</th><th>Next number</th><th>Restarts</th><th>Numbering</th>${moneyKind(kind) ? "<th>Used for</th>" : ""}<th class="r">Used</th><th></th></tr></thead>
          <tbody>${list.map((r) => { const a = acc.get(r.money_account_id); return `<tr${r.is_active ? "" : ' style="opacity:.6"'}>
            <td><div style="font-weight:500">${E(r.name)} <span class="code">${E(r.code)}</span>${kinds ? ` <span class="hint">${E(KIND_LABEL()[r.kind])}</span>` : ""}${r.is_default ? ' <span class="chip ok">Default</span>' : ""}${r.is_active ? "" : ' <span class="chip">Inactive</span>'}</div>
              <div class="hint mono">${E(r.format)}</div></td>
            <td class="mono" style="white-space:nowrap">${r.mode === "MANUAL" ? '<span class="nil">—</span>' : E(r.next_preview)}</td>
            <td class="nil">${RESET_LABEL[r.reset]}</td>
            <td>${MODE_LABEL[r.mode]}</td>
            ${moneyKind(kind) ? `<td class="nil">${a ? `${E(a.name)} <span class="code">${E(a.code)}</span>` : "Any account"}</td>` : ""}
            <td class="r num">${r.used}</td>
            <td class="r">${edit ? `<button type="button" class="zl-btn sm" data-sedit="${r.id}">Edit</button>` : ""}</td></tr>`; }).join("")
            || `<tr><td colspan="7" class="nil">No series — these entries get no number.</td></tr>`}</tbody></table></div></section>`;
      };
      return ZL.header("Numbering", ZL.T("Choose how invoices, notes, vouchers, receipts and journals are numbered — automatically or keyed by hand.", "Choose how vouchers, receipts and journals are numbered — automatically or keyed by hand.")) +
        section("PAYMENT") + section("RECEIPT") +
        (ZL.isPersonal() ? "" : section("INVOICE", "Sales documents", SALES_KINDS) + section("BILL", "Purchase documents", PURCHASE_KINDS) + section("CONTRA")) + section("JOURNAL") +
        `<p class="hint">Automatic numbers never skip or repeat, and every number is checked for duplicates. Account codes are changed in <button type="button" class="zl-ref" id="zl-to-coa">${ZL.T("Chart of accounts", "Accounts & categories")}</button>.</p>`;
    },
    after(root) {
      root.querySelectorAll("[data-snew]").forEach((b) => b.addEventListener("click", () => editSeries(null, b.dataset.snew)));
      root.querySelectorAll("[data-sedit]").forEach((b) => b.addEventListener("click", async () => {
        const rows = await ZL.numbering.load(ZL.today());
        editSeries(rows.find((r) => r.id === b.dataset.sedit));
      }));
      const coa = root.querySelector("#zl-to-coa");
      if (coa) coa.addEventListener("click", () => go("coa"));
    },
  });

  const css = document.createElement("style");
  css.textContent = `
  .zl-sec-h{display:flex;align-items:center;justify-content:space-between;padding:14px 18px 6px}
  .zl-sec-h h3{margin:0;font-size:15px}
  .zl-tokens{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
  .zl-tokens .zl-btn{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;padding:3px 8px}
  .zl-input.zl-auto{background:var(--sunk);color:var(--ink-2)}
  `;
  document.head.appendChild(css);
})();
