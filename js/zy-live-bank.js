/* ═══════════════════════════════════════════════════════════════════════════
 * Zycount live workspace — bank reconciliation.
 * Upload the bank's CSV or Excel export; each line is paired in the database
 * with the payment voucher or receipt already recorded (same account, same
 * amount, within 7 days — a PV/OR number in the bank text wins). What is left
 * can be recorded, matched by hand or ignored, and the page proves the bank
 * balance against the books.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const ZL = window.ZL;
  const E = ZL.esc;
  const M = ZL.money;
  const cid = () => ZL.company.company_id;
  const btn = (id, label, cls = "") => `<button type="button" class="zl-btn ${cls}" id="${id}">${label}</button>`;
  const isMoney = (a) => a.is_postable && a.is_active && (a.is_cash || (ZL.isPersonal() && a.type === "LIABILITY" && a.sub_type === "CURRENT_LIABILITY"));

  // ── Reading the file ──────────────────────────────────────────────────────
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    mac: 3, mei: 5, ogo: 8, okt: 10, dis: 12 };
  const iso = (y, m, d) => {
    if (y < 100) y += 2000;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  /** A date cell → YYYY-MM-DD, or null. order is "DMY" (Malaysian banks) or "MDY". */
  function parseDate(v, order) {
    if (v == null || v === "") return null;
    if (typeof v === "number" && window.XLSX) {
      if (v < 20000 || v > 80000) return null; // Excel serial date range 1954–2119
      const c = XLSX.SSF.parse_date_code(v);
      return c ? iso(c.y, c.m, c.d) : null;
    }
    const s = String(v).trim();
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return iso(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
    if (m) return order === "MDY" ? iso(+m[3], +m[1], +m[2]) : iso(+m[3], +m[2], +m[1]);
    m = s.match(/^(\d{1,2})[\s-]*([A-Za-z]{3})[A-Za-z]*[\s-,]*(\d{2,4})\b/);
    if (m && MONTHS[m[2].toLowerCase()]) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
    m = s.match(/^([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2}),?\s+(\d{4})/);
    if (m && MONTHS[m[1].toLowerCase()]) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
    return null;
  }
  /** "1,060.00", "(250.00)", "250.00-", "RM 9.50 DR" → signed number; blank → null; junk → NaN. */
  function parseAmt(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return v;
    let s = String(v).trim().replace(/\s+/g, " ");
    if (!s) return null;
    let sign = 1;
    if (/\bDR\.?$/i.test(s)) { sign = -1; s = s.replace(/\bDR\.?$/i, ""); } else if (/\bCR\.?$/i.test(s)) s = s.replace(/\bCR\.?$/i, "");
    if (/^\(.*\)$/.test(s)) { sign = -sign; s = s.slice(1, -1); }
    s = s.replace(/^RM/i, "").replace(/[\s,]/g, "");
    if (/-$/.test(s)) { sign = -sign; s = s.slice(0, -1); } else if (/\+$/.test(s)) s = s.slice(0, -1);
    if (/^-/.test(s)) { sign = -sign; s = s.slice(1); } else if (/^\+/.test(s)) s = s.slice(1);
    if (s === "" || s === "-") return null;
    return /^\d*\.?\d+$/.test(s) ? sign * Math.round(Number(s) * 100) / 100 : NaN;
  }

  async function readFile(file) {
    await ZL.lib("xlsx");
    const name = file.name.toLowerCase();
    let wb;
    if (/\.(csv|txt)$/.test(name)) wb = XLSX.read(await file.text(), { type: "string", raw: true });
    else if (/\.(xlsx|xls)$/.test(name)) wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array" });
    else throw new ZL.ZLError("VALIDATION", "Use a CSV or Excel (.xlsx, .xls) file from your bank.");
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "", blankrows: false })
      .map((r) => r.map((c) => (typeof c === "string" ? c.trim() : c)));
    if (!rows.length) throw new ZL.ZLError("VALIDATION", "That file is empty.");
    return rows.slice(0, 6000);
  }

  const GUESS = {
    date: /^(txn |transaction |posting |value )?date|tarikh/i,
    description: /desc|particular|narrat|detail|keterangan|transaction$|remark/i,
    reference: /ref|cheque|chq|no\.?$/i,
    out: /withdraw|debit|^dr$|money out|pengeluaran|payment/i,
    in: /deposit|credit|^cr$|money in|simpanan|receipt/i,
    amount: /amount|amaun|^amt/i,
    balance: /balance|baki/i,
  };
  function guessMapping(rows) {
    // The header is the first row that names a date column.
    let h = rows.findIndex((r, i) => i < 40 && r.some((c) => typeof c === "string" && GUESS.date.test(c)) && r.filter((c) => c !== "").length >= 3);
    if (h < 0) h = 0;
    const head = rows[h].map((c) => String(c || ""));
    const find = (re, not = []) => head.findIndex((c, i) => c && re.test(c) && !not.includes(i));
    const date = find(GUESS.date);
    const balance = find(GUESS.balance);
    const out = find(GUESS.out, [balance]);
    const inn = find(GUESS.in, [balance, out]);
    const amount = find(GUESS.amount, [balance, out, inn]);
    const description = find(GUESS.description, [date, balance, out, inn, amount]);
    const reference = find(GUESS.reference, [date, balance, out, inn, amount, description]);
    return { header: h, head, date, description, reference, balance,
      mode: out >= 0 && inn >= 0 ? "split" : "signed", out, in: inn, amount: amount >= 0 ? amount : (out >= 0 ? out : inn), order: "DMY" };
  }
  function parseRows(rows, m) {
    const out = [];
    let skipped = 0, bad = 0;
    rows.slice(m.header + 1).forEach((r) => {
      const date = parseDate(r[m.date], m.order);
      let amount;
      if (m.mode === "split") {
        const a = parseAmt(r[m.in]), b = parseAmt(r[m.out]);
        amount = Number.isNaN(a) || Number.isNaN(b) ? NaN : Math.round(((a || 0) - Math.abs(b || 0)) * 100) / 100;
      } else amount = parseAmt(r[m.amount]);
      if (!date || amount === null || amount === 0) { skipped++; return; }
      if (Number.isNaN(amount)) { bad++; return; }
      const bal = m.balance >= 0 ? parseAmt(r[m.balance]) : null;
      out.push({ date, amount, description: String(r[m.description] ?? "").slice(0, 500), reference: m.reference >= 0 ? String(r[m.reference] ?? "").slice(0, 100) : "",
        balance: bal === null || Number.isNaN(bal) ? null : bal });
    });
    return { lines: out, skipped, bad };
  }

  // ── Upload dialog ─────────────────────────────────────────────────────────
  /** Upload a statement (CSV, Excel or PDF). opts.account preselects the bank/card account. */
  async function upload(opts = {}) {
    const accounts = (await ZL.accounts()).filter(isMoney);
    if (!accounts.length) { ZL.toast("Create a bank account in the chart of accounts first.", "bad"); return; }
    const P = ZL.isPersonal();
    let last = null;
    try { last = localStorage.getItem(`zl.money.${cid()}`); } catch (_) { /* ignore */ }
    const pick = (accounts.find((a) => a.id === opts.account) || accounts.find((a) => a.id === last)
      || accounts.find((a) => a.code === (P ? "1120" : "1131")) || accounts[0]).id;
    let rows = null, map = null, parsed = null, pdf = null, file = null, password = "", fileName = "";
    const colSel = (name, val, optional) => `<select class="zl-input" data-map="${name}">${optional ? `<option value="-1">— none —</option>` : ""}${map.head.map((h, i) =>
      `<option value="${i}"${i === val ? " selected" : ""}>${E(h || `Column ${i + 1}`)}</option>`).join("")}</select>`;
    const preview = (lines) => {
      const inn = lines.filter((l) => l.amount > 0), out = lines.filter((l) => l.amount < 0);
      return { inn: ZL.sum(inn, (l) => l.amount), out: -ZL.sum(out, (l) => l.amount), table: `<div class="tablewrap" style="max-height:260px;overflow:auto"><table><thead><tr><th>Date</th><th>Description</th><th class="r">In</th><th class="r">Out</th><th class="r">Balance</th></tr></thead>
          <tbody>${lines.slice(0, 60).map((l) => `<tr><td class="nil" style="white-space:nowrap">${ZL.date(l.date)}</td><td>${E(l.description)}${l.reference ? `<div class="hint">${E(l.reference)}</div>` : ""}${l.uncertain ? ' <span class="chip warn" title="Direction guessed">?</span>' : ""}</td>
            <td class="r num">${l.amount > 0 ? M(l.amount) : ""}</td><td class="r num">${l.amount < 0 ? M(-l.amount) : ""}</td><td class="r num nil">${l.balance == null ? "" : M(l.balance)}</td></tr>`).join("")}</tbody></table></div>
        ${lines.length > 60 ? `<p class="hint">First 60 of ${lines.length} shown.</p>` : ""}` };
    };
    const mappingHtml = () => {
      const t = parsed, pv = preview(t.lines);
      return `<div class="zl-form" style="margin-top:14px">
          <label class="zl-field half"><span>Date column</span>${colSel("date", map.date)}</label>
          <label class="zl-field half"><span>Date format</span><select class="zl-input" data-map="order">
            <option value="DMY"${map.order === "DMY" ? " selected" : ""}>Day/Month/Year (31/12/2026)</option>
            <option value="MDY"${map.order === "MDY" ? " selected" : ""}>Month/Day/Year (12/31/2026)</option></select></label>
          <label class="zl-field half"><span>Description column</span>${colSel("description", map.description, true)}</label>
          <label class="zl-field half"><span>Reference column</span>${colSel("reference", map.reference, true)}</label>
          <label class="zl-field half"><span>Amounts are in</span><select class="zl-input" data-map="mode">
            <option value="split"${map.mode === "split" ? " selected" : ""}>Two columns — money in / money out</option>
            <option value="signed"${map.mode === "signed" ? " selected" : ""}>One column — minus means money out</option></select></label>
          ${map.mode === "split"
            ? `<label class="zl-field half"><span>Money in (deposit / credit)</span>${colSel("in", map.in)}</label>
               <label class="zl-field half"><span>Money out (withdrawal / debit)</span>${colSel("out", map.out)}</label>`
            : `<label class="zl-field half"><span>Amount column</span>${colSel("amount", map.amount)}</label>`}
          <label class="zl-field half"><span>Balance column</span>${colSel("balance", map.balance, true)}</label>
        </div>
        <div class="zl-banner info" style="margin:6px 0 10px">${t.lines.length} line${t.lines.length === 1 ? "" : "s"} read · in <b class="num">${M(pv.inn)}</b> · out <b class="num">${M(pv.out)}</b>${t.skipped ? ` · ${t.skipped} row${t.skipped === 1 ? "" : "s"} without a date or amount skipped (headers, totals)` : ""}${t.bad ? ` · <b>${t.bad} amount${t.bad === 1 ? "" : "s"} unreadable</b>` : ""}</div>
        ${pv.table}`;
    };
    const pdfHtml = () => {
      const pv = preview(pdf.lines);
      const check = pdf.balanced === true
        ? `<span class="chip ok">${TICK}Balances check out</span> opening ${M(pdf.opening)} + movements = closing ${M(pdf.closing)}.`
        : pdf.balanced === false
          ? "<b>The totals don't match the statement's balances.</b> Check a few lines below; if money in and out look reversed, press Swap."
          : "The opening and closing balances weren't found, so the totals couldn't be checked against them.";
      return `<div class="zl-banner ${pdf.balanced === false ? "" : "info"}" style="margin:14px 0 10px">${pdf.lines.length} line${pdf.lines.length === 1 ? "" : "s"} read from the PDF · in <b class="num">${M(pv.inn)}</b> · out <b class="num">${M(pv.out)}</b><br>${check}
          ${pdf.uncertain ? `<br>${pdf.uncertain} line${pdf.uncertain === 1 ? "" : "s"} marked ? had no in/out marker; the direction was guessed.` : ""}
          <div style="margin-top:8px"><button type="button" class="zl-btn sm ghost" id="zl-bswap">Swap money in and out</button></div></div>
        ${pdf.lines.length ? pv.table : '<p class="hint">No transaction lines were found. If this is a scanned statement, download the e-statement from your online banking instead.</p>'}`;
    };
    const passwordHtml = (msg) => `<div class="zl-banner" style="margin-top:14px">${E(msg)}</div>
      <div class="zl-form"><label class="zl-field half"><span>PDF password</span><input class="zl-input" type="password" id="zl-bpw" autocomplete="off"></label>
      <div class="zl-field half" style="align-self:end"><button type="button" class="zl-btn" id="zl-bpwgo">Open statement</button></div></div>
      <p class="hint">The password is used only in this browser to open the file. It isn't sent or saved.</p>`;
    const body = `<p class="zl-p">Choose the statement from ${P ? "your bank or card" : "your bank"}: the <b>PDF e-statement</b>, or a <b>CSV/Excel</b> download from online banking. Any bank works. Lines already in your books or imported before are skipped automatically.</p>
      <div class="zl-form" style="margin-top:12px">
        <label class="zl-field half"><span>${P ? "Bank or card account" : "Bank account in your books"}</span><select class="zl-input" id="zl-bacc">${accounts.map((a) =>
          `<option value="${a.id}"${a.id === pick ? " selected" : ""}>${E(a.name)} · ${E(a.code)}</option>`).join("")}</select></label>
        <label class="zl-field half"><span>Statement file</span><input class="zl-input" type="file" id="zl-bfile" accept=".pdf,.csv,.txt,.xlsx,.xls"></label>
      </div>
      <div id="zl-bmap"></div>`;
    const m = ZL.modal({
      title: P ? "Import a statement" : "Upload bank statement", wide: true, body,
      actions: [
        { label: "Cancel" },
        { label: "Import", primary: true, onClick: async ({ close }) => {
          let lines, opening = null, closing = null;
          if (pdf) {
            if (!pdf.lines.length) throw new ZL.ZLError("VALIDATION", "No transaction lines were found in this PDF.");
            opening = pdf.opening; closing = pdf.closing;
            lines = pdf.lines.map(({ uncertain, ...l }) => l);
          } else {
            if (!parsed) throw new ZL.ZLError("VALIDATION", "Choose the statement file first.");
            if (!parsed.lines.length) throw new ZL.ZLError("VALIDATION", "No line has both a date and an amount. Check the columns.");
            if (parsed.bad) throw new ZL.ZLError("VALIDATION", `${parsed.bad} amount${parsed.bad === 1 ? "" : "s"} couldn't be read. Check the amount columns.`);
            lines = parsed.lines;
            const first = lines[0];
            if (lines.some((l) => l.balance != null)) {
              opening = first.balance != null ? Math.round((first.balance - first.amount) * 100) / 100 : null;
              closing = lines[lines.length - 1].balance;
            }
          }
          const r = await ZL.rpc("import_bank_statement", {
            p_company: cid(), p_account: m.root.querySelector("#zl-bacc").value, p_name: fileName || "Statement",
            p_lines: lines, p_opening: opening, p_closing: closing,
          });
          close();
          ZL.toast(`Imported ${r.lines} lines — ${r.matched} already in your books${r.duplicates ? `, ${r.duplicates} imported before` : ""}.`);
          ZL.open(P ? "bankreview" : "bankrec", { st: r.id });
        } },
      ],
    });
    const slot = m.root.querySelector("#zl-bmap");
    const accSel = m.root.querySelector("#zl-bacc");
    const liability = () => { const a = accounts.find((x) => x.id === accSel.value); return !!a && a.type === "LIABILITY"; };
    const redraw = () => { parsed = parseRows(rows, map); slot.innerHTML = mappingHtml(); };
    const readPdf = async () => {
      slot.innerHTML = `<p class="hint" style="margin-top:12px">Reading ${E(file.name)}…</p>`;
      try {
        pdf = await ZL.statementPdf.read(file, { password, liability: liability() });
        slot.innerHTML = pdfHtml();
      } catch (e) {
        pdf = null;
        if (e && e.code === "PDF_PASSWORD") {
          slot.innerHTML = passwordHtml(e.message);
          const pw = slot.querySelector("#zl-bpw");
          const open = () => { password = pw.value; readPdf(); };
          slot.querySelector("#zl-bpwgo").addEventListener("click", open);
          pw.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); open(); } });
          pw.focus();
        } else { slot.innerHTML = ""; m.setError(e); }
      }
    };
    slot.addEventListener("click", (ev) => {
      if (ev.target.id !== "zl-bswap" || !pdf) return;
      pdf.lines.forEach((l) => { l.amount = -l.amount; });
      if (pdf.balanced !== null) pdf.balanced = !pdf.balanced;
      slot.innerHTML = pdfHtml();
    });
    slot.addEventListener("change", (ev) => {
      const k = ev.target.dataset.map;
      if (!k) return;
      map[k] = k === "order" || k === "mode" ? ev.target.value : Number(ev.target.value);
      if (k === "mode" && map.mode === "split" && (map.in < 0 || map.out < 0)) { map.in = map.in < 0 ? 0 : map.in; map.out = map.out < 0 ? 0 : map.out; }
      if (k === "mode" && map.mode === "signed" && map.amount < 0) map.amount = 0;
      redraw();
    });
    accSel.addEventListener("change", () => { if (pdf && file) readPdf(); });
    m.root.querySelector("#zl-bfile").addEventListener("change", async (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      m.setError(null);
      file = f; password = ""; pdf = null; parsed = null;
      fileName = f.name.replace(/\.[^.]+$/, "").slice(0, 200);
      if (/\.pdf$/i.test(f.name) || f.type === "application/pdf") { readPdf(); return; }
      slot.innerHTML = `<p class="hint" style="margin-top:12px">Reading ${E(f.name)}…</p>`;
      try {
        rows = await readFile(f);
        map = guessMapping(rows);
        if (map.date < 0) map.date = 0;
        if (map.amount < 0) map.amount = 0;
        redraw();
      } catch (e) { slot.innerHTML = ""; parsed = null; m.setError(e); }
    });
  }
  ZL.uploadStatement = upload;

  // ── Recording, matching and ignoring a line ───────────────────────────────
  async function recordLine(line) {
    const accounts = (await ZL.accounts()).filter((a) => a.is_postable && a.is_active && !isMoney(a));
    const P = ZL.isPersonal(), isIn = line.amount > 0;
    const order = isIn ? ["REVENUE", "LIABILITY", "EQUITY", "ASSET"] : ["EXPENSE", "COST_OF_SALES", "ASSET", "LIABILITY", "EQUITY"];
    const opts = order.flatMap((t) => accounts.filter((a) => a.type === t).map((a) => ({ value: a.id, label: `${a.name} · ${a.code}`, group: ZL.typeLabel(t) })));
    const sst = !P && isIn && accounts.some((a) => a.code === "2150");
    const [st] = await ZL.select("bank_statements", "account_id", (q) => q.eq("id", line.statement_id));
    const bankAccount = st ? st.account_id : null;
    const numRows = await ZL.numbering.load(line.date).catch(() => []);
    const kind = isIn ? "RECEIPT" : "PAYMENT";
    let numCtl = null;
    return ZL.form({
      title: isIn ? "Record money received" : "Record a payment",
      intro: `${ZL.date(line.date)} · <b>RM ${M(Math.abs(line.amount))}</b> ${isIn ? "in" : "out"} — ${E(line.description || "")}. It is posted ${P ? "" : `as a new ${isIn ? "receipt (OR)" : "voucher (PV)"} `}and matched to this line.`,
      confirmLabel: "Record and match",
      fields: [
        { name: "other", label: isIn ? (P ? "Where it came from" : "Category") : (P ? "What for" : "Category"), type: "select", required: true, value: "",
          options: [{ value: "", label: "Choose…" }].concat(opts) },
        ...ZL.numbering.fields(numRows, kind, bankAccount),
        ...(P ? [] : [{ name: "party", label: isIn ? "Received from" : "Paid to", placeholder: "Optional" }]),
        ...(sst ? [{ name: "tax", label: "SST included", type: "select", value: "0", half: true,
          options: [{ value: "0", label: "No SST" }, { value: "8", label: "Service tax 8%" }, { value: "6", label: "Service tax 6%" }, { value: "10", label: "Sales tax 10%" }, { value: "5", label: "Sales tax 5%" }] }] : []),
        { name: "description", label: "Description", value: line.description || "" },
      ],
      onOpen: (root) => { numCtl = ZL.numbering.wire(root, numRows, kind, { money: () => bankAccount }); },
      submit: (v) => {
        const num = numCtl ? numCtl.read() : {};
        return ZL.rpc("record_from_bank_line", { p_line: line.id, p_other_account: v.other, p_description: v.description || null,
          p_party: v.party || null, p_tax_rate: Number(v.tax || 0), p_series: num.p_series || null, p_doc_no: num.p_doc_no || null });
      },
    });
  }

  // Money in from a customer (or out to a supplier): post the receipt or payment, knock off
  // the invoices it pays, and match the line — the best guess is filled in.
  async function settleLine(line) {
    const [[st], list] = await Promise.all([
      ZL.select("bank_statements", "account_id", (q) => q.eq("id", line.statement_id)),
      ZL.rpc("bank_line_suggestions", { p_line: line.id }).catch(() => []),
    ]);
    const amount = Math.abs(line.amount), top = list[0];
    const preset = { amount, bankLine: { id: line.id, date: line.date, account_id: st && st.account_id, description: line.description, reference: line.reference } };
    if (top) {
      preset.contact_id = top.contact_id;
      const named = list.filter((s) => s.contact_id === top.contact_id && /number|reference/.test(s.why));
      if (ZL.cents(top.outstanding) === ZL.cents(amount)) preset.apply = { [top.doc_id]: amount };
      else if (named.length) {
        let left = ZL.cents(amount);
        preset.apply = {};
        named.forEach((s) => { const take = Math.min(left, ZL.cents(s.outstanding)); if (take) preset.apply[s.doc_id] = take / 100; left -= take; });
      } else preset.autoApply = true;
    }
    return new Promise((resolve) => {
      preset.onDone = (r) => {
        if (r) ZL.toast(`${r.doc_no} posted for ${r.contact || "the contact"} and matched${Number(r.advance) > 0 ? ` — RM ${M(r.advance)} kept as an advance` : ""}.`);
        resolve(!!r);
      };
      ZL.tradePay(line.amount > 0 ? "RECEIPT" : "PAYMENT", preset).catch((e) => { ZL.toast(ZL.errorText(e), "bad"); resolve(false); });
    });
  }

  async function matchLine(line) {
    let cands;
    try { cands = await ZL.rpc("bank_match_candidates", { p_line: line.id }); } catch (e) { ZL.toast(ZL.errorText(e), "bad"); return null; }
    if (!cands.length) {
      ZL.toast(`Nothing in the books moves RM ${M(Math.abs(line.amount))} on this account within 45 days. Record it instead.`, "warn");
      return null;
    }
    cands.sort((a, b) => Math.abs(new Date(a.date) - new Date(line.date)) - Math.abs(new Date(b.date) - new Date(line.date)));
    return new Promise((resolve) => {
      let done = false;
      ZL.modal({
        title: "Match to a recorded entry",
        body: `<p class="zl-p">${ZL.date(line.date)} · <b>RM ${M(Math.abs(line.amount))}</b> ${line.amount > 0 ? "in" : "out"} — ${E(line.description || "")}</p>
          <div class="tablewrap" style="margin-top:12px"><table><thead><tr><th></th><th>Date</th><th>Voucher / journal</th><th>Description</th></tr></thead><tbody>
          ${cands.map((c, i) => `<tr><td><input type="radio" name="zl-cand" value="${c.entry_id}"${i ? "" : " checked"} aria-label="Choose"></td>
            <td class="nil" style="white-space:nowrap">${ZL.date(c.date)}</td><td style="white-space:nowrap"><span class="zl-ref">${E(c.doc_no || c.reference)}</span></td><td>${E(c.description || "")}</td></tr>`).join("")}
          </tbody></table></div>`,
        onClose: () => { if (!done) resolve(null); },
        actions: [{ label: "Cancel" }, { label: "Match", primary: true, onClick: async ({ root, close }) => {
          const v = root.querySelector('[name="zl-cand"]:checked');
          if (!v) throw new ZL.ZLError("VALIDATION", "Choose an entry.");
          await ZL.rpc("match_bank_line", { p_line: line.id, p_entry: v.value });
          done = true; resolve(true); close();
        } }],
      });
    });
  }

  // ── Pages ─────────────────────────────────────────────────────────────────
  const INTRO = (P) => `<section class="card" style="padding:18px 22px;margin-bottom:16px"><div class="zl-steps3">
      <div><b>1 · Upload</b><span>CSV or Excel from ${P ? "your bank or card" : "Maybank2u, CIMB Clicks, RHB, Public Bank or any bank"}.</span></div>
      <div><b>2 · Auto-match</b><span>Each line pairs with the ${P ? "entry" : "PV or OR"} you recorded — same account and amount, within 7 days.</span></div>
      <div><b>3 · Clear the rest</b><span>Record what's missing in one click, match by hand, or ignore. The balance proof updates as you go.</span></div>
    </div></section>`;

  async function listHtml() {
    const P = ZL.isPersonal();
    const [sts, accounts, lines] = await Promise.all([
      ZL.select("bank_statements", "*", (q) => q.eq("company_id", cid()).order("date_to", { ascending: false }).order("created_at", { ascending: false }).limit(100)),
      ZL.accounts(),
      ZL.select("bank_lines", "statement_id,status", (q) => q.eq("company_id", cid()).neq("status", "MATCHED").limit(10000)),
    ]);
    const acc = new Map(accounts.map((a) => [a.id, a]));
    const open = new Map();
    lines.forEach((l) => { if (l.status === "UNMATCHED") open.set(l.statement_id, (open.get(l.statement_id) || 0) + 1); });
    const canUp = ZL.can("journal.create");
    return ZL.header(P ? "Match bank statement" : "Bank reconciliation", "Upload a statement; every line is tallied against what you recorded.",
        canUp ? btn("zl-bup", "Upload statement", "primary") : "") +
      (sts.length < 3 ? INTRO(P) : "") +
      (sts.length ? `<section class="card"><div class="tablewrap"><table>
        <thead><tr><th>Statement</th><th>Account</th><th>Period</th><th class="r">Lines</th><th>Status</th><th class="r">Closing balance</th></tr></thead>
        <tbody>${sts.map((s) => { const a = acc.get(s.account_id); const u = open.get(s.id) || 0; return `<tr class="click" data-st="${s.id}">
          <td style="font-weight:500">${E(s.name)}<div class="hint">Uploaded ${ZL.date(s.created_at)}</div></td>
          <td>${a ? `${E(a.name)} <span class="code">${E(a.code)}</span>` : "—"}</td>
          <td class="nil" style="white-space:nowrap">${ZL.date(s.date_from)} – ${ZL.date(s.date_to)}</td>
          <td class="r num">${s.line_count}</td>
          <td>${u ? `<span class="chip warn">${u} to clear</span>` : `<span class="chip ok">${TICK}All cleared</span>`}</td>
          <td class="r num">${s.closing_balance == null ? '<span class="nil">—</span>' : M(s.closing_balance)}</td></tr>`; }).join("")}</tbody></table></div></section>`
        : ZL.empty("No statements yet", "Upload your first bank statement to see which payments and receipts tally.",
          canUp ? btn("zl-bup2", "Upload statement", "primary") : ""));
  }

  async function statementHtml(p) {
    const P = ZL.isPersonal();
    const [sts, accounts] = await Promise.all([ZL.select("bank_statements", "*", (q) => q.eq("id", p.st).eq("company_id", cid())), ZL.accounts()]);
    const st = sts[0];
    if (!st) return ZL.empty("Statement not found", "It may have been deleted.", btn("zl-bback", "← Statements", "ghost"));
    const [lines, notOnBank, bal, suggs] = await Promise.all([
      ZL.select("bank_lines", "*", (q) => q.eq("statement_id", st.id).order("line_no").limit(6000)),
      ZL.rpc("bank_unmatched_book", { p_statement: st.id }).catch(() => []),
      ZL.rpc("account_balances", { p_company: cid(), p_from: null, p_to: st.date_to }).catch(() => null),
      P ? [] : ZL.rpc("bank_statement_suggestions", { p_statement: st.id }).catch(() => []),
    ]);
    const sugg = new Map(suggs.map((s) => [s.line_id, s]));
    const acc = new Map(accounts.map((a) => [a.id, a]));
    const bankAcc = acc.get(st.account_id) || { name: "", code: "" };
    const entryIds = lines.filter((l) => l.entry_id).map((l) => l.entry_id);
    const entries = entryIds.length ? await ZL.select("journal_entries", "id,reference,doc_no", (q) => q.in("id", entryIds.slice(0, 900))) : [];
    const ent = new Map(entries.map((e) => [e.id, e]));
    const n = { MATCHED: 0, UNMATCHED: 0, IGNORED: 0 };
    lines.forEach((l) => { n[l.status]++; });
    const want = p.show || (n.UNMATCHED ? "UNMATCHED" : "");
    const shown = lines.filter((l) => !want || l.status === want);
    const can = ZL.can("journal.post");

    // Proof: the statement's closing balance against the books at the same date.
    const moved = ZL.sum(lines, (l) => l.amount);
    // A card statement's balance is what you owe, not a debit balance, so only bank and cash accounts get the proof.
    const isCard = bankAcc.type === "LIABILITY";
    const closing = isCard ? null : st.closing_balance != null ? Number(st.closing_balance) : st.opening_balance != null ? Number(st.opening_balance) + moved : null;
    const row = bal && bal.find((b) => b.account_id === st.account_id);
    const book = row ? ZL.cents(row.closing) / 100 : null;
    const inTransit = ZL.sum(notOnBank.filter((x) => x.amount > 0), (x) => x.amount);
    const outstanding = -ZL.sum(notOnBank.filter((x) => x.amount < 0), (x) => x.amount);
    const unrecorded = ZL.sum(lines.filter((l) => l.status === "UNMATCHED"), (l) => l.amount);
    const ignored = ZL.sum(lines.filter((l) => l.status === "IGNORED"), (l) => l.amount);
    const adjBank = closing == null ? null : closing + inTransit - outstanding;
    const adjBook = book == null ? null : book + unrecorded + ignored;
    const diff = adjBank == null || adjBook == null ? null : ZL.cents(adjBank) - ZL.cents(adjBook);
    const pct = lines.length ? Math.round(((n.MATCHED + n.IGNORED) / lines.length) * 100) : 0;
    const proofRow = (label, v, strong) => `<tr${strong ? ' class="zl-sub"' : ""}><td>${label}</td><td class="r num">${v == null ? "—" : M(v)}</td></tr>`;

    const seg = [["UNMATCHED", `To clear (${n.UNMATCHED})`], ["MATCHED", `Matched (${n.MATCHED})`], ["IGNORED", `Ignored (${n.IGNORED})`], ["", "All"]].map(([v, l]) =>
      `<button type="button" data-bshow="${v}" aria-pressed="${want === v}">${l}</button>`).join("");
    const statusCell = (l) => {
      if (l.status === "MATCHED") {
        const e = ent.get(l.entry_id) || {};
        const how = { AUTO: "Auto", MANUAL: "By hand", CREATED: "Recorded" }[l.match_method] || "";
        return `<span class="chip ok">${TICK}${how}</span> <button type="button" class="zl-ref" ${e.doc_no ? `data-voucher="${l.entry_id}"` : `data-open-journal="${l.entry_id}"`}>${E(e.doc_no || e.reference || "Journal")}</button>`;
      }
      if (l.status === "IGNORED") return `<span class="chip">Ignored</span>${l.note ? ` <span class="hint">${E(l.note)}</span>` : ""}`;
      return `<span class="chip warn">Not in books</span>`;
    };
    const settle = !P && ZL.can("journal.create") && typeof ZL.tradePay === "function";
    const hint = (l) => {
      const s = l.status === "UNMATCHED" && sugg.get(l.id);
      if (!s) return "";
      const what = /whole balance/.test(s.why) ? `Clears <b>${E(s.contact_name)}</b>'s balance of RM ${M(s.contact_open)}`
        : `${l.amount > 0 ? "Pays" : "Settles"} <b>${E(s.doc_no)}</b> · ${E(s.contact_name)}`;
      return `<div class="zl-bsugg">💡 ${what} <span class="hint">— ${E(s.why)}</span></div>`;
    };
    const actions = (l) => !can ? "" : l.status === "UNMATCHED"
      ? `${settle ? `<button type="button" class="zl-btn sm${sugg.has(l.id) ? " primary" : ""}" data-bsettle="${l.id}" title="${l.amount > 0 ? "A customer paid an invoice" : "You paid a supplier's bill"}">${l.amount > 0 ? "Receive" : "Pay bill"}</button> ` : ""}<button type="button" class="zl-btn sm${settle && sugg.has(l.id) ? "" : " primary"}" data-brec="${l.id}">Record</button> <button type="button" class="zl-btn sm" data-bmatch="${l.id}">Match</button> <button type="button" class="zl-btn sm ghost" data-bign="${l.id}">Ignore</button>`
      : `<button type="button" class="zl-btn sm ghost" data-bun="${l.id}">${l.status === "IGNORED" ? "Restore" : "Unmatch"}</button>`;

    return ZL.header(st.name, `${bankAcc.name} · ${bankAcc.code} — ${ZL.date(st.date_from)} to ${ZL.date(st.date_to)} · ${lines.length} lines`,
        `${btn("zl-bback", "← Statements", "ghost")}${can && n.UNMATCHED ? btn("zl-ball", `Record all ${n.UNMATCHED}`, "primary") : ""}${can ? btn("zl-brerun", "Match again") : ""}${ZL.can("journal.create") ? btn("zl-bdel", "Delete", "ghost danger") : ""}`) + `
      <div class="zl-recon">
        <section class="card" style="padding:18px 22px">
          <div class="hint" style="margin-bottom:6px">Cleared</div>
          <div style="font-size:28px;font-weight:600" class="num">${pct}%</div>
          <div class="zl-bar"><i style="width:${pct}%"></i></div>
          <p class="hint" style="margin-top:8px">${n.MATCHED} matched · ${n.UNMATCHED} to clear · ${n.IGNORED} ignored</p>
          ${diff === 0 && !n.UNMATCHED ? `<p class="chip ok" style="margin-top:10px">${TICK}Reconciled — bank and books agree</p>` : ""}
        </section>
        <section class="card" style="padding:14px 18px"><table class="zl-proof"><tbody>
          ${proofRow("Balance per bank statement", closing)}
          ${proofRow("+ Money in recorded, not yet on the statement", inTransit)}
          ${proofRow("− Payments recorded, not yet on the statement", outstanding)}
          ${proofRow("Adjusted bank balance", adjBank, true)}
          ${proofRow(`Balance in the books at ${ZL.date(st.date_to)}`, book)}
          ${proofRow("± Statement lines not yet recorded or ignored", unrecorded + ignored)}
          ${proofRow("Adjusted book balance", adjBook, true)}
          <tr class="zl-sub"><td>Difference</td><td class="r num ${diff === 0 ? "zl-pos" : ""}"${diff ? ' style="color:var(--bad)"' : ""}>${diff == null ? "—" : diff === 0 ? `${TICK} 0.00` : M(diff / 100)}</td></tr>
        </tbody></table>
        ${diff ? `<p class="hint" style="margin-top:8px">A difference usually means the opening balance in Zycount differs from the bank's, or an entry dated before this statement is still outstanding.</p>` : ""}
        ${closing == null ? `<p class="hint">${isCard ? "Card statements show what you owe, so compare the balance by hand." : "The file had no balance column, so the statement balance is unknown."}</p>` : ""}</section>
      </div>
      <div class="toolbar"><div class="seg" role="group" aria-label="Show">${seg}</div><span class="count"><b>${shown.length}</b> line${shown.length === 1 ? "" : "s"}</span></div>
      ${shown.length ? `<section class="card"><div class="tablewrap"><table>
        <thead><tr><th>Date</th><th>Bank description</th><th class="r">In</th><th class="r">Out</th><th>In the books</th><th></th></tr></thead>
        <tbody>${shown.map((l) => `<tr>
          <td class="nil" style="white-space:nowrap">${ZL.date(l.date)}</td>
          <td>${E(l.description || "—")}${l.reference ? `<div class="hint">${E(l.reference)}</div>` : ""}${hint(l)}</td>
          <td class="r num zl-amt-in">${l.amount > 0 ? M(l.amount) : ""}</td><td class="r num">${l.amount < 0 ? M(-l.amount) : ""}</td>
          <td style="white-space:nowrap">${statusCell(l)}</td>
          <td class="r" style="white-space:nowrap">${actions(l)}</td></tr>`).join("")}</tbody></table></div></section>`
        : ZL.empty(want === "UNMATCHED" ? "Every line is cleared" : "Nothing here", want === "UNMATCHED" ? "All statement lines are matched, recorded or ignored." : "Choose another filter.")}
      ${notOnBank.length ? `<h3 style="margin:22px 0 8px;font-size:15px">In your books, not on this statement</h3>
        <section class="card"><div class="tablewrap"><table><thead><tr><th>Date</th><th>${P ? "Journal" : "Voucher / journal"}</th><th>Description</th><th class="r">Amount</th></tr></thead>
        <tbody>${notOnBank.map((x) => `<tr class="click" data-open-journal="${x.entry_id}"><td class="nil">${ZL.date(x.date)}</td><td><span class="zl-ref">${E(x.doc_no || x.reference)}</span></td>
          <td>${E(x.description || "")}</td><td class="r num ${x.amount > 0 ? "zl-amt-in" : ""}">${x.amount > 0 ? "+" : "−"}${M(Math.abs(x.amount))}</td></tr>`).join("")}</tbody></table></div>
        <div class="proofrow"><span>Usually cheques not yet presented or deposits still clearing. If one never appears on the bank, reverse it.</span></div></section>` : ""}`;
  }

  ZL.register("bankrec", {
    title: "Bank reconciliation",
    perm: "journal.view",
    render: (ctx) => (ctx.params.st ? statementHtml(ctx.params) : listHtml()),
    after(root, ctx) {
      const p = ctx.params;
      const again = () => ZL.open("bankrec", Object.assign({}, p));
      ["#zl-bup", "#zl-bup2"].forEach((s) => { const b = root.querySelector(s); if (b) b.addEventListener("click", upload); });
      root.querySelectorAll("[data-st]").forEach((r) => r.addEventListener("click", () => ZL.open("bankrec", { st: r.dataset.st })));
      const back = root.querySelector("#zl-bback");
      if (back) back.addEventListener("click", () => ZL.open("bankrec", {}));
      root.querySelectorAll("[data-bshow]").forEach((b) => b.addEventListener("click", () => ZL.open("bankrec", Object.assign({}, p, { show: b.dataset.bshow || "" }))));
      const lineOf = async (id) => (await ZL.select("bank_lines", "*", (q) => q.eq("id", id)))[0];
      const act = (sel, fn) => root.querySelectorAll(sel).forEach((b) => b.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        b.disabled = true;
        try { if (await fn(b)) again(); } catch (e) { ZL.toast(ZL.errorText(e), "bad"); } finally { b.disabled = false; }
      }));
      act("[data-brec]", async (b) => { const r = await recordLine(await lineOf(b.dataset.brec)); if (r) ZL.toast(`Recorded as ${r.doc_no || r.reference} and matched.`); return !!r; });
      act("[data-bmatch]", async (b) => matchLine(await lineOf(b.dataset.bmatch)));
      act("[data-bsettle]", async (b) => settleLine(await lineOf(b.dataset.bsettle)));
      act("[data-bign]", async (b) => {
        const v = await ZL.form({ title: "Ignore this line", intro: "Use this for lines that should not be in these books, such as a transfer already recorded elsewhere.",
          fields: [{ name: "note", label: "Reason", placeholder: "Optional" }], confirmLabel: "Ignore" });
        if (!v) return false;
        await ZL.rpc("ignore_bank_line", { p_line: b.dataset.bign, p_note: v.note || null });
        return true;
      });
      act("[data-bun]", async (b) => { await ZL.rpc("unmatch_bank_line", { p_line: b.dataset.bun }); return true; });
      const all = root.querySelector("#zl-ball");
      if (all) all.addEventListener("click", () => ZL.open("bankreview", { st: p.st }));
      const rerun = root.querySelector("#zl-brerun");
      if (rerun) rerun.addEventListener("click", async () => {
        try { const k = await ZL.rpc("auto_match_statement", { p_statement: p.st }); ZL.toast(k ? `${k} more line${k === 1 ? "" : "s"} matched.` : "No new matches."); again(); }
        catch (e) { ZL.toast(ZL.errorText(e), "bad"); }
      });
      const del = root.querySelector("#zl-bdel");
      if (del) del.addEventListener("click", async () => {
        if (!(await ZL.confirm({ title: "Delete this statement?", message: "The uploaded lines and their matches are removed. Journals, vouchers and receipts stay exactly as they are.", confirmLabel: "Delete statement", danger: true }))) return;
        try { await ZL.rpc("delete_bank_statement", { p_statement: p.st }); ZL.toast("Statement deleted."); ZL.open("bankrec", {}); }
        catch (e) { ZL.toast(ZL.errorText(e), "bad"); }
      });
      root.querySelectorAll("[data-voucher]").forEach((b) => b.addEventListener("click", (ev) => { ev.stopPropagation(); ZL.voucher(b.dataset.voucher); }));
      ZL.wireJournalLinks(root);
    },
  });

  const css = document.createElement("style");
  css.textContent = `
  .zl-steps3{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
  .zl-steps3 b{display:block;margin-bottom:3px;font-weight:600}
  .zl-steps3 span{color:var(--ink-3);font-size:13px}
  .zl-recon{display:grid;grid-template-columns:minmax(220px,300px) 1fr;gap:16px;margin-bottom:16px}
  .zl-bsugg{margin-top:4px;font-size:12.5px;color:var(--ink-2)}
  .zl-bar{height:6px;background:var(--line);border-radius:99px;margin-top:8px;overflow:hidden}
  .zl-bar i{display:block;height:100%;background:var(--good,#16a34a);border-radius:99px}
  .zl-proof{width:100%;border-collapse:collapse}
  .zl-proof td{padding:6px 0;border-bottom:1px solid var(--line);font-size:13.5px}
  .zl-proof tr.zl-sub td{font-weight:600;border-bottom:1.5px solid var(--ink)}
  @media (max-width:900px){.zl-recon,.zl-steps3{grid-template-columns:1fr}}
  `;
  document.head.appendChild(css);

  ZL._bankParse = { parseDate, parseAmt, guessMapping, parseRows }; // exposed for tests
})();
