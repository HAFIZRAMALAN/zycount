/* ═══════════════════════════════════════════════════════════════════════════
 * Zycount live workspace — sales, purchases and the cash book.
 *
 * Customers and suppliers, items, SST tax codes, and every commercial document:
 *   sales      quotation → invoice / cash sale, debit and credit notes,
 *              receipts (knock-off against invoices) and refunds;
 *   purchases  purchase order → purchase invoice / cash purchase, supplier
 *              debit and credit notes, payments and supplier refunds.
 * The database computes every total, posts the double entry to the control
 * accounts (sales_purchases migration) and keeps posted documents fixed.
 * Plus aged receivables/payables, statements of account and the cash book.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const ZL = window.ZL;
  const E = ZL.esc;
  const M = ZL.money;
  const cid = () => ZL.company.company_id;
  const bad = (msg) => new ZL.ZLError("VALIDATION", msg);

  // ── What each document is ────────────────────────────────────────────────
  const T = {
    QUOTATION:       { side: "AR", label: "Quotation", plural: "Quotations", title: "Quotation", lines: true, posts: false, effect: 0 },
    INVOICE:         { side: "AR", label: "Invoice", plural: "Invoices", title: "Invoice", lines: true, posts: true, effect: 1 },
    CASH_SALE:       { side: "AR", label: "Cash sale", plural: "Cash sales", title: "Cash Sale", lines: true, posts: true, effect: 0, money: true },
    DEBIT_NOTE:      { side: "AR", label: "Debit note", plural: "Debit notes", title: "Debit Note", lines: true, posts: true, effect: 1 },
    CREDIT_NOTE:     { side: "AR", label: "Credit note", plural: "Credit notes", title: "Credit Note", lines: true, posts: true, effect: -1 },
    RECEIPT:         { side: "AR", label: "Receipt", plural: "Receipts", title: "Official Receipt", lines: false, posts: true, effect: -1, money: true },
    REFUND:          { side: "AR", label: "Refund", plural: "Refunds", title: "Refund Voucher", lines: false, posts: true, effect: 1, money: true },
    PURCHASE_ORDER:  { side: "AP", label: "Purchase order", plural: "Purchase orders", title: "Purchase Order", lines: true, posts: false, effect: 0 },
    BILL:            { side: "AP", label: "Purchase invoice", plural: "Purchase invoices", title: "Purchase Invoice", lines: true, posts: true, effect: 1 },
    CASH_PURCHASE:   { side: "AP", label: "Cash purchase", plural: "Cash purchases", title: "Cash Purchase", lines: true, posts: true, effect: 0, money: true },
    SUPPLIER_DN:     { side: "AP", label: "Supplier debit note", plural: "Supplier debit notes", title: "Debit Note", lines: true, posts: true, effect: 1 },
    SUPPLIER_CN:     { side: "AP", label: "Supplier credit note", plural: "Supplier credit notes", title: "Credit Note", lines: true, posts: true, effect: -1 },
    PAYMENT:         { side: "AP", label: "Payment", plural: "Payments", title: "Payment Voucher", lines: false, posts: true, effect: -1, money: true },
    SUPPLIER_REFUND: { side: "AP", label: "Supplier refund", plural: "Supplier refunds", title: "Official Receipt", lines: false, posts: true, effect: 1, money: true },
    AR_CONTRA:       { side: "AR", label: "Contra", plural: "Contras", title: "Contra Note", lines: false, posts: true, effect: -1, contra: true },
    AP_CONTRA:       { side: "AP", label: "Contra", plural: "Contras", title: "Contra Note", lines: false, posts: true, effect: -1, contra: true },
  };
  const SALES = ["QUOTATION", "INVOICE", "CASH_SALE", "DEBIT_NOTE", "CREDIT_NOTE", "RECEIPT", "REFUND", "AR_CONTRA"];
  const PURCHASES = ["PURCHASE_ORDER", "BILL", "CASH_PURCHASE", "SUPPLIER_DN", "SUPPLIER_CN", "PAYMENT", "SUPPLIER_REFUND", "AP_CONTRA"];
  const seriesKind = (t) => ({ REFUND: "PAYMENT", SUPPLIER_REFUND: "RECEIPT" }[t] || t);
  const SIDE = {
    AR: { route: "sales", who: "customer", Who: "Customer", kind: "CUSTOMER", list: "customers", aging: "araging", pay: "RECEIPT", payLabel: "Receive payment" },
    AP: { route: "purchases", who: "supplier", Who: "Supplier", kind: "SUPPLIER", list: "suppliers", aging: "apaging", pay: "PAYMENT", payLabel: "Pay supplier" },
  };
  const CONVERT = {
    QUOTATION: [["INVOICE", "Turn into invoice"], ["CASH_SALE", "Turn into cash sale"]],
    PURCHASE_ORDER: [["BILL", "Turn into purchase invoice"], ["CASH_PURCHASE", "Turn into cash purchase"]],
    INVOICE: [["CREDIT_NOTE", "Credit note"], ["DEBIT_NOTE", "Debit note"]],
    BILL: [["SUPPLIER_CN", "Supplier credit note"], ["SUPPLIER_DN", "Supplier debit note"]],
  };
  const METHODS = ["Bank transfer", "DuitNow / FPX", "Cheque", "Cash", "Card", "Online banking", "Other"];
  const STATES = ["", "Johor", "Kedah", "Kelantan", "Melaka", "Negeri Sembilan", "Pahang", "Pulau Pinang", "Perak", "Perlis", "Sabah",
    "Sarawak", "Selangor", "Terengganu", "WP Kuala Lumpur", "WP Labuan", "WP Putrajaya"];

  const isMoney = (a) => a.is_postable && a.is_active && (a.is_cash || (ZL.isPersonal() && a.type === "LIABILITY" && a.sub_type === "CURRENT_LIABILITY"));
  const lineUsable = (a) => a.is_postable && a.is_active && !a.is_control && !a.is_cash;
  const TYPE_ORDER = { AR: ["REVENUE", "LIABILITY", "ASSET", "EQUITY", "EXPENSE", "COST_OF_SALES"], AP: ["EXPENSE", "COST_OF_SALES", "ASSET", "LIABILITY", "EQUITY", "REVENUE"] };
  const TYPE_NAME = { ASSET: "Assets", LIABILITY: "Liabilities", EQUITY: "Equity", REVENUE: "Income", COST_OF_SALES: "Cost of sales", EXPENSE: "Expenses" };
  const accOptions = (accounts, side, selected, blank = "Choose account…") => `<option value="">${E(blank)}</option>` +
    TYPE_ORDER[side].map((t) => {
      const list = accounts.filter((a) => a.type === t && (lineUsable(a) || a.id === selected));
      return list.length ? `<optgroup label="${TYPE_NAME[t]}">${list.map((a) => `<option value="${a.id}"${a.id === selected ? " selected" : ""}>${E(a.code)} · ${E(a.name)}</option>`).join("")}</optgroup>` : "";
    }).join("");
  const opt = (v, l, sel) => `<option value="${E(v)}"${String(v) === String(sel == null ? "" : sel) ? " selected" : ""}>${E(l)}</option>`;
  const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
  const r2 = (n) => Math.round(Number(n) * 100) / 100;
  const outstanding = (d) => r2(ZL.num(d.total) - ZL.num(d.allocated));

  // ── Loaders ──────────────────────────────────────────────────────────────
  const contacts = (kind) => ZL.select("contacts", "*", (q) => q.eq("company_id", cid()).eq("kind", kind).order("name"));
  const taxCodes = () => ZL.select("tax_codes", "*", (q) => q.eq("company_id", cid()).order("code"));
  const items = () => ZL.select("items", "*", (q) => q.eq("company_id", cid()).order("code"));
  async function loadDoc(id) {
    const [docs, lines] = await Promise.all([
      ZL.select("trade_docs", "*", (q) => q.eq("id", id).eq("company_id", cid())),
      ZL.select("trade_doc_lines", "*", (q) => q.eq("doc_id", id).order("line_no")),
    ]);
    if (!docs[0]) throw new ZL.ZLError("NOT_FOUND", "That document isn't in these books.");
    return { doc: docs[0], lines };
  }

  /** Status as people read it: draft, open, part-paid, paid, overdue, void. */
  const EINV_CHIP = { VALID: '<span class="chip ok" title="Validated by LHDN">LHDN ✓</span>', SUBMITTED: '<span class="chip" title="With LHDN, waiting for validation">LHDN…</span>',
    INVALID: '<span class="chip bad" title="LHDN rejected it — open to see why">LHDN ✗</span>', CANCELLED: '<span class="chip" title="Cancelled at LHDN">LHDN cancelled</span>' };
  function statusChip(d) {
    return baseChip(d) + (d.einvoice_status && EINV_CHIP[d.einvoice_status] ? " " + EINV_CHIP[d.einvoice_status] : "");
  }
  function baseChip(d) {
    const t = T[d.doc_type];
    if (d.status === "DRAFT") return '<span class="chip">Draft</span>';
    if (d.status === "VOID") return '<span class="chip bad">Void</span>';
    if (!t.posts) return '<span class="chip ok">Issued</span>';
    if (t.effect === 0) return '<span class="chip ok">Paid</span>';
    const open = outstanding(d);
    if (t.effect === -1) return open > 0 ? `<span class="chip warn">${M(open)} unapplied</span>` : '<span class="chip ok">Applied</span>';
    if (open <= 0) return '<span class="chip ok">Paid</span>';
    if (d.due_date && d.due_date < ZL.today()) return `<span class="chip bad">Overdue ${days(d.due_date, ZL.today())}d</span>`;
    return ZL.num(d.allocated) > 0 ? '<span class="chip warn">Part paid</span>' : '<span class="chip">Open</span>';
  }

  // ── Printable document ───────────────────────────────────────────────────
  const XCSS = `
  .zv.zv .zv-bill{display:grid;grid-template-columns:1.4fr 1fr;gap:18px;margin:18px 0 14px}
  .zv.zv .zv-bill span{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#7a7f8c;margin-bottom:3px}
  .zv.zv .zv-bill b{display:block;font-size:13.5px}
  .zv.zv .zv-bill div div{color:#3d4150;white-space:pre-line}
  .zv.zv .zv-items th.r,.zv.zv .zv-items td.r{text-align:right}
  .zv.zv .zv-sum{margin-left:auto;margin-top:8px;border-collapse:collapse;min-width:260px}
  .zv.zv .zv-sum td{padding:4px 10px;font-variant-numeric:tabular-nums}
  .zv.zv .zv-sum td.r{text-align:right}
  .zv.zv .zv-sum tr.grand td{font-weight:700;font-size:14px;border-top:2px solid #1b1d24;border-bottom:2px solid #1b1d24}
  .zv.zv .zv-notes{margin-top:14px;white-space:pre-line;font-size:11.5px;color:#3d4150}
  .zv.zv .zv-notes span{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#7a7f8c;margin-bottom:2px}
  .zv.zv .zv-aging{width:100%;border-collapse:collapse;margin-top:14px;font-size:11px}
  .zv.zv .zv-aging th{background:var(--acc-soft,#eef0fb);padding:6px 8px;text-align:right;font-weight:600}
  .zv.zv .zv-aging td{padding:6px 8px;text-align:right;border-bottom:1px solid #eceef3;font-variant-numeric:tabular-nums}
  @media (max-width:640px){.zv.zv .zv-bill{grid-template-columns:1fr}}`;
  const vstyle = document.createElement("style");
  vstyle.textContent = XCSS;
  document.head.appendChild(vstyle);
  // Printing and PDF read the voucher stylesheet; carry these rules with it.
  const vcss = document.getElementById("zl-voucher-css");
  if (vcss) vcss.textContent += XCSS;

  const tint = (hex, k) => {
    const n = /^#[0-9a-f]{6}$/i.test(hex || "") ? parseInt(hex.slice(1), 16) : 0x3a3fd0;
    const ch = (sh) => Math.round(((n >> sh) & 255) * k + 255 * (1 - k)).toString(16).padStart(2, "0");
    return `#${ch(16)}${ch(8)}${ch(0)}`;
  };
  function letterhead(info, ds, title, meta) {
    const ids = [info.registration_no ? `Reg. no. ${E(info.registration_no)}` : "", info.tax_registration_no || info.tax_no ? `SST no. ${E(info.tax_registration_no || info.tax_no)}` : ""].filter(Boolean).join(" · ");
    const contact = [info.phone, info.email].filter(Boolean).map(E).join(" · ");
    return `<div class="zv-top">
      <div class="zv-co">${ds.logo ? `<img src="${E(ds.logo)}" alt="">` : ""}
        <div><b>${E(info.name || "")}</b>${ids ? `<div>${ids}</div>` : ""}${info.address ? `<div style="white-space:pre-line">${E(info.address)}</div>` : ""}${contact ? `<div>${contact}</div>` : ""}</div></div>
      <div class="zv-ttl"><h2>${E(title)}</h2><table class="zv-meta">${meta.filter((m) => m[1]).map(([k, v]) => `<tr><th>${E(k)}</th><td>${E(v)}</td></tr>`).join("")}</table></div></div>`;
  }
  const shell = (ds, inner, stamp) => {
    const accent = /^#[0-9a-f]{6}$/i.test(ds.accent || "") ? ds.accent : "#3A3FD0";
    return `<div class="zv" style="--acc:${accent};--acc-soft:${tint(accent, 0.09)}">${stamp ? `<div class="zv-void"><span>${E(stamp)}</span></div>` : ""}${inner}</div>`;
  };
  const billTo = (d, c, heading) => {
    const idl = c ? [c.tin ? `TIN ${c.tin}` : "", c.reg_no ? `${c.id_type === "NRIC" ? "NRIC" : "Reg. no."} ${c.reg_no}` : "", c.sst_no ? `SST ${c.sst_no}` : ""].filter(Boolean).join(" · ") : "";
    const addr = d.bill_address || (c ? [c.address, [c.postcode, c.city].filter(Boolean).join(" "), c.state].filter(Boolean).join("\n") : "");
    return `<div><span>${E(heading)}</span><b>${E(d.bill_name || (c && c.name) || "Cash customer")}</b>
      ${addr ? `<div>${E(addr)}</div>` : ""}${idl ? `<div>${E(idl)}</div>` : ""}${d.attention ? `<div>Attn: ${E(d.attention)}</div>` : ""}${c && c.phone ? `<div>${E(c.phone)}</div>` : ""}</div>`;
  };

  /** The printable document. data = { doc, lines, contact, info, ds, taxes, allocs, bank, title } */
  ZL.tradeDocHtml = ({ doc: d, lines = [], contact: c, info, ds, taxes = [], allocs = [], bank, title, einvoice = "" }) => {
    const t = T[d.doc_type];
    const stamp = d.status === "VOID" ? "VOID" : d.status === "DRAFT" ? "DRAFT" : "";
    const ttl = title || t.title;
    if (!t.lines) {
      const partyHead = { RECEIPT: "Received from", REFUND: "Refunded to", PAYMENT: "Paid to", SUPPLIER_REFUND: "Received from", AR_CONTRA: "Customer", AP_CONTRA: "Supplier" }[d.doc_type];
      const rows = allocs.map((a) => `<tr><td>${E(T[a.doc_type] ? T[a.doc_type].label : "")} ${E(a.doc_no)}<div class="acct">${E(ZL.date(a.date))}${a.reference ? ` · ${E(a.reference)}` : ""}</div></td><td class="r">${M(a.amount)}</td></tr>`);
      const left = r2(ZL.num(d.total) - allocs.reduce((s, a) => s + ZL.num(a.amount), 0));
      if (left > 0) rows.push(`<tr><td>${E(d.description || (t.effect === -1 ? "Advance payment / deposit" : "Refund"))}</td><td class="r">${M(left)}</td></tr>`);
      const labels = (ds.sign_labels || []).filter(Boolean).slice(0, 4);
      return shell(ds, `${letterhead(info, ds, ttl, [["No.", d.doc_no || "Draft"], ["Date", ZL.date(d.date)], ["Reference", d.reference]])}
        <div class="zv-party"><div><span>${partyHead}</span><b>${E(d.bill_name || (c && c.name) || "")}</b></div>
          ${t.contra ? `<div><span>Settled by</span><b>Set-off of trade receivables against trade payables</b></div>`
            : `<div><span>${t.effect === -1 && t.side === "AR" || d.doc_type === "SUPPLIER_REFUND" ? "Received into" : "Paid from"}</span><b>${E(bank ? bank.name : "")}</b></div>`}
          <div><span>Payment method</span><b>${E(d.pay_method || "")}</b></div></div>
        <table class="zv-lines"><thead><tr><th>${d.doc_type === "RECEIPT" ? "Being payment for" : "Particulars"}</th><th class="r" style="width:150px">Amount (RM)</th></tr></thead>
          <tbody>${rows.join("") || `<tr><td>${E(d.description || "")}</td><td class="r">${M(d.total)}</td></tr>`}</tbody>
          <tfoot><tr><td>Total</td><td class="r">RM ${M(d.total)}</td></tr></tfoot></table>
        ${ZL.num(d.bank_charge) > 0 ? `<p class="zv-gen" style="color:#5b6070">Bank charges of RM ${M(d.bank_charge)} ${t.effect === -1 && t.side === "AR" || d.doc_type === "SUPPLIER_REFUND" ? "were deducted by the bank" : "were paid on top"}.</p>` : ""}
        <div class="zv-words"><span>Amount in words</span><b>${E(ZL.amountWords(d.total))}</b></div>
        ${labels.length ? `<div class="zv-sign" style="grid-template-columns:repeat(${labels.length},1fr)">${labels.map((l) => `<div>${E(l)}<small>Name / date</small></div>`).join("")}</div>` : ""}
        ${ds.footer ? `<div class="zv-foot">${E(ds.footer)}</div>` : ""}
        <div class="zv-gen">Computer-generated in Zycount.${d.status === "VOID" ? ` Voided on ${E(ZL.date(d.void_date))}: ${E(d.void_reason || "")}.` : ""}</div>`, stamp);
    }
    const taxBy = new Map(taxes.map((x) => [x.id, x]));
    const showDisc = lines.some((l) => ZL.num(l.discount) > 0);
    const showTax = lines.some((l) => ZL.num(l.tax_amount) > 0);
    const sst = {};
    lines.forEach((l) => { if (ZL.num(l.tax_amount)) { const k = (taxBy.get(l.tax_code_id) || {}).name || `SST ${ZL.num(l.tax_rate)}%`; sst[k] = r2((sst[k] || 0) + ZL.num(l.tax_amount)); } });
    const meta = [["No.", d.doc_no || "Draft"], ["Date", ZL.date(d.date)]];
    if (t.effect === 1 && d.due_date) { meta.push(["Terms", d.terms_days != null ? (d.terms_days ? `${d.terms_days} days` : "Cash") : ""]); meta.push(["Due date", ZL.date(d.due_date)]); }
    if (!t.posts && d.due_date) meta.push([d.doc_type === "QUOTATION" ? "Valid until" : "Deliver by", ZL.date(d.due_date)]);
    meta.push([t.side === "AR" ? (d.doc_type === "CREDIT_NOTE" || d.doc_type === "DEBIT_NOTE" ? "Invoice ref." : "Your ref.") : "Supplier ref.", d.reference]);
    const head = t.side === "AR" ? "Bill to" : d.doc_type === "PURCHASE_ORDER" ? "Supplier" : "From supplier";
    const incl = d.tax_inclusive ? " (incl. SST)" : "";
    return shell(ds, `${letterhead(info, ds, ttl, meta)}
      <div class="zv-bill">${billTo(d, c, head)}${d.description ? `<div><span>Subject</span><div>${E(d.description)}</div></div>` : "<div></div>"}</div>
      <table class="zv-lines zv-items"><thead><tr><th style="width:26px">#</th><th>Description</th><th class="r">Qty</th><th class="r">Unit price</th>${showDisc ? '<th class="r">Disc.</th>' : ""}${showTax ? '<th class="r">SST</th>' : ""}<th class="r" style="width:120px">Amount${E(incl)}</th></tr></thead>
        <tbody>${lines.map((l, i) => `<tr><td>${i + 1}</td><td>${E(l.description)}</td>
          <td class="r">${E(String(+ZL.num(l.qty)))}${l.uom ? ` <span class="acct">${E(l.uom)}</span>` : ""}</td><td class="r">${M(l.unit_price)}</td>
          ${showDisc ? `<td class="r">${ZL.num(l.discount) ? M(l.discount) : ""}</td>` : ""}${showTax ? `<td class="r">${ZL.num(l.tax_amount) ? `${M(l.tax_amount)}<div class="acct">${E((taxBy.get(l.tax_code_id) || {}).code || ZL.num(l.tax_rate) + "%")}</div>` : ""}</td>` : ""}
          <td class="r">${M(d.tax_inclusive ? l.total : l.amount)}</td></tr>`).join("")}</tbody></table>
      <table class="zv-sum"><tbody>
        ${showTax ? `<tr><td>Subtotal (excl. SST)</td><td class="r">${M(d.subtotal)}</td></tr>${Object.entries(sst).map(([k, v]) => `<tr><td>${E(k)}</td><td class="r">${M(v)}</td></tr>`).join("")}` : ""}
        <tr class="grand"><td>Total (RM)</td><td class="r">${M(d.total)}</td></tr>
        ${t.effect === 1 && d.status === "POSTED" && ZL.num(d.allocated) > 0 ? `<tr><td>Paid / credited</td><td class="r">(${M(d.allocated)})</td></tr><tr class="grand"><td>Balance due</td><td class="r">${M(outstanding(d))}</td></tr>` : ""}
      </tbody></table>
      <div class="zv-words"><span>Amount in words</span><b>${E(ZL.amountWords(d.total))}</b></div>
      ${d.notes ? `<div class="zv-notes"><span>Notes</span>${E(d.notes)}</div>` : ""}
      ${einvoice}
      ${ds.footer ? `<div class="zv-foot">${E(ds.footer)}</div>` : ""}
      <div class="zv-gen">Computer-generated in Zycount — no signature required.${d.status === "VOID" ? ` Voided on ${E(ZL.date(d.void_date))}: ${E(d.void_reason || "")}.` : ""}</div>`, stamp);
  };

  /** Everything the printed document needs, loaded together. */
  async function docBundle(id) {
    const { doc, lines } = await loadDoc(id);
    const [cs, info, ds, taxes, allocRows, accounts, series] = await Promise.all([
      doc.contact_id ? ZL.select("contacts", "*", (q) => q.eq("id", doc.contact_id)) : Promise.resolve([]),
      ZL.companyInfo(), ZL.docSettings(), taxCodes(),
      ZL.select("trade_allocations", "*", (q) => q.eq("company_id", cid()).or(`from_doc_id.eq.${id},to_doc_id.eq.${id}`)),
      ZL.accounts(),
      doc.series_id ? ZL.select("document_series", "title", (q) => q.eq("id", doc.series_id)) : Promise.resolve([]),
    ]);
    const otherIds = allocRows.map((a) => (a.from_doc_id === id ? a.to_doc_id : a.from_doc_id));
    const others = otherIds.length ? await ZL.select("trade_docs", "id,doc_type,doc_no,date,reference,total,allocated,status",
      (q) => q.in("id", otherIds)) : [];
    const om = new Map(others.map((o) => [o.id, o]));
    const allocs = allocRows.map((a) => { const o = om.get(a.from_doc_id === id ? a.to_doc_id : a.from_doc_id) || {};
      return { id: a.id, amount: a.amount, alloc_date: a.date, other_id: o.id, doc_type: o.doc_type, doc_no: o.doc_no, date: o.date, reference: o.reference }; });
    const einvoice = doc.einvoice_status === "VALID" && ZL.einvoice ? await ZL.einvoice.printBlock(doc).catch(() => "") : "";
    return { doc, lines, contact: cs[0] || null, info, ds, taxes, allocs, accounts, einvoice,
      bank: accounts.find((a) => a.id === doc.money_account_id), title: series[0] && series[0].title };
  }

  // ── Document editor (documents with lines) ───────────────────────────────
  /**
   * Opens the editor for a new document of `type`, or for draft `id`.
   * preset: { contact_id } . Resolves with the saved/posted result, or null.
   */
  ZL.tradeEdit = async (type, id = null, preset = {}) => {
    if (!ZL.can("journal.create")) { ZL.toast("Your role can't create documents in these books.", "bad"); return null; }
    let doc = null, lines = [];
    if (id) { ({ doc, lines } = await loadDoc(id)); type = doc.doc_type; }
    const t = T[type];
    const S = SIDE[t.side];
    const [people, taxes, itemList, accounts, numRows] = await Promise.all([
      contacts(S.kind), taxCodes(), items(), ZL.accounts(), ZL.numbering.load((doc && doc.date) || ZL.today()).catch(() => []),
    ]);
    const liveTax = taxes.filter((x) => x.is_active || lines.some((l) => l.tax_code_id === x.id));
    const liveItems = itemList.filter((i) => i.is_active || lines.some((l) => l.item_id === i.id));
    const money = accounts.filter(isMoney);
    const d = doc || { doc_type: type, date: ZL.today(), contact_id: preset.contact_id || "", tax_inclusive: false, terms_days: null };
    const cById = new Map(people.map((p) => [p.id, p]));
    const defaultAcc = (c) => (c && c.default_account_id) || (t.side === "AR" ? (accounts.find((a) => a.code === "4110" && lineUsable(a)) || {}).id || "" : "");
    const blank = () => { const c = cById.get(sel("contact") || d.contact_id); return { item_id: "", description: "", qty: 1, uom: "", unit_price: "", discount: "", account_id: defaultAcc(c), tax_code_id: (c && c.default_tax_code_id) || "" }; };
    let sel = () => "";
    const rows = lines.length ? lines.map((l) => Object.assign({}, l)) : [];
    const canPost = ZL.can("journal.post");
    const numFields = ZL.numbering.fields(numRows, seriesKind(type), d.money_account_id, { series: d.draft_series_id, no: d.draft_doc_no });
    const f = (n, label, control, cls = "") => `<label class="zl-field ${cls}"><span>${label}</span>${control}</label>`;
    const partyOpts = `<option value="">${t.money ? "Cash customer (walk-in)" : `Choose ${S.who}…`}</option>` +
      people.filter((p) => p.is_active || p.id === d.contact_id).map((p) => opt(p.id, `${p.name} · ${p.code}`, d.contact_id)).join("");
    const body = `
      <div class="zl-dochead">
        ${f("contact", `${S.Who}${t.money ? "" : ' <i aria-hidden="true">*</i>'}`, `<div style="display:flex;gap:6px"><select class="zl-input" name="contact">${partyOpts}</select>
          <button type="button" class="zl-btn sm ghost" data-newc title="New ${S.who}">+ New</button></div>`, "wide")}
        ${f("date", 'Date <i aria-hidden="true">*</i>', `<input class="zl-input" type="date" name="date" value="${E(d.date)}">`)}
        ${t.effect === 1 ? f("terms", "Terms (days)", `<input class="zl-input num" type="number" min="0" max="3650" name="terms" value="${E(d.terms_days != null ? d.terms_days : "")}" placeholder="From ${S.who}">`)
          : !t.posts ? f("due", type === "QUOTATION" ? "Valid until" : "Deliver by", `<input class="zl-input" type="date" name="due" value="${E(d.due_date || ZL.addDays(ZL.today(), 30))}">`) : "<div></div>"}
        ${t.money ? f("money", t.side === "AR" ? "Received into" : "Paid from", `<select class="zl-input" name="money">${money.map((a) => opt(a.id, `${a.name} · ${a.code}`, d.money_account_id)).join("")}</select>`, "wide")
          + f("method", "Paid by", `<select class="zl-input" name="method">${METHODS.map((m) => opt(m, m, d.pay_method || "Cash")).join("")}</select>`) : ""}
        ${t.money && t.side === "AR" ? f("bill_name", "Name on receipt", `<input class="zl-input" name="bill_name" value="${E(d.contact_id ? "" : d.bill_name || "")}" placeholder="Optional, for walk-in customers" maxlength="200">`) : ""}
        ${f("reference", t.side === "AR" ? (type === "CREDIT_NOTE" || type === "DEBIT_NOTE" ? "Invoice no." : "Customer's PO / ref.") : "Supplier's invoice no.",
          `<input class="zl-input" name="reference" value="${E(d.reference || "")}" maxlength="60" placeholder="${t.side === "AP" && t.posts ? "Checked for duplicates" : "Optional"}">`)}
        ${f("description", "Subject", `<input class="zl-input" name="description" value="${E(d.description || "")}" maxlength="500" placeholder="${type === "CREDIT_NOTE" ? "e.g. Goods returned" : "Optional"}">`, "wide")}
        ${numFields.map((x) => `<label class="zl-field"><span>${E(x.label)}</span>${x.type === "select"
          ? `<select class="zl-input" name="${x.name}">${x.options.map((o) => opt(o.value, o.label, x.value)).join("")}</select>`
          : `<input class="zl-input" name="${x.name}" value="${E(x.value)}">`}</label>`).join("")}
      </div>
      <label class="zl-check" style="margin:12px 0 4px"><input type="checkbox" name="incl"${d.tax_inclusive ? " checked" : ""}><span>Prices include SST</span></label>
      <div class="zl-lines-wrap"><table class="zl-lines"><thead><tr>
        <th style="width:130px">Item</th><th style="min-width:240px">Description</th><th style="width:70px" class="r">Qty</th><th style="width:70px">UOM</th>
        <th style="width:105px" class="r">Unit price</th><th style="width:85px" class="r">Discount</th><th style="width:190px">Account</th>
        <th style="width:95px">SST</th><th style="width:105px" class="r">Amount</th><th style="width:30px"></th></tr></thead>
        <tbody id="zl-dl"></tbody></table></div>
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-top:8px">
        <button type="button" class="zl-btn sm ghost" id="zl-dladd">+ Add line</button>
        <div class="zl-totals" id="zl-dtot"></div></div>
      <label class="zl-field" style="margin-top:10px"><span>Notes printed on the ${E(t.label.toLowerCase())}</span>
        <textarea class="zl-input" name="notes" rows="2" maxlength="2000" placeholder="e.g. Payment to Maybank 5123 4567 8901. Thank you for your business.">${E(d.notes || "")}</textarea></label>`;
    const post = async (root, doPost, extra = {}) => {
      root.querySelectorAll("[data-ln]").forEach(readRow);
      const v = (n) => { const el = root.querySelector(`[name="${n}"]`); return el ? el.value.trim() : ""; };
      const pdoc = { doc_type: type, contact_id: v("contact") || null, date: v("date"), reference: v("reference"), description: v("description"),
        notes: v("notes"), tax_inclusive: root.querySelector('[name="incl"]').checked, source_doc_id: d.source_doc_id || null,
        bill_name: v("bill_name") || null, money_account_id: v("money") || null, pay_method: v("method") || null };
      if (t.effect === 1) pdoc.terms_days = v("terms") === "" ? null : Number(v("terms"));
      if (!t.posts) pdoc.due_date = v("due") || null;
      Object.assign(pdoc, extra);
      if (!pdoc.date) throw bad("Choose a date.");
      if (!t.money && !pdoc.contact_id) throw bad(`Choose a ${S.who}.`);
      const plines = rows.filter((l) => l.item_id || String(l.description || "").trim() || ZL.num(l.unit_price)).map((l) => {
        const q = Number(String(l.qty).replace(/,/g, "")), p = ZL.parseAmount(l.unit_price), di = ZL.parseAmount(l.discount);
        if (!(q > 0)) throw bad(`Line "${l.description || "?"}": quantity must be more than zero.`);
        if (Number.isNaN(p) || Number.isNaN(di)) throw bad(`Line "${l.description || "?"}": enter prices like 1,250.00.`);
        return { item_id: l.item_id || null, description: l.description, qty: q, uom: l.uom || null, unit_price: p, discount: di || 0,
          account_id: l.account_id || null, tax_code_id: l.tax_code_id || null };
      });
      if (!plines.length) throw bad("Add at least one line.");
      let num = {};
      try { num = numCtl ? numCtl.read() : {}; } catch (e) { if (doPost) throw e; } // a draft may wait for its number
      return ZL.rpc("save_trade_doc", { p_company: cid(), p_id: doc ? doc.id : null, p_doc: pdoc, p_lines: plines, p_post: doPost,
        p_series: num.p_series || null, p_doc_no: num.p_doc_no || null, p_allocations: null });
    };
    let numCtl = null, result = null, cap = null;
    const finish = async (r, close) => { if (cap) await cap.link("TRADE_DOC", r.id); result = r; close(); };
    const actions = [{ label: "Cancel" },
      { label: "Save draft", onClick: async ({ root, close }) => finish(await post(root, false), close) }];
    if (canPost) actions.push({ label: t.posts ? "Save & post" : "Save & issue", primary: true, onClick: async ({ root, close, setError }) => {
      try { await finish(await post(root, true), close); }
      catch (e) {
        if (e.code !== "CREDIT_LIMIT") throw e;
        setError(e);
        if (await ZL.confirm({ title: "Over the credit limit", message: `${E(e.message)} Post it anyway?`, confirmLabel: "Post anyway" })) await finish(await post(root, true, { allow_over_limit: true }), close);
      }
    } });
    const m = ZL.modal({ title: `${doc ? "Draft" : "New"} ${t.label.toLowerCase()}${doc && d.reference && d.source_doc_id ? ` — from ${d.reference}` : ""}`, wide: true, body, actions,
      onClose: () => { if (result) { const r = result; ZL.toast(r.status === "POSTED" ? `${t.label} ${r.doc_no} ${t.posts ? "posted" : "issued"}${r.reference ? ` (${r.reference})` : ""}.` : "Draft saved."); ZL.open("tradedoc", { id: r.id }); } } });
    const root = m.root;
    root.querySelector(".zl-modal").classList.add("xl");
    sel = (n) => { const el = root.querySelector(`[name="${n}"]`); return el ? el.value : ""; };
    const tb = root.querySelector("#zl-dl");
    const itemById = new Map(liveItems.map((i) => [i.id, i]));
    const taxById = new Map(liveTax.map((x) => [x.id, x]));
    // Amounts come back from the inputs as typed text ("1,500.00"); show them tidied, keep anything unreadable as typed.
    const shown = (v) => { if (v === "" || v == null) return ""; const n = typeof v === "number" ? v : ZL.parseAmount(v); return Number.isNaN(n) ? String(v) : M(n); };
    const rowHtml = (l, i) => `<tr data-ln="${i}">
      <td><select class="zl-input" data-f="item_id" aria-label="Item"><option value="">—</option>${liveItems.map((it) => opt(it.id, it.code, l.item_id)).join("")}</select></td>
      <td><input class="zl-input" data-f="description" value="${E(l.description || "")}" maxlength="500" aria-label="Description"></td>
      <td><input class="zl-input num r" data-f="qty" value="${E(l.qty == null ? 1 : +l.qty)}" inputmode="decimal" aria-label="Quantity"></td>
      <td><input class="zl-input" data-f="uom" value="${E(l.uom || "")}" maxlength="20" aria-label="Unit"></td>
      <td><input class="zl-input num r" data-f="unit_price" value="${E(shown(l.unit_price))}" inputmode="decimal" placeholder="0.00" aria-label="Unit price"></td>
      <td><input class="zl-input num r" data-f="discount" value="${E(ZL.parseAmount(l.discount) ? shown(l.discount) : "")}" inputmode="decimal" placeholder="0.00" aria-label="Discount"></td>
      <td><select class="zl-input" data-f="account_id" aria-label="Account">${accOptions(accounts, t.side, l.account_id, t.posts ? "Choose account…" : "—")}</select></td>
      <td><select class="zl-input" data-f="tax_code_id" aria-label="SST"><option value="">None</option>${liveTax.map((x) => opt(x.id, `${x.code} ${+x.rate}%`, l.tax_code_id)).join("")}</select></td>
      <td class="amt" data-amt></td>
      <td><button type="button" class="zl-x" data-del aria-label="Remove line">×</button></td></tr>`;
    function readRow(tr) {
      const l = rows[Number(tr.dataset.ln)];
      tr.querySelectorAll("[data-f]").forEach((el) => { l[el.dataset.f] = el.value.trim(); });
    }
    const calc = (l, incl) => {
      const q = Number(String(l.qty).replace(/,/g, "")) || 0, p = ZL.parseAmount(l.unit_price) || 0, di = ZL.parseAmount(l.discount) || 0;
      const amt = r2(r2(q * p) - di);
      const rate = ZL.num((taxById.get(l.tax_code_id) || {}).rate);
      if (!rate) return { net: amt, tax: 0, tot: amt };
      const tax = incl ? r2((amt * rate) / (100 + rate)) : r2((amt * rate) / 100);
      return incl ? { net: r2(amt - tax), tax, tot: amt } : { net: amt, tax, tot: r2(amt + tax) };
    };
    const draw = () => {
      tb.innerHTML = rows.map(rowHtml).join("");
      totals();
    };
    const totals = () => {
      const incl = root.querySelector('[name="incl"]').checked;
      let net = 0, tax = 0, tot = 0;
      tb.querySelectorAll("[data-ln]").forEach((tr) => {
        const c = calc(rows[Number(tr.dataset.ln)], incl);
        net += ZL.cents(c.net); tax += ZL.cents(c.tax); tot += ZL.cents(c.tot);
        tr.querySelector("[data-amt]").textContent = M(incl ? c.tot : c.net);
      });
      root.querySelector("#zl-dtot").innerHTML = `${tax ? `<span>Subtotal</span><b>${M(net / 100)}</b><span>SST</span><b>${M(tax / 100)}</b>` : ""}
        <span class="grand">Total</span><b class="grand">RM ${M(tot / 100)}</b>`;
    };
    tb.addEventListener("input", (ev) => { const tr = ev.target.closest("[data-ln]"); if (tr) { readRow(tr); totals(); } });
    tb.addEventListener("change", (ev) => {
      const tr = ev.target.closest("[data-ln]");
      if (!tr) return;
      readRow(tr);
      const l = rows[Number(tr.dataset.ln)];
      if (ev.target.dataset.f === "item_id" && l.item_id) {
        const it = itemById.get(l.item_id);
        Object.assign(l, { description: it.description, uom: it.uom, unit_price: t.side === "AR" ? it.sell_price : it.buy_price,
          account_id: (t.side === "AR" ? it.sales_account_id : it.purchase_account_id) || l.account_id,
          tax_code_id: (t.side === "AR" ? it.sales_tax_code_id : it.purchase_tax_code_id) || l.tax_code_id });
        const i = Number(tr.dataset.ln);
        tr.outerHTML = rowHtml(l, i);
      }
      if (ev.target.dataset.f === "unit_price" || ev.target.dataset.f === "discount") {
        const v = ZL.parseAmount(ev.target.value);
        if (!Number.isNaN(v) && ev.target.value) ev.target.value = M(v);
      }
      totals();
    });
    tb.addEventListener("click", (ev) => {
      const del = ev.target.closest("[data-del]");
      if (!del) return;
      tb.querySelectorAll("[data-ln]").forEach(readRow);
      rows.splice(Number(del.closest("[data-ln]").dataset.ln), 1);
      if (!rows.length) rows.push(blank());
      draw();
    });
    root.querySelector("#zl-dladd").addEventListener("click", () => { tb.querySelectorAll("[data-ln]").forEach(readRow); rows.push(blank()); draw();
      const last = tb.querySelector("[data-ln]:last-child [data-f=description]"); if (last) last.focus(); });
    root.querySelector('[name="incl"]').addEventListener("change", totals);
    const cSel = root.querySelector('[name="contact"]');
    cSel.addEventListener("change", () => {
      const c = cById.get(cSel.value);
      tb.querySelectorAll("[data-ln]").forEach(readRow);
      rows.forEach((l) => { if (!l.account_id && c && c.default_account_id) l.account_id = c.default_account_id; if (!l.tax_code_id && c && c.default_tax_code_id) l.tax_code_id = c.default_tax_code_id; });
      const terms = root.querySelector('[name="terms"]');
      if (terms && c) terms.placeholder = `${c.terms_days} days`;
      draw();
    });
    const newContact = async (preset) => {
      const id2 = await ZL.editContact(S.kind, null, { stay: true, preset });
      if (!id2) return null;
      const fresh = await contacts(S.kind);
      fresh.forEach((p) => cById.set(p.id, p));
      const p = cById.get(id2);
      cSel.insertAdjacentHTML("beforeend", opt(p.id, `${p.name} · ${p.code}`, p.id));
      cSel.value = p.id;
      cSel.dispatchEvent(new Event("change"));
      return p;
    };
    root.querySelector("[data-newc]").addEventListener("click", () => newContact());
    if (!rows.length) { rows.push(blank()); rows.push(blank()); }
    draw();
    numCtl = numFields.length ? ZL.numbering.wire(root, numRows, seriesKind(type), { dateInput: root.querySelector('[name="date"]'),
      moneyInput: root.querySelector('[name="money"]'), money: () => sel("money"), autoHint: "Given when you post.",
      initial: d.draft_doc_no || null, series: d.draft_series_id || null }) : null;
    if (numCtl && !canPost) root.querySelectorAll('[name="series"],[name="doc_no"]').forEach((el) => { el.closest("label").hidden = true; });

    // A photo or PDF of the document: read it into the form, keep it with the entry.
    if (ZL.capture && !(doc && doc.status !== "DRAFT")) {
      const C = ZL.capture;
      cap = C.evidence(m, { preset: preset.attachment, fill: async (s, att, ev) => {
        const c = C.matchContact(s.counterparty, people);
        if (c) C.put(root, "contact", c.id);
        else if (s.counterparty && s.counterparty.name) {
          ev.note(`<b>${E(s.counterparty.name)}</b> isn't one of your ${S.who}s yet. <button type="button" class="zl-ref" data-x>Add as ${S.who}</button>`, "",
            { "[data-x]": async () => !!(await newContact(C.contactFrom(s))) });
        }
        C.put(root, "date", s.date);
        if (t.side === "AP") C.put(root, "reference", s.doc_no);
        C.put(root, "description", s.summary);
        if (t.effect === 1 && s.date && s.due_date && s.due_date >= s.date) C.put(root, "terms", String(days(s.date, s.due_date)));
        if (t.money) { C.put(root, "method", C.methodFor(s)); C.put(root, "money", C.moneyFor(s, money)); }
        tb.querySelectorAll("[data-ln]").forEach(readRow);
        const acc = await C.accountFor(s, accounts, { contact: c, direction: t.side === "AR" ? "IN" : "OUT", usable: lineUsable });
        const taxId = C.taxFor(s, liveTax);
        const got = C.linesOf(s, { taxCode: !!taxId });
        if (got.lines.length) {
          rows.length = 0;
          got.lines.forEach((l) => {
            const q = l.quantity > 0 ? l.quantity : 1;
            const price = l.unit_price != null && Math.abs(l.unit_price * q - l.amount) <= 0.05 ? l.unit_price : r2(l.amount / q);
            rows.push({ item_id: "", description: (l.description || s.summary || "").slice(0, 500), qty: q, uom: "", unit_price: price, discount: "",
              account_id: acc, tax_code_id: l.tax_rate === 0 || got.noTax ? "" : taxId });
          });
          if (s.discount && got.discountOnLast) rows[rows.length - 1].discount = s.discount;
          root.querySelector('[name="incl"]').checked = got.inclusive;
          draw();
        }
        const incl = root.querySelector('[name="incl"]').checked;
        const sum = rows.reduce((a, l) => a + ZL.cents(calc(l, incl).tot), 0) / 100;
        if (s.total != null && Math.abs(sum - s.total) > 0.05) {
          ev.note(`The document's total is <b>RM ${M(s.total)}</b>; the lines here come to RM ${M(sum)}. Adjust a line, the SST or the rounding before you post.`, "warn");
        }
        if (s.tax_total > 0 && !taxId) ev.note(`SST of RM ${M(s.tax_total)} is shown but no tax code has that rate, so it's kept in the line amounts.`, "warn");
        if (!acc && t.posts) ev.note(`Choose the ${t.side === "AP" ? "expense" : "income"} account on each line.`);
      } });
    }
    return null;
  };

  // ── Receipts, payments and refunds (with knock-off) ──────────────────────
  ZL.tradePay = async (type, preset = {}) => {
    if (!(ZL.can("journal.create") && ZL.can("journal.post"))) { ZL.toast("Your role can't record payments in these books.", "bad"); return null; }
    const t = T[type], S = SIDE[t.side];
    const [people, accounts, numRows] = await Promise.all([contacts(S.kind), ZL.accounts(), ZL.numbering.load(ZL.today()).catch(() => [])]);
    const money = accounts.filter(isMoney);
    if (!money.length) { ZL.toast("Create a bank or cash account first.", "bad"); return null; }
    const prefKey = `zl.money.${cid()}`;
    let last = null;
    try { last = localStorage.getItem(prefKey); } catch (_) { /* ignore */ }
    // A bank statement line fixes the date, amount and account; the receipt is matched to it.
    const BL = preset.bankLine || null;
    const bank = BL ? BL.account_id : (money.find((a) => a.id === last) || money.find((a) => a.code === "1131") || money[0]).id;
    const numFields = ZL.numbering.fields(numRows, seriesKind(type), bank);
    const inward = type === "RECEIPT" || type === "SUPPLIER_REFUND";
    const f = (label, control, cls = "") => `<label class="zl-field ${cls}"><span>${label}</span>${control}</label>`;
    const body = `
      ${BL ? `<p class="hint" style="margin:0 0 10px">From the bank statement: ${ZL.date(BL.date)} · <b>RM ${M(preset.amount)}</b> — ${E(BL.description || "")}. Posting matches it to this line.${inward ? " If the bank took a charge, enter it; the receipt is for the amount before charges." : ""}</p>` : ""}
      <div class="zl-dochead">
        ${f(`${S.Who} <i aria-hidden="true">*</i>`, `<select class="zl-input" name="contact"><option value="">Choose ${S.who}…</option>${people.filter((p) => p.is_active).map((p) => opt(p.id, `${p.name} · ${p.code}`, preset.contact_id)).join("")}</select>`, "wide")}
        ${f('Date <i aria-hidden="true">*</i>', `<input class="zl-input" type="date" name="date" value="${E(BL ? BL.date : ZL.today())}"${BL ? " disabled" : ""}>`)}
        ${f('Amount <i aria-hidden="true">*</i>', `<div class="zl-amount"><span>RM</span><input class="zl-input num" name="amount" inputmode="decimal" placeholder="0.00" value="${E(preset.amount ? M(preset.amount) : "")}"${BL ? " disabled" : ""}></div>`)}
        ${f(inward ? "Received into" : "Paid from", `<select class="zl-input" name="money"${BL ? " disabled" : ""}>${money.map((a) => opt(a.id, `${a.name} · ${a.code}`, bank)).join("")}</select>`, "wide")}
        ${f(inward ? "Received by" : "Paid by", `<select class="zl-input" name="method">${METHODS.map((m) => opt(m, m, "Bank transfer")).join("")}</select>`)}
        ${f("Bank charges", `<div class="zl-amount"><span>RM</span><input class="zl-input num" name="charge" inputmode="decimal" placeholder="0.00"></div>`)}
        ${f("Cheque / reference no.", `<input class="zl-input" name="reference" maxlength="60" placeholder="Optional" value="${E(BL && BL.reference ? BL.reference.slice(0, 60) : "")}"${BL ? " disabled" : ""}>`)}
        ${f("Description", `<input class="zl-input" name="description" maxlength="500" placeholder="Optional" value="${E(BL && BL.description ? BL.description.slice(0, 500) : "")}">`, "wide")}
        ${numFields.map((x) => `<label class="zl-field"><span>${E(x.label)}</span>${x.type === "select"
          ? `<select class="zl-input" name="${x.name}">${x.options.map((o) => opt(o.value, o.label, x.value)).join("")}</select>`
          : `<input class="zl-input" name="${x.name}" value="${E(x.value)}">`}</label>`).join("")}
      </div>
      <div class="zl-sec-h" style="padding:14px 0 6px"><h3 style="font-size:14px">${t.effect === -1 ? `Knock off against ${t.side === "AR" ? "invoices and debit notes" : "purchase invoices and debit notes"}` : "Settles"}</h3>
        <button type="button" class="zl-btn sm ghost" id="zl-auto">Apply oldest first</button></div>
      <div id="zl-open" class="zl-lines-wrap"></div>
      <div class="zl-totals" id="zl-ptot" style="margin-top:8px"></div>`;
    let open = [], result = null, capEv = null;
    const m = ZL.modal({ title: t.effect === -1 ? (t.side === "AR" ? "Receive payment" : "Pay supplier") : `Record ${t.label.toLowerCase()}`, wide: true, body,
      actions: [{ label: "Cancel" }, { label: `Post ${t.label.toLowerCase()}`, primary: true, onClick: async ({ root, close }) => {
        const v = (n) => root.querySelector(`[name="${n}"]`).value.trim();
        const amount = ZL.parseAmount(v("amount")), charge = ZL.parseAmount(v("charge"));
        if (!v("contact")) throw bad(`Choose a ${S.who}.`);
        if (Number.isNaN(amount) || !amount) throw bad("Enter the amount.");
        if (Number.isNaN(charge)) throw bad("Bank charges: enter a number like 1.00.");
        const allocs = [...root.querySelectorAll("[data-apply]")].map((inp) => ({ doc_id: inp.dataset.apply, amount: ZL.parseAmount(inp.value) }))
          .filter((a) => a.amount);
        if (allocs.some((a) => Number.isNaN(a.amount))) throw bad("Knock-off amounts must be numbers.");
        const applied = allocs.reduce((s, a) => s + ZL.cents(a.amount), 0);
        const cap = ZL.cents(amount) + (BL ? (inward ? 1 : -1) * ZL.cents(charge || 0) : 0);
        if (applied > cap) throw bad(`You applied ${M(applied / 100)}, more than the ${M(cap / 100)} ${inward ? "received" : "paid"}.`);
        const num = numCtl ? numCtl.read() : {};
        if (BL) {
          const r = await ZL.rpc("settle_from_bank_line", { p_line: BL.id, p_contact: v("contact"), p_allocations: allocs, p_bank_charge: charge || 0,
            p_series: num.p_series || null, p_doc_no: num.p_doc_no || null, p_description: v("description") || null });
          if (capEv) await capEv.link("TRADE_DOC", r.id);
          result = r; close();
          return;
        }
        const r = await ZL.rpc("save_trade_doc", { p_company: cid(), p_id: null, p_doc: { doc_type: type, contact_id: v("contact"), date: v("date"),
          amount, bank_charge: charge || 0, money_account_id: v("money"), pay_method: v("method"), reference: v("reference"), description: v("description") },
          p_lines: [], p_post: true, p_series: num.p_series || null, p_doc_no: num.p_doc_no || null, p_allocations: allocs });
        try { localStorage.setItem(prefKey, v("money")); } catch (_) { /* ignore */ }
        if (capEv) await capEv.link("TRADE_DOC", r.id);
        result = r; close();
      } }],
      onClose: () => {
        if (preset.onDone) { preset.onDone(result); return; }
        if (result) { ZL.toast(`${t.label} ${result.doc_no} posted (${result.reference}).`); ZL.open("tradedoc", { id: result.id }); }
      } });
    const root = m.root;
    const numCtl = numFields.length ? ZL.numbering.wire(root, numRows, seriesKind(type), { dateInput: root.querySelector('[name="date"]'),
      moneyInput: root.querySelector('[name="money"]'), money: () => root.querySelector('[name="money"]').value }) : null;
    const want = -t.effect; // receipts settle charges (+1); refunds settle credits (−1)
    const amountInp = root.querySelector('[name="amount"]');
    const chargeInp = root.querySelector('[name="charge"]');
    // On a bank line the amount is what hit the bank; charges sit on top of a receipt and come out of a payment.
    const usable = () => ZL.cents(ZL.parseAmount(amountInp.value) || 0) + (BL ? (inward ? 1 : -1) * ZL.cents(ZL.parseAmount(chargeInp.value) || 0) : 0);
    const tot = () => {
      const amt = usable() / 100;
      const applied = [...root.querySelectorAll("[data-apply]")].reduce((s, i) => s + ZL.cents(ZL.parseAmount(i.value) || 0), 0) / 100;
      const left = r2(amt - applied);
      root.querySelector("#zl-ptot").innerHTML = `<span>Applied</span><b>${M(applied)}</b>
        <span>${left < 0 ? "Over-applied" : t.effect === -1 ? "Left as advance / deposit" : "Not matched"}</span><b style="${left < 0 ? "color:var(--bad)" : ""}">${M(left)}</b>`;
    };
    const drawOpen = () => {
      const box = root.querySelector("#zl-open");
      const list = open.filter((o) => o.effect === want);
      box.innerHTML = list.length ? `<table class="zl-lines" style="min-width:560px"><thead><tr><th>Document</th><th>Date</th><th>Due</th><th class="r">Total</th><th class="r">Open</th><th class="r" style="width:130px">Apply</th></tr></thead>
        <tbody>${list.map((o) => `<tr><td><b>${E(o.doc_no)}</b> <span class="hint">${E(T[o.doc_type].label)}</span>${o.reference ? `<div class="hint">${E(o.reference)}</div>` : ""}</td>
          <td class="nil">${ZL.date(o.date)}</td><td class="nil">${o.due_date ? ZL.date(o.due_date) : "—"}${o.due_date && o.due_date < ZL.today() ? ' <span class="chip bad">Overdue</span>' : ""}</td>
          <td class="amt">${M(o.total)}</td><td class="amt">${M(o.outstanding)}</td>
          <td><input class="zl-input num r" data-apply="${o.id}" data-max="${o.outstanding}" inputmode="decimal" placeholder="0.00" value="${E(preset.apply && preset.apply[o.id] ? M(preset.apply[o.id]) : "")}"></td></tr>`).join("")}</tbody></table>`
        : `<p class="nil" style="padding:12px">${root.querySelector('[name="contact"]').value ? `Nothing open for this ${S.who}.${t.effect === -1 ? " The whole amount is kept as an advance to apply later." : ""}` : `Choose a ${S.who} to see what's open.`}</p>`;
      tot();
    };
    const loadOpen = async () => {
      const c = root.querySelector('[name="contact"]').value;
      open = c ? await ZL.rpc("trade_open_docs", { p_contact: c }).catch(() => []) : [];
      drawOpen();
    };
    root.querySelector('[name="contact"]').addEventListener("change", () => { preset.apply = null; loadOpen(); });
    root.querySelector("#zl-open").addEventListener("input", tot);
    root.querySelector("#zl-open").addEventListener("change", (ev) => { const v = ZL.parseAmount(ev.target.value); if (!Number.isNaN(v) && ev.target.value) ev.target.value = M(v); tot(); });
    amountInp.addEventListener("input", tot);
    amountInp.addEventListener("blur", () => { const v = ZL.parseAmount(amountInp.value); if (!Number.isNaN(v) && v) amountInp.value = M(v); });
    root.querySelector("#zl-auto").addEventListener("click", () => {
      let left = usable();
      const inputs = [...root.querySelectorAll("[data-apply]")];
      if (!left) { // no amount yet: settle everything and make that the amount
        inputs.forEach((i) => { i.value = M(i.dataset.max); left += ZL.cents(i.dataset.max); });
        amountInp.value = M(left / 100);
      } else inputs.forEach((i) => { const take = Math.min(left, ZL.cents(i.dataset.max)); i.value = take ? M(take / 100) : ""; left -= take; });
      tot();
    });
    chargeInp.addEventListener("input", tot);
    await loadOpen();
    if (preset.autoApply) root.querySelector("#zl-auto").click();

    // A payment slip, transfer screenshot or cheque: read it, knock off what it names.
    if (ZL.capture) {
      const C = ZL.capture;
      const cSel = root.querySelector('[name="contact"]');
      const choose = async (c) => { C.put(root, "contact", c.id, { silent: true }); preset.apply = null; await loadOpen(); };
      capEv = C.evidence(m, { preset: preset.attachment, fill: async (s, att, ev) => {
        const c = C.matchContact(s.counterparty, people);
        if (c) await choose(c);
        else if (s.counterparty && s.counterparty.name) {
          ev.note(`<b>${E(s.counterparty.name)}</b> isn't one of your ${S.who}s yet. <button type="button" class="zl-ref" data-x>Add as ${S.who}</button>`, "", { "[data-x]": async () => {
            const id2 = await ZL.editContact(S.kind, null, { stay: true, preset: C.contactFrom(s) });
            if (!id2) return false;
            const [p] = await ZL.select("contacts", "*", (q) => q.eq("id", id2));
            people.push(p);
            cSel.insertAdjacentHTML("beforeend", opt(p.id, `${p.name} · ${p.code}`, p.id));
            await choose(p);
            return true;
          } });
        }
        if (!BL) { // a bank line already fixes these
          C.put(root, "date", s.date);
          if (s.total != null) C.put(root, "amount", M(Math.abs(s.total)));
          C.put(root, "money", C.moneyFor(s, money));
          C.put(root, "reference", (s.payment_reference || s.doc_no || "").slice(0, 60));
        }
        C.put(root, "method", C.methodFor(s));
        C.put(root, "description", s.summary);
        const want = (s.references_paid || []).map((x) => String(x).toUpperCase().replace(/[^A-Z0-9]/g, "")).filter(Boolean);
        const key = (x) => String(x || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        const inputs = [...root.querySelectorAll("[data-apply]")];
        const named = inputs.filter((i) => { const o = open.find((x) => x.id === i.dataset.apply); return o && want.some((w) => w === key(o.doc_no) || w === key(o.reference)); });
        if (named.length) {
          let left = ZL.cents(ZL.parseAmount(amountInp.value) || 0);
          inputs.forEach((i) => { i.value = ""; });
          named.forEach((i) => { const take = Math.min(left, ZL.cents(i.dataset.max)); i.value = take ? M(take / 100) : ""; left -= take; if (take) i.classList.add("zl-filled"); });
          ev.note(`Knocked off ${named.map((i) => E((open.find((x) => x.id === i.dataset.apply) || {}).doc_no)).join(", ")} — named on the ${s.document_type === "CHEQUE" ? "cheque" : "slip"}.`, "ok");
        } else if (inputs.length && ZL.parseAmount(amountInp.value)) {
          root.querySelector("#zl-auto").click();
          if (want.length) ev.note(`The document mentions ${want.map(E).join(", ")}, which isn't open for this ${S.who}. Applied oldest first — check the knock-off.`, "warn");
        }
        tot();
      } });
    }
    return null;
  };

  /** Knock off an already-posted receipt, payment or credit note. */
  async function knockOff(b) {
    const d = b.doc, t = T[d.doc_type];
    const open = (await ZL.rpc("trade_open_docs", { p_contact: d.contact_id })).filter((o) => o.effect === -t.effect && o.id !== d.id);
    const avail = outstanding(d);
    if (!open.length) { ZL.toast(`Nothing open to knock off for ${d.bill_name || "this contact"}.`, "warn"); return; }
    ZL.modal({ title: `Knock off ${d.doc_no}`, wide: true,
      body: `<p class="zl-p">${M(avail, { symbol: true })} of ${E(d.doc_no)} is not yet applied.</p>
        <div class="zl-lines-wrap"><table class="zl-lines" style="min-width:520px"><thead><tr><th>Document</th><th>Date</th><th>Due</th><th class="r">Open</th><th class="r" style="width:130px">Apply</th></tr></thead>
        <tbody>${open.map((o) => `<tr><td><b>${E(o.doc_no)}</b> <span class="hint">${E(T[o.doc_type].label)}</span></td><td class="nil">${ZL.date(o.date)}</td>
          <td class="nil">${o.due_date ? ZL.date(o.due_date) : "—"}</td><td class="amt">${M(o.outstanding)}</td>
          <td><input class="zl-input num r" data-apply="${o.id}" data-max="${o.outstanding}" inputmode="decimal" placeholder="0.00"></td></tr>`).join("")}</tbody></table></div>`,
      actions: [{ label: "Cancel" }, { label: "Apply", primary: true, onClick: async ({ root, close }) => {
        const items2 = [...root.querySelectorAll("[data-apply]")].map((i) => ({ doc_id: i.dataset.apply, amount: ZL.parseAmount(i.value) })).filter((x) => x.amount);
        if (!items2.length) throw bad("Enter an amount to apply.");
        if (items2.some((x) => Number.isNaN(x.amount))) throw bad("Amounts must be numbers.");
        await ZL.rpc("allocate_trade_doc", { p_doc: d.id, p_items: items2 });
        close(); ZL.toast("Knocked off."); ZL.refresh();
      } }] });
  }

  // ── Document page ────────────────────────────────────────────────────────
  ZL.register("tradedoc", {
    title: "Document",
    perm: "journal.view",
    detail: true,
    get nav() { return (ZL.params && ZL.params.side) === "AP" ? "purchases" : "sales"; },
    async render(ctx) {
      const b = await docBundle(ctx.params.id);
      ctx.params.side = T[b.doc.doc_type].side;
      ctx.bundle = b;
      const d = b.doc, t = T[d.doc_type], S = SIDE[t.side];
      const html = ZL.tradeDocHtml(b);
      const can = (p) => ZL.can(p);
      const btn = (attr, label, cls = "") => `<button type="button" class="zl-btn ${cls}" ${attr}>${label}</button>`;
      const acts = [];
      if (d.status === "DRAFT") {
        if (can("journal.create")) acts.push(btn("data-edit", "Edit"));
        if (can("journal.delete")) acts.push(btn("data-del", "Delete draft", "ghost"));
      } else {
        acts.push(btn("data-print", "Print", "ghost"), btn("data-pdf", "Download PDF"));
        if (d.status === "POSTED") {
          if (t.effect === 1 && outstanding(d) > 0 && d.doc_type !== "REFUND" && d.doc_type !== "SUPPLIER_REFUND" && can("journal.post"))
            acts.push(btn("data-pay", t.side === "AR" ? "Receive payment" : "Pay", "primary"));
          if (t.effect === -1 && outstanding(d) > 0 && can("journal.post")) acts.push(btn("data-knock", "Knock off"));
          (CONVERT[d.doc_type] || []).forEach(([to, l]) => { if (can("journal.create")) acts.push(btn(`data-conv="${to}"`, l, d.doc_type === "QUOTATION" || d.doc_type === "PURCHASE_ORDER" ? "primary" : "")); });
          if (can(t.posts ? "journal.reverse" : "journal.create")) acts.push(btn("data-void", "Void", "ghost"));
        }
      }
      if (t.lines && can("journal.create")) acts.push(btn("data-copy", "Copy", "ghost"));
      const converted = ZL.select("trade_docs", "id,doc_no,doc_type,status", (q) => q.eq("company_id", cid()).eq("source_doc_id", d.id));
      const src = d.source_doc_id ? await ZL.select("trade_docs", "id,doc_no,doc_type", (q) => q.eq("id", d.source_doc_id)) : [];
      const conv = await converted;
      const facts = [
        [S.Who, b.contact ? `<button type="button" class="zl-ref" data-contact="${b.contact.id}">${E(b.contact.name)}</button>` : E(d.bill_name || "Cash customer")],
        ["Total", `RM ${M(d.total)}`],
        ...(t.posts && t.effect !== 0 && d.status === "POSTED" ? [[t.effect === 1 ? "Balance due" : "Not yet applied", `RM ${M(outstanding(d))}`]] : []),
        ...(d.due_date ? [[t.posts ? "Due" : d.doc_type === "QUOTATION" ? "Valid until" : "Deliver by", ZL.date(d.due_date)]] : []),
        ...(d.journal_entry_id ? [["Journal", `<button type="button" class="zl-ref" data-open-journal="${d.journal_entry_id}">Open journal</button>${d.void_entry_id ? ` · <button type="button" class="zl-ref" data-open-journal="${d.void_entry_id}">Reversal</button>` : ""}`]] : []),
        ...(src[0] ? [[t.contra ? (t.side === "AR" ? "Supplier side" : "Customer side") : "From", `<button type="button" class="zl-ref" data-doc="${src[0].id}">${E(T[src[0].doc_type].label)} ${E(src[0].doc_no)}</button>`]] : []),
        ...(conv.length && !t.contra ? [["Turned into", conv.map((c) => `<button type="button" class="zl-ref" data-doc="${c.id}">${E(c.doc_no || "Draft " + T[c.doc_type].label.toLowerCase())}</button>${c.status === "VOID" ? " (void)" : ""}`).join(", ")]] : []),
      ];
      const allocTable = b.allocs.length ? `<section class="card" style="margin-top:16px"><div class="zl-sec-h"><h3>${t.effect === -1 ? "Applied to" : "Paid / credited by"}</h3></div>
        <div class="tablewrap"><table><thead><tr><th>Document</th><th>Date</th><th class="r">Amount</th><th></th></tr></thead>
        <tbody>${b.allocs.map((a) => `<tr><td><button type="button" class="zl-ref" data-doc="${a.other_id}">${E(a.doc_no)}</button> <span class="hint">${E((T[a.doc_type] || {}).label || "")}</span></td>
          <td class="nil">${ZL.date(a.alloc_date)}</td><td class="r num">${M(a.amount)}</td>
          <td class="r">${d.status === "POSTED" && ZL.can("journal.post") ? `<button type="button" class="zl-btn sm ghost" data-unalloc="${a.id}">Remove</button>` : ""}</td></tr>`).join("")}</tbody></table></div></section>` : "";
      return `<div class="zl-crumbs"><button type="button" class="zl-ref" data-back>${t.side === "AR" ? "Sales" : "Purchases"}</button> / ${E(t.label)}</div>` +
        ZL.header(`${b.title || t.label} ${d.doc_no || "(draft)"}`, d.status === "VOID" ? `Voided ${ZL.date(d.void_date)} — ${d.void_reason || ""}` : d.status === "DRAFT" ? "Draft — not in the books until you post it." : `${t.posts ? "Posted" : "Issued"} ${ZL.dateTime(d.posted_at)}`,
          acts.join("")) + `
        <section class="card"><div class="zl-facts">${facts.map(([k, v]) => `<div><span>${E(k)}</span><b>${v}</b></div>`).join("")}<div><span>Status</span><b>${statusChip(d)}</b></div></div></section>
        <div data-einv></div>
        <div class="zl-vwrap" style="margin-top:16px;max-height:none">${html}</div>${allocTable}<div data-attach></div>`;
    },
    after(root, ctx) {
      const b = ctx.bundle;
      if (!b) return;
      const d = b.doc, t = T[d.doc_type];
      const html = () => ZL.tradeDocHtml(b);
      const on = (sel, fn) => root.querySelectorAll(sel).forEach((el) => el.addEventListener("click", () => fn(el)));
      on("[data-back]", () => go(SIDE[t.side].route));
      on("[data-edit]", () => (t.lines ? ZL.tradeEdit(d.doc_type, d.id) : null));
      on("[data-del]", async () => {
        if (!(await ZL.confirm({ title: "Delete this draft?", message: "It was never posted, so nothing in the books changes.", confirmLabel: "Delete", danger: true }))) return;
        try { await ZL.rpc("delete_trade_doc", { p_id: d.id }); ZL.toast("Draft deleted."); go(SIDE[t.side].route); } catch (e) { ZL.toast(ZL.errorText(e), "bad"); }
      });
      on("[data-print]", () => ZL.voucherPrint(html(), d.doc_no));
      on("[data-pdf]", async (el) => { el.disabled = true; try { await ZL.voucherPdf(html(), `${d.doc_no}.pdf`); ZL.toast(`Saved ${d.doc_no}.pdf.`); } catch (e) { ZL.toast(ZL.errorText(e), "bad"); } finally { el.disabled = false; } });
      on("[data-pay]", () => ZL.tradePay(SIDE[t.side].pay, { contact_id: d.contact_id, amount: outstanding(d), apply: { [d.id]: outstanding(d) } }));
      on("[data-knock]", () => knockOff(b));
      on("[data-copy]", async () => { try { const id = await ZL.rpc("copy_trade_doc", { p_id: d.id, p_to_type: d.doc_type }); ZL.tradeEdit(d.doc_type, id); } catch (e) { ZL.toast(ZL.errorText(e), "bad"); } });
      on("[data-conv]", async (el) => { try { const id = await ZL.rpc("copy_trade_doc", { p_id: d.id, p_to_type: el.dataset.conv }); ZL.tradeEdit(el.dataset.conv, id); } catch (e) { ZL.toast(ZL.errorText(e), "bad"); } });
      on("[data-void]", () => ZL.form({
        title: `Void ${d.doc_no}?`, danger: true, confirmLabel: "Void",
        intro: t.posts ? `Its journal is reversed on the date you choose${b.allocs.length ? " and its knock-offs are removed" : ""}. The number stays used and the document stays on file, marked VOID.` : "It stays on file, marked VOID.",
        fields: [{ name: "date", label: "Void date", type: "date", value: ZL.today() > d.date ? ZL.today() : d.date, required: true },
          { name: "reason", label: "Reason", required: true, placeholder: t.effect === -1 ? "e.g. Cheque bounced" : "e.g. Issued to the wrong customer" }],
        submit: (v) => ZL.rpc("void_trade_doc", { p_id: d.id, p_date: v.date, p_reason: v.reason }),
      }).then((r) => { if (r) { ZL.toast(`${d.doc_no} voided.`); ZL.refresh(); } }));
      on("[data-unalloc]", async (el) => {
        if (!(await ZL.confirm({ title: "Remove this knock-off?", message: "Both documents become open again. Nothing in the ledger changes.", confirmLabel: "Remove" }))) return;
        try { await ZL.rpc("unallocate_trade", { p_id: el.dataset.unalloc }); ZL.toast("Knock-off removed."); ZL.refresh(); } catch (e) { ZL.toast(ZL.errorText(e), "bad"); }
      });
      on("[data-doc]", (el) => ZL.open("tradedoc", { id: el.dataset.doc }));
      on("[data-contact]", (el) => ZL.open("contact", { id: el.dataset.contact }));
      ZL.wireJournalLinks(root);
      if (ZL.capture) ZL.capture.panel(root.querySelector("[data-attach]"), "TRADE_DOC", d.id, { posted: d.status !== "DRAFT" });
      if (ZL.einvoice) ZL.einvoice.panel(root.querySelector("[data-einv]"), d);
    },
  });

  // ── Sales / purchases lists ──────────────────────────────────────────────
  function listPage(side) {
    const S = SIDE[side];
    const types = side === "AR" ? SALES : PURCHASES;
    return {
      title: side === "AR" ? "Sales" : "Purchases",
      perm: "journal.view",
      business: true,
      async render(ctx) {
        const p = ctx.params;
        const term = String(p.q || "").replace(/[,()*%\\:"']/g, " ").trim().slice(0, 80);
        const want = p.type || "", st = p.status || "";
        const [page, people, aging, month] = await Promise.all([
          ZL.page("trade_docs", "*", (q) => {
            q = q.eq("company_id", cid()).eq("side", side);
            if (want) q = q.eq("doc_type", want);
            if (st === "DRAFT" || st === "VOID") q = q.eq("status", st);
            if (st === "OPEN") q = q.eq("status", "POSTED");
            if (term) q = q.or(`doc_no.ilike.*${term}*,bill_name.ilike.*${term}*,reference.ilike.*${term}*,description.ilike.*${term}*`);
            if (p.from) q = q.gte("date", p.from);
            if (p.to) q = q.lte("date", p.to);
            return q.order("date", { ascending: false }).order("created_at", { ascending: false });
          }, 0, p.limit || 100),
          contacts(S.kind),
          ZL.rpc("trade_aging", { p_company: cid(), p_side: side, p_as_at: ctx.today }).catch(() => []),
          ZL.select("trade_docs", "doc_type,subtotal,status", (q) => q.eq("company_id", cid()).eq("side", side).eq("status", "POSTED")
            .gte("date", ZL.monthStart(ctx.today)).lte("date", ZL.monthEnd(ctx.today))),
        ]);
        const cName = new Map(people.map((c) => [c.id, c.name]));
        let rows = page.rows;
        if (st === "OPEN") rows = rows.filter((d) => T[d.doc_type].effect !== 0 && T[d.doc_type].posts && outstanding(d) > 0);
        if (st === "OVERDUE") rows = rows.filter((d) => d.status === "POSTED" && T[d.doc_type].effect === 1 && outstanding(d) > 0 && d.due_date && d.due_date < ctx.today);
        const owed = ZL.sum(aging, (a) => a.balance);
        const overdue = ZL.sum(aging, (a) => ZL.num(a.d1_30) + ZL.num(a.d31_60) + ZL.num(a.d61_90) + ZL.num(a.d91_120) + ZL.num(a.d120_plus));
        const sign = { INVOICE: 1, CASH_SALE: 1, DEBIT_NOTE: 1, CREDIT_NOTE: -1, BILL: 1, CASH_PURCHASE: 1, SUPPLIER_DN: 1, SUPPLIER_CN: -1 };
        const monthNet = month.reduce((s, d) => s + (sign[d.doc_type] || 0) * ZL.cents(d.subtotal), 0) / 100;
        const canNew = ZL.can("journal.create");
        const nb = (tp, l, cls = "") => `<button type="button" class="zl-btn sm ${cls}" data-new="${tp}">${l}</button>`;
        const newRow = canNew ? `<div class="zl-new">${side === "AR"
          ? nb("INVOICE", "+ Invoice", "primary") + nb("RECEIPT", "Receive payment") + nb("QUOTATION", "+ Quotation") + nb("CASH_SALE", "+ Cash sale") + nb("CREDIT_NOTE", "+ Credit note") + nb("DEBIT_NOTE", "+ Debit note") + nb("REFUND", "Refund")
          : nb("BILL", "+ Purchase invoice", "primary") + nb("PAYMENT", "Pay supplier") + nb("PURCHASE_ORDER", "+ Purchase order") + nb("CASH_PURCHASE", "+ Cash purchase") + nb("SUPPLIER_CN", "+ Supplier CN") + nb("SUPPLIER_DN", "+ Supplier DN") + nb("SUPPLIER_REFUND", "Supplier refund")}</div>` : "";
        const seg = [["", "All"]].concat(types.map((x) => [x, T[x].plural])).map(([v, l]) => `<option value="${v}"${want === v ? " selected" : ""}>${E(l)}</option>`).join("");
        const stSel = [["", "Any status"], ["DRAFT", "Drafts"], ["OPEN", side === "AR" ? "Unpaid / unapplied" : "Unpaid / unapplied"], ["OVERDUE", "Overdue"], ["VOID", "Void"]]
          .map(([v, l]) => `<option value="${v}"${st === v ? " selected" : ""}>${l}</option>`).join("");
        const amtCell = (d) => { const t = T[d.doc_type]; const neg = t.effect === -1 || d.doc_type === "SUPPLIER_CN"; return `<span class="num"${d.status === "VOID" ? ' style="text-decoration:line-through;opacity:.6"' : ""}>${neg ? "−" : ""}${M(d.total)}</span>`; };
        return ZL.header(side === "AR" ? "Sales" : "Purchases",
            side === "AR" ? "Quotations, invoices, cash sales, notes and receipts — each posts its own double entry." : "Purchase orders, supplier invoices, notes and payments — each posts its own double entry.",
            `<button type="button" class="zl-btn ghost" data-go="${S.list}">${side === "AR" ? "Customers" : "Suppliers"}</button><button type="button" class="zl-btn ghost" data-go="${S.aging}">Aging</button>`) +
          newRow + `
          <div class="zl-sumrow"><span>${side === "AR" ? "Customers owe you" : "You owe suppliers"}<b class="num">${M(owed, { symbol: true })}</b></span>
            <span>Overdue<b class="num" style="${overdue > 0 ? "color:var(--bad)" : ""}">${M(overdue, { symbol: true })}</b></span>
            <span>${side === "AR" ? "Sales" : "Purchases"} this month (excl. SST)<b class="num">${M(monthNet, { symbol: true })}</b></span></div>
          <div class="toolbar">
            <label class="field in"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>
              <input id="zl-sq" type="search" value="${E(p.q || "")}" placeholder="Search no., ${S.who} or reference" aria-label="Search documents"></label>
            <label class="field"><select id="zl-stype" aria-label="Document type">${seg}</select></label>
            <label class="field"><select id="zl-sst" aria-label="Status">${stSel}</select></label>
            <label class="field"><span class="hint">From</span><input id="zl-sfrom" type="date" value="${E(p.from || "")}" aria-label="From date"></label>
            <label class="field"><span class="hint">To</span><input id="zl-sto" type="date" value="${E(p.to || "")}" aria-label="To date"></label>
            ${ZL.applyButton("zl-sapply")}
            <span class="count"><b>${rows.length}</b>${st === "OPEN" || st === "OVERDUE" ? "" : ` of ${page.count}`}</span>
          </div>
          ${rows.length ? `<section class="card"><div class="tablewrap"><table>
            <thead><tr><th>Date</th><th>No.</th><th>${S.Who}</th><th>Type</th><th>Due</th><th class="r">Total (RM)</th><th class="r">Open</th><th>Status</th></tr></thead>
            <tbody>${rows.map((d) => { const t = T[d.doc_type]; return `<tr class="click" data-doc="${d.id}">
              <td class="nil" style="white-space:nowrap">${ZL.date(d.date)}</td>
              <td style="white-space:nowrap"><b class="mono">${E(d.doc_no || "Draft")}</b>${d.reference ? `<div class="hint">${E(d.reference)}</div>` : ""}</td>
              <td>${E(cName.get(d.contact_id) || d.bill_name || "Cash customer")}${d.description ? `<div class="hint">${E(d.description)}</div>` : ""}</td>
              <td class="nil">${E(t.label)}</td>
              <td class="nil" style="white-space:nowrap">${t.effect === 1 && d.due_date ? ZL.date(d.due_date) : "—"}</td>
              <td class="r">${amtCell(d)}</td>
              <td class="r num">${d.status === "POSTED" && t.posts && t.effect !== 0 && outstanding(d) > 0 ? M(outstanding(d)) : "—"}</td>
              <td>${statusChip(d)}</td></tr>`; }).join("")}</tbody></table></div>
            ${page.count > page.rows.length ? `<div class="proofrow"><span>Showing ${page.rows.length} of ${page.count}.</span><span class="figs"><button type="button" class="zl-btn sm" id="zl-smore">Load 100 more</button></span></div>` : ""}
          </section>` : ZL.empty(term || want || st || p.from || p.to ? "Nothing matches" : `No ${side === "AR" ? "sales" : "purchase"} documents yet`,
            term || want || st || p.from || p.to ? "Try another search, type or date range." : side === "AR"
              ? "Add a customer, then issue a quotation or invoice. Receipts knock off invoices, and everything posts to the ledger by itself."
              : "Add a supplier, then record their invoice. Payments knock off what you owe, and everything posts to the ledger by itself.")}`;
      },
      after(root, ctx) {
        const p = ctx.params;
        root.querySelectorAll("[data-new]").forEach((b) => b.addEventListener("click", () => (T[b.dataset.new].lines ? ZL.tradeEdit(b.dataset.new) : ZL.tradePay(b.dataset.new))));
        root.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));
        root.querySelectorAll("tr[data-doc]").forEach((tr) => tr.addEventListener("click", () => ZL.open("tradedoc", { id: tr.dataset.doc, side })));
        const q = root.querySelector("#zl-sq");
        q.addEventListener("input", ZL.debounce(() => ZL.open(S.route, Object.assign({}, p, { q: q.value, focus: "q" })), 400));
        if (p.focus === "q") { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
        root.querySelector("#zl-stype").addEventListener("change", (ev) => ZL.open(S.route, Object.assign({}, p, { type: ev.target.value, focus: null })));
        root.querySelector("#zl-sst").addEventListener("change", (ev) => ZL.open(S.route, Object.assign({}, p, { status: ev.target.value, focus: null })));
        ZL.wireApply(root, ["zl-sfrom", "zl-sto"], "zl-sapply", () => {
          const from = root.querySelector("#zl-sfrom").value || null, to = root.querySelector("#zl-sto").value || null;
          if (from && to && from > to) { ZL.toast("The start date is after the end date.", "warn"); return; }
          ZL.open(S.route, Object.assign({}, p, { from, to, focus: null }));
        });
        const more = root.querySelector("#zl-smore");
        if (more) more.addEventListener("click", () => ZL.open(S.route, Object.assign({}, p, { limit: (p.limit || 100) + 100 })));
      },
    };
  }
  ZL.register("sales", listPage("AR"));
  ZL.register("purchases", listPage("AP"));

  // ── Customers and suppliers ──────────────────────────────────────────────
  /** Add or edit a customer/supplier. Resolves with its id, or null. */
  ZL.editContact = async (kind, id = null, opts = {}) => {
    const [rows, accounts, taxes] = await Promise.all([
      id ? ZL.select("contacts", "*", (q) => q.eq("id", id)) : Promise.resolve([]), ZL.accounts(), taxCodes()]);
    const c = rows[0] || Object.assign({ kind, terms_days: 30, credit_limit: 0, country: "MY", is_active: true }, opts.preset || {});
    const side = kind === "CUSTOMER" ? "AR" : "AP";
    const controls = accounts.filter((a) => a.is_control && a.is_active && a.type === (side === "AR" ? "ASSET" : "LIABILITY"));
    const who = kind === "CUSTOMER" ? "customer" : "supplier";
    const fields = [
      { name: "name", label: `${kind === "CUSTOMER" ? "Customer" : "Supplier"} name`, required: true, value: c.name || "", placeholder: "As registered, e.g. Syarikat ABC Sdn Bhd" },
      { name: "code", label: "Code", value: c.code || "", half: true, placeholder: "Automatic, e.g. " + (kind === "CUSTOMER" ? "C0001" : "S0001") },
      { name: "contact_person", label: "Contact person", value: c.contact_person || "", half: true },
      { name: "phone", label: "Phone", value: c.phone || "", half: true },
      { name: "email", label: "Email", value: c.email || "", half: true },
      { name: "address", label: "Address", type: "textarea", value: c.address || "" },
      { name: "postcode", label: "Postcode", value: c.postcode || "", half: true },
      { name: "city", label: "City", value: c.city || "", half: true },
      { name: "state", label: "State", type: "select", value: c.state || "", half: true, options: STATES.map((s) => ({ value: s, label: s || "—" })) },
      { name: "country", label: "Country", value: c.country || "MY", half: true, hint: "Two-letter code, e.g. MY, SG" },
      { name: "id_type", label: "ID type (e-Invoice)", type: "select", value: c.id_type || "", half: true,
        options: [{ value: "", label: "—" }, { value: "BRN", label: "Business registration (SSM)" }, { value: "NRIC", label: "MyKad / NRIC" }, { value: "PASSPORT", label: "Passport" }, { value: "ARMY", label: "Army ID" }] },
      { name: "reg_no", label: "Registration / ID no.", value: c.reg_no || "", half: true, placeholder: "e.g. 202001012345" },
      { name: "tin", label: "Tax ID (TIN)", value: c.tin || "", half: true, placeholder: "e.g. C1234567890 or IG…", hint: "Needed for LHDN e-Invoice." },
      { name: "sst_no", label: "SST registration no.", value: c.sst_no || "", half: true },
      { name: "terms_days", label: "Credit terms (days)", type: "number", value: c.terms_days, half: true },
      { name: "credit_limit", label: "Credit limit", type: "amount", value: ZL.num(c.credit_limit) ? M(c.credit_limit) : "", half: true, hint: "Blank = no limit" },
      { name: "default_account_id", label: kind === "CUSTOMER" ? "Usual income account" : "Usual expense account", type: "select", value: c.default_account_id || "", half: true,
        options: [{ value: "", label: "—" }].concat(TYPE_ORDER[side].flatMap((t) => accounts.filter((a) => a.type === t && lineUsable(a)).map((a) => ({ value: a.id, label: `${a.code} · ${a.name}`, group: TYPE_NAME[t] })))) },
      { name: "default_tax_code_id", label: "Usual SST", type: "select", value: c.default_tax_code_id || "", half: true,
        options: [{ value: "", label: "None" }].concat(taxes.filter((x) => x.is_active).map((x) => ({ value: x.id, label: `${x.code} · ${x.name}` }))) },
      ...(controls.length > 1 ? [{ name: "control_account_id", label: "Control account", type: "select", value: c.control_account_id || "",
        options: [{ value: "", label: "Default" }].concat(controls.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))) }] : []),
      { name: "notes", label: "Notes", type: "textarea", value: c.notes || "" },
      ...(id ? [{ name: "is_active", label: "Active", type: "checkbox", value: c.is_active, hint: `Inactive ${who}s keep their history but can't be chosen on new documents.` }] : []),
    ];
    const r = await ZL.form({ title: id ? `Edit ${c.name}` : `New ${who}`, wide: true, fields, confirmLabel: id ? "Save" : `Add ${who}`,
      submit: (v) => ZL.rpc("save_contact", { p_company: cid(), p_id: id, p_data: Object.assign({ kind }, v, {
        credit_limit: v.credit_limit === "" ? 0 : v.credit_limit, is_active: id ? v.is_active : true }) }) });
    if (!r) return null;
    ZL.toast(id ? "Saved." : `${kind === "CUSTOMER" ? "Customer" : "Supplier"} added.`);
    if (!opts.stay) ZL.refresh();
    return typeof r === "string" ? r : id;
  };

  function contactsPage(kind) {
    const side = kind === "CUSTOMER" ? "AR" : "AP";
    const S = SIDE[side];
    return {
      title: kind === "CUSTOMER" ? "Customers" : "Suppliers",
      perm: "journal.view",
      business: true,
      async render(ctx) {
        const p = ctx.params;
        const term = String(p.q || "").trim().toLowerCase();
        const [people, aging] = await Promise.all([contacts(kind), ZL.rpc("trade_aging", { p_company: cid(), p_side: side, p_as_at: ctx.today }).catch(() => [])]);
        const bal = new Map(aging.map((a) => [a.contact_id, a]));
        const list = people.filter((c) => (p.all || c.is_active) && (!term || [c.name, c.code, c.email, c.phone, c.tin].some((x) => String(x || "").toLowerCase().includes(term))));
        const total = ZL.sum(aging, (a) => a.balance);
        return ZL.header(kind === "CUSTOMER" ? "Customers" : "Suppliers", kind === "CUSTOMER" ? "Who you sell to — with their balance, terms and statement." : "Who you buy from — with what you owe them.",
            ZL.can("journal.create") ? `<button type="button" class="zl-btn primary" id="zl-cnew">+ New ${S.who}</button>` : "") + `
          <div class="zl-sumrow"><span>${people.filter((c) => c.is_active).length} active ${S.who}s</span><span>${kind === "CUSTOMER" ? "Total owed to you" : "Total you owe"}<b class="num">${M(total, { symbol: true })}</b></span></div>
          <div class="toolbar">
            <label class="field in"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>
              <input id="zl-cq" type="search" value="${E(p.q || "")}" placeholder="Search name, code, TIN or phone" aria-label="Search"></label>
            <label class="zl-check" style="margin:0"><input type="checkbox" id="zl-call"${p.all ? " checked" : ""}><span>Show inactive</span></label>
            <span class="count"><b>${list.length}</b></span>
          </div>
          ${list.length ? `<section class="card"><div class="tablewrap"><table>
            <thead><tr><th>Code</th><th>Name</th><th>Contact</th><th>TIN</th><th class="r">Terms</th><th class="r">Balance (RM)</th><th class="r">Overdue</th></tr></thead>
            <tbody>${list.map((c) => { const a = bal.get(c.id) || {}; const od = ZL.num(a.d1_30) + ZL.num(a.d31_60) + ZL.num(a.d61_90) + ZL.num(a.d91_120) + ZL.num(a.d120_plus);
              return `<tr class="click" data-c="${c.id}"${c.is_active ? "" : ' style="opacity:.6"'}>
              <td class="mono">${E(c.code)}</td><td><b style="font-weight:500">${E(c.name)}</b>${c.is_active ? "" : ' <span class="chip">Inactive</span>'}</td>
              <td class="nil">${E([c.contact_person, c.phone, c.email].filter(Boolean).join(" · ") || "—")}</td><td class="mono nil">${E(c.tin || "—")}</td>
              <td class="r nil">${c.terms_days ? `${c.terms_days} days` : "Cash"}</td><td class="r num">${ZL.num(a.balance) ? M(a.balance) : "—"}</td>
              <td class="r num" style="${od > 0 ? "color:var(--bad)" : ""}">${od > 0 ? M(od) : "—"}</td></tr>`; }).join("")}</tbody></table></div></section>`
            : ZL.empty(term ? "Nothing matches" : `No ${S.who}s yet`, term ? "Try another search." : `Add your first ${S.who}. Their TIN and registration number go on e-Invoices.`)}`;
      },
      after(root, ctx) {
        const p = ctx.params;
        const n = root.querySelector("#zl-cnew");
        if (n) n.addEventListener("click", () => ZL.editContact(kind));
        root.querySelectorAll("[data-c]").forEach((tr) => tr.addEventListener("click", () => ZL.open("contact", { id: tr.dataset.c })));
        const q = root.querySelector("#zl-cq");
        q.addEventListener("input", ZL.debounce(() => ZL.open(S.list, Object.assign({}, p, { q: q.value, focus: "q" })), 300));
        if (p.focus === "q") { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
        root.querySelector("#zl-call").addEventListener("change", (ev) => ZL.open(S.list, Object.assign({}, p, { all: ev.target.checked })));
      },
    };
  }
  ZL.register("customers", contactsPage("CUSTOMER"));
  ZL.register("suppliers", contactsPage("SUPPLIER"));

  // ── Statement of account ─────────────────────────────────────────────────
  ZL.statementHtml = ({ st, info, ds }) => {
    const c = st.contact, ar = c.kind === "CUSTOMER";
    const a = st.aging || {};
    const buckets = [["Current", a.not_due], ["1–30 days", a.d1_30], ["31–60 days", a.d31_60], ["61–90 days", a.d61_90], ["91–120 days", a.d91_120], ["Over 120", a.d120_plus]];
    return shell(ds, `${letterhead(info, ds, "Statement of Account", [["Date", ZL.date(st.to)], ["Period", `${ZL.date(st.from)} – ${ZL.date(st.to)}`], ["Account", c.code]])}
      <div class="zv-bill">${billTo({ bill_name: c.name }, c, ar ? "Customer" : "Supplier")}<div><span>${ar ? "Amount due" : "Amount owing"}</span><b style="font-size:20px">RM ${M(st.closing)}</b>
        <div>Terms: ${c.terms_days ? `${c.terms_days} days` : "Cash"}</div></div></div>
      <table class="zv-lines zv-items"><thead><tr><th>Date</th><th>Document</th><th>Description</th><th class="r">${ar ? "Debit" : "Credit"}</th><th class="r">${ar ? "Credit" : "Debit"}</th><th class="r">Balance</th></tr></thead>
        <tbody><tr><td>${E(ZL.date(st.from))}</td><td></td><td>Balance brought forward</td><td></td><td></td><td class="r">${M(st.opening)}</td></tr>
        ${st.lines.map((l) => `<tr><td>${E(ZL.date(l.date))}</td><td>${E(l.doc_no)}<div class="acct">${E((T[l.doc_type] || {}).label || "")}</div></td>
          <td>${E(l.description || "")}${l.reference ? `<div class="acct">${E(l.reference)}</div>` : ""}</td>
          <td class="r">${ZL.num(l.increase) ? M(l.increase) : ""}</td><td class="r">${ZL.num(l.decrease) ? M(l.decrease) : ""}</td><td class="r">${M(l.balance)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td colspan="5">Closing balance</td><td class="r">RM ${M(st.closing)}</td></tr></tfoot></table>
      <table class="zv-aging"><thead><tr>${buckets.map(([k]) => `<th>${k}</th>`).join("")}<th>Unapplied</th><th>Total</th></tr></thead>
        <tbody><tr>${buckets.map(([, v]) => `<td>${M(v || 0)}</td>`).join("")}<td>${ZL.num(a.unapplied) ? `(${M(a.unapplied)})` : "0.00"}</td><td><b>${M(a.balance || 0)}</b></td></tr></tbody></table>
      ${ds.footer ? `<div class="zv-foot">${E(ds.footer)}</div>` : ""}
      <div class="zv-gen">Computer-generated in Zycount. Please tell us within 14 days if anything here doesn't match your records.</div>`);
  };
  ZL.statement = async (contactId) => {
    const today = ZL.today();
    const v = await ZL.form({ title: "Statement of account", confirmLabel: "Show statement",
      fields: [{ name: "from", label: "From", type: "date", value: ZL.addDays(ZL.monthStart(today), -61).slice(0, 8) + "01", half: true, required: true },
        { name: "to", label: "To", type: "date", value: today, half: true, required: true }] });
    if (!v) return;
    let st, info, ds;
    try { [st, info, ds] = await Promise.all([ZL.rpc("contact_statement", { p_contact: contactId, p_from: v.from, p_to: v.to }), ZL.companyInfo(), ZL.docSettings()]); }
    catch (e) { ZL.toast(ZL.errorText(e), "bad"); return; }
    const html = ZL.statementHtml({ st, info, ds });
    const name = `Statement-${st.contact.code}-${v.to}.pdf`;
    ZL.modal({ title: `Statement — ${st.contact.name}`, wide: true, body: `<div class="zl-vwrap">${html}</div>`,
      actions: [{ label: "Print", onClick: () => ZL.voucherPrint(html, name) },
        { label: "Download PDF", primary: true, onClick: async () => { await ZL.voucherPdf(html, name); ZL.toast(`Saved ${name}.`); } }] });
  };

  /** A balance brought over from an old system, as an opening invoice/bill against retained earnings. */
  async function openingDoc(c) {
    const side = c.kind === "CUSTOMER" ? "AR" : "AP";
    const accounts = await ZL.accounts();
    const re = accounts.find((a) => a.code === "3200" && lineUsable(a));
    const v = await ZL.form({ title: `Opening balance — ${c.name}`, confirmLabel: "Post opening balance",
      intro: `For each ${side === "AR" ? "unpaid invoice" : "unpaid bill"} carried over from your old system. It posts to ${side === "AR" ? "receivables" : "payables"} against ${E(re ? re.name : "retained earnings")}, so it can be knocked off like any other.`,
      fields: [{ name: "reference", label: side === "AR" ? "Old invoice no." : "Supplier's invoice no.", required: true, half: true },
        { name: "date", label: "Invoice date", type: "date", required: true, half: true, value: ZL.yearStart() },
        { name: "amount", label: "Amount still owed", type: "amount", required: true, half: true },
        { name: "due", label: "Due date", type: "date", half: true }] });
    if (!v) return;
    try {
      const r = await ZL.rpc("save_trade_doc", { p_company: cid(), p_id: null, p_doc: { doc_type: side === "AR" ? "INVOICE" : "BILL", contact_id: c.id, date: v.date,
        due_date: v.due || null, reference: v.reference, description: "Balance brought forward", allow_over_limit: true },
        p_lines: [{ description: `Balance brought forward — ${v.reference}`, qty: 1, unit_price: v.amount, account_id: re ? re.id : null }], p_post: true });
      ZL.toast(`Opening balance posted as ${r.doc_no}.`);
      ZL.refresh();
    } catch (e) { ZL.toast(ZL.errorText(e), "bad"); }
  }

  ZL.register("contact", {
    title: "Contact",
    perm: "journal.view",
    detail: true,
    business: true,
    get nav() { return (ZL.params && ZL.params.side) === "AP" ? "suppliers" : "customers"; },
    async render(ctx) {
      const [cs] = await Promise.all([ZL.select("contacts", "*", (q) => q.eq("id", ctx.params.id).eq("company_id", cid()))]);
      const c = cs[0];
      if (!c) throw new ZL.ZLError("NOT_FOUND", "That contact isn't in these books.");
      const side = c.kind === "CUSTOMER" ? "AR" : "AP", S = SIDE[side];
      ctx.params.side = side;
      ctx.contact = c;
      const [open, recent, aging] = await Promise.all([
        ZL.rpc("trade_open_docs", { p_contact: c.id }),
        ZL.select("trade_docs", "*", (q) => q.eq("contact_id", c.id).order("date", { ascending: false }).order("created_at", { ascending: false }).limit(50)),
        ZL.rpc("trade_aging", { p_company: cid(), p_side: side, p_as_at: ctx.today }),
      ]);
      const a = aging.find((x) => x.contact_id === c.id) || { balance: 0 };
      const canNew = ZL.can("journal.create"), canPay = ZL.can("journal.post");
      const addr = [c.address, [c.postcode, c.city].filter(Boolean).join(" "), c.state, c.country !== "MY" ? c.country : ""].filter(Boolean).join(", ");
      const facts = [["Balance", `RM ${M(a.balance)}`], ["Overdue", `RM ${M(ZL.num(a.d1_30) + ZL.num(a.d31_60) + ZL.num(a.d61_90) + ZL.num(a.d91_120) + ZL.num(a.d120_plus))}`],
        ["Terms", c.terms_days ? `${c.terms_days} days` : "Cash"], ["Credit limit", ZL.num(c.credit_limit) ? `RM ${M(c.credit_limit)}` : "None"],
        ["TIN", c.tin || "—"], ["Reg. / ID no.", c.reg_no ? `${c.reg_no}${c.id_type ? ` (${c.id_type})` : ""}` : "—"], ["SST no.", c.sst_no || "—"],
        ["Contact", [c.contact_person, c.phone, c.email].filter(Boolean).join(" · ") || "—"]];
      const docRow = (d) => `<tr class="click" data-doc="${d.id}"><td class="nil">${ZL.date(d.date)}</td><td class="mono"><b>${E(d.doc_no || "Draft")}</b></td>
        <td class="nil">${E(T[d.doc_type].label)}</td><td class="nil">${T[d.doc_type].effect === 1 && d.due_date ? ZL.date(d.due_date) : "—"}</td>
        <td class="r num">${M(d.total)}</td><td class="r num">${d.outstanding != null ? M(d.outstanding) : d.status === "POSTED" && T[d.doc_type].posts && T[d.doc_type].effect ? M(outstanding(d)) : "—"}</td><td>${d.status ? statusChip(d) : ""}</td></tr>`;
      return `<div class="zl-crumbs"><button type="button" class="zl-ref" data-back>${side === "AR" ? "Customers" : "Suppliers"}</button> / ${E(c.code)}</div>` +
        ZL.header(c.name, [c.code, addr].filter(Boolean).join(" · "),
          (canNew ? `<button type="button" class="zl-btn ghost" data-edit>Edit</button>` : "") +
          `<button type="button" class="zl-btn ghost" data-stmt>Statement</button>` +
          (side === "AR" && c.tin && ZL.einvoice ? `<button type="button" class="zl-btn ghost" data-tin title="Ask LHDN whether this TIN matches the registration / IC no.">Check TIN</button>` : "") +
          (canNew ? `<button type="button" class="zl-btn ghost" data-obal>Opening balance</button><button type="button" class="zl-btn" data-new="${side === "AR" ? "INVOICE" : "BILL"}">+ ${side === "AR" ? "Invoice" : "Purchase invoice"}</button>` : "") +
          (canNew && canPay && c.is_active ? `<button type="button" class="zl-btn ghost" data-contra title="Set off against the same party's ${side === "AR" ? "supplier" : "customer"} balance">Contra</button>` : "") +
          (canPay && c.is_active ? `<button type="button" class="zl-btn primary" data-pay>${S.payLabel}</button>` : "")) + `
        <section class="card"><div class="zl-facts">${facts.map(([k, v]) => `<div><span>${E(k)}</span><b>${E(v)}</b></div>`).join("")}</div></section>
        <section class="card" style="margin-top:16px"><div class="zl-sec-h"><h3>Open documents</h3></div>
          ${open.length ? `<div class="tablewrap"><table><thead><tr><th>Date</th><th>No.</th><th>Type</th><th>Due</th><th class="r">Total</th><th class="r">Open</th><th></th></tr></thead>
            <tbody>${open.map((o) => docRow(Object.assign({}, o, { status: "" }))).join("")}</tbody></table></div>` : `<p class="nil" style="padding:0 18px 16px">Nothing open.</p>`}</section>
        <section class="card" style="margin-top:16px"><div class="zl-sec-h"><h3>Latest documents</h3></div>
          ${recent.length ? `<div class="tablewrap"><table><thead><tr><th>Date</th><th>No.</th><th>Type</th><th>Due</th><th class="r">Total</th><th class="r">Open</th><th>Status</th></tr></thead>
            <tbody>${recent.map(docRow).join("")}</tbody></table></div>` : `<p class="nil" style="padding:0 18px 16px">No documents yet.</p>`}</section>`;
    },
    after(root, ctx) {
      const c = ctx.contact;
      if (!c) return;
      const side = c.kind === "CUSTOMER" ? "AR" : "AP";
      const on = (sel, fn) => root.querySelectorAll(sel).forEach((el) => el.addEventListener("click", () => fn(el)));
      on("[data-back]", () => go(SIDE[side].list));
      on("[data-edit]", () => ZL.editContact(c.kind, c.id));
      on("[data-stmt]", () => ZL.statement(c.id));
      on("[data-tin]", async (el) => { el.disabled = true; await ZL.einvoice.checkTin(c.id); el.disabled = false; });
      on("[data-obal]", () => openingDoc(c));
      on("[data-new]", (el) => ZL.tradeEdit(el.dataset.new, null, { contact_id: c.id }));
      on("[data-pay]", () => ZL.tradePay(SIDE[side].pay, { contact_id: c.id }));
      on("[data-contra]", () => ZL.contra(c).catch((e) => ZL.toast(ZL.errorText(e), "bad")));
      on("[data-doc]", (el) => ZL.open("tradedoc", { id: el.dataset.doc, side }));
    },
  });

  // ── Contra: set a customer's balance off against the same party's supplier balance ──
  ZL.contra = async (c) => {
    if (!(ZL.can("journal.create") && ZL.can("journal.post"))) { ZL.toast("Your role can't post contras in these books.", "bad"); return null; }
    const isCu = c.kind === "CUSTOMER";
    const [others, numRows] = await Promise.all([contacts(isCu ? "SUPPLIER" : "CUSTOMER"), ZL.numbering.load(ZL.today()).catch(() => [])]);
    const key = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const same = others.find((o) => o.is_active && ((c.reg_no && key(o.reg_no) === key(c.reg_no)) || (c.tin && key(o.tin) === key(c.tin)) || key(o.name) === key(c.name)));
    const numFields = ZL.numbering.fields(numRows, "CONTRA", null);
    const f = (label, control, cls = "") => `<label class="zl-field ${cls}"><span>${label}</span>${control}</label>`;
    const other = isCu ? "supplier" : "customer";
    const body = `
      <p class="hint" style="margin:0 0 10px">When ${E(c.name)} is both a customer and a supplier, set what they owe you off against what you owe them. One journal moves the amount from trade payables to trade receivables, and both sides' invoices and bills are knocked off.</p>
      <div class="zl-dochead">
        ${f(`${isCu ? "Same party as supplier" : "Same party as customer"} <i aria-hidden="true">*</i>`, `<select class="zl-input" name="other"><option value="">Choose ${other}…</option>${others.filter((o) => o.is_active).map((o) => opt(o.id, `${o.name} · ${o.code}`, same && same.id)).join("")}</select>`, "wide")}
        ${f('Date <i aria-hidden="true">*</i>', `<input class="zl-input" type="date" name="date" value="${E(ZL.today())}">`)}
        ${f('Amount to set off <i aria-hidden="true">*</i>', `<div class="zl-amount"><span>RM</span><input class="zl-input num" name="amount" inputmode="decimal" placeholder="0.00"></div>`)}
        ${f("Description", `<input class="zl-input" name="description" maxlength="500" placeholder="Optional">`, "wide")}
        ${numFields.map((x) => `<label class="zl-field"><span>${E(x.label)}</span>${x.type === "select"
          ? `<select class="zl-input" name="${x.name}">${x.options.map((o) => opt(o.value, o.label, x.value)).join("")}</select>`
          : `<input class="zl-input" name="${x.name}" value="${E(x.value)}">`}</label>`).join("")}
      </div>
      <div class="zl-sec-h" style="padding:14px 0 6px"><h3 style="font-size:14px">Customer invoices it settles</h3></div><div id="zl-car" class="zl-lines-wrap"></div>
      <div class="zl-sec-h" style="padding:14px 0 6px"><h3 style="font-size:14px">Supplier bills it settles</h3></div><div id="zl-cap" class="zl-lines-wrap"></div>
      <div class="zl-totals" id="zl-ctot" style="margin-top:8px"></div>`;
    let result = null, arOpen = [], apOpen = [];
    const m = ZL.modal({ title: `Contra — ${c.name}`, wide: true, body,
      actions: [{ label: "Cancel" }, { label: "Post contra", primary: true, onClick: async ({ root, close }) => {
        const v = (n) => root.querySelector(`[name="${n}"]`).value.trim();
        const amount = ZL.parseAmount(v("amount"));
        if (!v("other")) throw bad(`Choose the ${other}.`);
        if (Number.isNaN(amount) || !amount) throw bad("Enter the amount to set off.");
        const read = (box) => [...root.querySelectorAll(`${box} [data-apply]`)].map((i) => ({ doc_id: i.dataset.apply, amount: ZL.parseAmount(i.value) })).filter((a) => a.amount);
        const ar = read("#zl-car"), ap = read("#zl-cap");
        if (ar.concat(ap).some((a) => Number.isNaN(a.amount))) throw bad("Knock-off amounts must be numbers.");
        [ar, ap].forEach((list, i) => { const s = list.reduce((t, a) => t + ZL.cents(a.amount), 0); if (s > ZL.cents(amount)) throw bad(`The ${i ? "bills" : "invoices"} you picked add up to ${M(s / 100)}, more than the ${M(amount)} set off.`); });
        const num = numCtl ? numCtl.read() : {};
        result = await ZL.rpc("post_contra", { p_company: cid(), p_customer: isCu ? c.id : v("other"), p_supplier: isCu ? v("other") : c.id,
          p_date: v("date"), p_amount: amount, p_ar_allocations: ar, p_ap_allocations: ap, p_description: v("description") || null,
          p_series: num.p_series || null, p_doc_no: num.p_doc_no || null });
        close();
      } }],
      onClose: () => { if (result) { ZL.toast(`Contra ${result.doc_no} posted — RM ${M(result.total)} set off.`); ZL.open("tradedoc", { id: isCu ? result.id : result.ap_id }); } } });
    const root = m.root;
    const numCtl = numFields.length ? ZL.numbering.wire(root, numRows, "CONTRA", { dateInput: root.querySelector('[name="date"]') }) : null;
    const amountInp = root.querySelector('[name="amount"]');
    const table = (list) => list.length ? `<table class="zl-lines" style="min-width:520px"><thead><tr><th>Document</th><th>Date</th><th>Due</th><th class="r">Open</th><th class="r" style="width:130px">Apply</th></tr></thead>
      <tbody>${list.map((o) => `<tr><td><b>${E(o.doc_no)}</b> <span class="hint">${E(T[o.doc_type].label)}</span></td><td class="nil">${ZL.date(o.date)}</td>
        <td class="nil">${o.due_date ? ZL.date(o.due_date) : "—"}</td><td class="amt">${M(o.outstanding)}</td>
        <td><input class="zl-input num r" data-apply="${o.id}" data-max="${o.outstanding}" inputmode="decimal" placeholder="0.00"></td></tr>`).join("")}</tbody></table>`
      : `<p class="nil" style="padding:8px 12px">Nothing open.</p>`;
    const fill = (box) => { let left = ZL.cents(ZL.parseAmount(amountInp.value) || 0);
      root.querySelectorAll(`${box} [data-apply]`).forEach((i) => { const take = Math.min(left, ZL.cents(i.dataset.max)); i.value = take ? M(take / 100) : ""; left -= take; }); };
    const tot = () => {
      const sum = (box) => [...root.querySelectorAll(`${box} [data-apply]`)].reduce((s, i) => s + ZL.cents(ZL.parseAmount(i.value) || 0), 0) / 100;
      const cap = Math.min(ZL.sum(arOpen, (o) => o.outstanding), ZL.sum(apOpen, (o) => o.outstanding));
      root.querySelector("#zl-ctot").innerHTML = `<span>Most you can set off</span><b>${M(cap)}</b><span>Invoices applied</span><b>${M(sum("#zl-car"))}</b><span>Bills applied</span><b>${M(sum("#zl-cap"))}</b>`;
    };
    const load = async () => {
      const otherId = root.querySelector('[name="other"]').value;
      const [mine, theirs] = await Promise.all([ZL.rpc("trade_open_docs", { p_contact: c.id }), otherId ? ZL.rpc("trade_open_docs", { p_contact: otherId }) : Promise.resolve([])]);
      const plus = (l) => l.filter((o) => o.effect === 1);
      arOpen = plus(isCu ? mine : theirs); apOpen = plus(isCu ? theirs : mine);
      root.querySelector("#zl-car").innerHTML = table(arOpen);
      root.querySelector("#zl-cap").innerHTML = table(apOpen);
      const cap = Math.min(ZL.sum(arOpen, (o) => o.outstanding), ZL.sum(apOpen, (o) => o.outstanding));
      amountInp.value = cap > 0 ? M(cap) : "";
      fill("#zl-car"); fill("#zl-cap"); tot();
    };
    root.querySelector('[name="other"]').addEventListener("change", load);
    amountInp.addEventListener("change", () => { const v = ZL.parseAmount(amountInp.value); if (!Number.isNaN(v) && v) amountInp.value = M(v); fill("#zl-car"); fill("#zl-cap"); tot(); });
    root.addEventListener("input", (ev) => { if (ev.target.dataset.apply) tot(); });
    await load();
    return null;
  };

  // ── Aged receivables / payables ──────────────────────────────────────────
  function agingPage(side) {
    const S = SIDE[side];
    return {
      title: side === "AR" ? "Receivables aging" : "Payables aging",
      perm: "journal.view",
      business: true,
      async render(ctx) {
        const at = ctx.params.at || ctx.today;
        const [rows, proof] = await Promise.all([
          ZL.rpc("trade_aging", { p_company: cid(), p_side: side, p_as_at: at }),
          ZL.can("report.view") || ZL.can("ledger.view") ? ZL.rpc("trade_proof", { p_company: cid() }).catch(() => null) : Promise.resolve(null),
        ]);
        ctx.rows = rows;
        const cols = [["not_due", "Current"], ["d1_30", "1–30"], ["d31_60", "31–60"], ["d61_90", "61–90"], ["d91_120", "91–120"], ["d120_plus", "120+"], ["unapplied", "Unapplied"], ["balance", "Balance"]];
        const tot = {}; cols.forEach(([k]) => { tot[k] = ZL.sum(rows, (r) => r[k]); });
        const ctl = proof ? proof.accounts.filter((x) => x.side === side) : [];
        const ties = ctl.length && ctl.every((x) => ZL.cents(x.difference) === 0);
        return ZL.header(side === "AR" ? "Receivables aging" : "Payables aging", `Open ${side === "AR" ? "invoices" : "bills"} by days past due, as at ${ZL.date(at)}.`,
            `<button type="button" class="zl-btn ghost" id="zl-acsv">Export CSV</button>`) + `
          <div class="toolbar"><label class="field"><span class="hint">As at</span><input id="zl-aat" type="date" value="${E(at)}" aria-label="As at"></label>${ZL.applyButton("zl-aapply")}</div>
          ${rows.length ? `<section class="card"><div class="tablewrap"><table>
            <thead><tr><th>${S.Who}</th>${cols.map(([, l]) => `<th class="r">${l}</th>`).join("")}</tr></thead>
            <tbody>${rows.map((r) => `<tr class="click" data-c="${r.contact_id}"><td><b style="font-weight:500">${E(r.name)}</b> <span class="code">${E(r.code)}</span>
              ${ZL.num(r.credit_limit) && ZL.num(r.balance) > ZL.num(r.credit_limit) ? ' <span class="chip bad">Over limit</span>' : ""}</td>
              ${cols.map(([k]) => `<td class="r num"${(k !== "not_due" && k !== "balance" && k !== "unapplied" && ZL.num(r[k]) > 0) ? ' style="color:var(--bad)"' : ""}>${ZL.num(r[k]) ? (k === "unapplied" ? `(${M(r[k])})` : M(r[k])) : "—"}</td>`).join("")}</tr>`).join("")}</tbody>
            <tfoot><tr><td><b>Total</b></td>${cols.map(([k]) => `<td class="r num"><b>${k === "unapplied" && tot[k] ? `(${M(tot[k])})` : M(tot[k])}</b></td>`).join("")}</tr></tfoot></table></div>
            ${ctl.length && at === ctx.today ? `<div class="proofrow"><span>${ties ? TICK + " " : ""}${ctl.map((x) => `${E(x.code)} ${E(x.name)}: ledger ${M(x.ledger)} · documents ${M(x.documents)}`).join(" · ")}</span>
              <span class="figs">${ties ? "Ties to the ledger" : `<span style="color:var(--bad)">Difference ${M(ctl.reduce((s, x) => s + ZL.num(x.difference), 0))} — amounts posted to the control account outside documents (e.g. an opening-balance journal). Reverse that entry and enter each balance on its ${S.who} instead.</span>`}</span></div>` : ""}
          </section>` : ZL.empty(`Nothing ${side === "AR" ? "owed to you" : "owing"}`, `No open ${side === "AR" ? "invoices or unapplied receipts" : "bills or unapplied payments"} as at ${E(ZL.date(at))}.`)}`;
      },
      after(root, ctx) {
        root.querySelectorAll("[data-c]").forEach((tr) => tr.addEventListener("click", () => ZL.open("contact", { id: tr.dataset.c, side })));
        ZL.wireApply(root, ["zl-aat"], "zl-aapply", () => ZL.open(S.aging, { at: root.querySelector("#zl-aat").value || null }));
        root.querySelector("#zl-acsv").addEventListener("click", () => ZL.csv(`${side === "AR" ? "receivables" : "payables"}-aging-${ctx.params.at || ctx.today}.csv`,
          [["Code", "Name", "Current", "1-30", "31-60", "61-90", "91-120", "120+", "Unapplied", "Balance"]].concat((ctx.rows || []).map((r) =>
            [r.code, r.name, ZL.num(r.not_due), ZL.num(r.d1_30), ZL.num(r.d31_60), ZL.num(r.d61_90), ZL.num(r.d91_120), ZL.num(r.d120_plus), -ZL.num(r.unapplied), ZL.num(r.balance)]))));
      },
    };
  }
  ZL.register("araging", agingPage("AR"));
  ZL.register("apaging", agingPage("AP"));

  // ── Items ────────────────────────────────────────────────────────────────
  async function editItem(it) {
    const [accounts, taxes] = await Promise.all([ZL.accounts(), taxCodes()]);
    const i = it || { uom: "UNIT", is_active: true };
    const accOpts = (side) => [{ value: "", label: "—" }].concat(TYPE_ORDER[side].flatMap((t) => accounts.filter((a) => a.type === t && lineUsable(a)).map((a) => ({ value: a.id, label: `${a.code} · ${a.name}`, group: TYPE_NAME[t] }))));
    const taxOpts = [{ value: "", label: "None" }].concat(taxes.filter((x) => x.is_active).map((x) => ({ value: x.id, label: `${x.code} · ${x.name}` })));
    const r = await ZL.form({ title: it ? `Edit ${it.code}` : "New item or service", wide: true, confirmLabel: it ? "Save" : "Add item",
      fields: [
        { name: "code", label: "Code", required: true, half: true, value: i.code || "", placeholder: "e.g. SVC-01" },
        { name: "uom", label: "Unit", half: true, value: i.uom || "UNIT", placeholder: "UNIT, HOUR, KG…" },
        { name: "description", label: "Description", required: true, value: i.description || "" },
        { name: "sell_price", label: "Selling price", type: "amount", half: true, value: ZL.num(i.sell_price) ? M(i.sell_price) : "" },
        { name: "buy_price", label: "Buying price", type: "amount", half: true, value: ZL.num(i.buy_price) ? M(i.buy_price) : "" },
        { name: "sales_account_id", label: "Sales account", type: "select", half: true, value: i.sales_account_id || "", options: accOpts("AR") },
        { name: "purchase_account_id", label: "Purchase account", type: "select", half: true, value: i.purchase_account_id || "", options: accOpts("AP") },
        { name: "sales_tax_code_id", label: "SST on sales", type: "select", half: true, value: i.sales_tax_code_id || "", options: taxOpts },
        { name: "purchase_tax_code_id", label: "SST on purchases", type: "select", half: true, value: i.purchase_tax_code_id || "", options: taxOpts },
        { name: "classification", label: "e-Invoice classification", half: true, value: i.classification || "", placeholder: "e.g. 022 (Others)", hint: "LHDN 3-digit code" },
        ...(it ? [{ name: "is_active", label: "Active", type: "checkbox", value: i.is_active }] : []),
      ],
      submit: (v) => ZL.rpc("save_item", { p_company: cid(), p_id: it ? it.id : null, p_data: Object.assign({}, v, {
        sell_price: v.sell_price === "" ? 0 : v.sell_price, buy_price: v.buy_price === "" ? 0 : v.buy_price, is_active: it ? v.is_active : true }) }) });
    if (r) { ZL.toast(it ? "Item saved." : "Item added."); ZL.refresh(); }
  }
  ZL.register("items", {
    title: "Items & services",
    perm: "journal.view",
    business: true,
    async render() {
      const [list, accounts, taxes] = await Promise.all([items(), ZL.accounts(), taxCodes()]);
      const acc = new Map(accounts.map((a) => [a.id, a])), tx = new Map(taxes.map((x) => [x.id, x]));
      const edit = ZL.can("journal.create");
      return ZL.header("Items & services", "What you sell and buy. Picking an item fills in the description, price, account and SST.",
          edit ? `<button type="button" class="zl-btn primary" id="zl-inew">+ New item</button>` : "") +
        (list.length ? `<section class="card"><div class="tablewrap"><table>
          <thead><tr><th>Code</th><th>Description</th><th>Unit</th><th class="r">Sell</th><th class="r">Buy</th><th>Sales account</th><th>SST</th><th></th></tr></thead>
          <tbody>${list.map((i) => `<tr${i.is_active ? "" : ' style="opacity:.6"'}><td class="mono">${E(i.code)}</td><td>${E(i.description)}${i.is_active ? "" : ' <span class="chip">Inactive</span>'}</td>
            <td class="nil">${E(i.uom)}</td><td class="r num">${M(i.sell_price)}</td><td class="r num">${M(i.buy_price)}</td>
            <td class="nil">${acc.get(i.sales_account_id) ? E(acc.get(i.sales_account_id).name) : "—"}</td><td class="nil">${tx.get(i.sales_tax_code_id) ? E(tx.get(i.sales_tax_code_id).code) : "—"}</td>
            <td class="r">${edit ? `<button type="button" class="zl-btn sm" data-iedit="${i.id}">Edit</button>` : ""}</td></tr>`).join("")}</tbody></table></div></section>`
          : ZL.empty("No items yet", "Items are optional — you can type any line on a document. Add the ones you use often."));
    },
    after(root) {
      const n = root.querySelector("#zl-inew");
      if (n) n.addEventListener("click", () => editItem(null));
      root.querySelectorAll("[data-iedit]").forEach((b) => b.addEventListener("click", async () => { const [it] = await ZL.select("items", "*", (q) => q.eq("id", b.dataset.iedit)); editItem(it); }));
    },
  });

  // ── Tax codes (SST) ──────────────────────────────────────────────────────
  async function editTax(x) {
    const accounts = await ZL.accounts();
    const v = x || { rate: 8, is_active: true, sales_account_id: (accounts.find((a) => a.code === "2150") || {}).id };
    const r = await ZL.form({ title: x ? `Edit ${x.code}` : "New tax code", confirmLabel: x ? "Save" : "Add tax code",
      fields: [
        { name: "code", label: "Code", required: true, half: true, value: v.code || "", placeholder: "e.g. SV8" },
        { name: "rate", label: "Rate %", type: "number", required: true, half: true, value: v.rate },
        { name: "name", label: "Name", required: true, value: v.name || "", placeholder: "e.g. Service tax 8%" },
        { name: "sales_account_id", label: "Output tax account (sales)", type: "select", value: v.sales_account_id || "",
          options: [{ value: "", label: "—" }].concat(accounts.filter((a) => a.type === "LIABILITY" && a.is_postable && a.is_active && !a.is_control).map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))) },
        { name: "purchase_account_id", label: "Input tax account (purchases)", type: "select", value: v.purchase_account_id || "",
          hint: "Leave as “Not claimable” for normal SST — the tax becomes part of the cost.",
          options: [{ value: "", label: "Not claimable — add to cost" }].concat(accounts.filter((a) => a.type === "ASSET" && a.is_postable && a.is_active && !a.is_control && !a.is_cash).map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))) },
        ...(x ? [{ name: "is_active", label: "Active", type: "checkbox", value: v.is_active }] : []),
      ],
      submit: (f) => ZL.rpc("save_tax_code", { p_company: cid(), p_id: x ? x.id : null, p_data: Object.assign({}, f, { is_active: x ? f.is_active : true }) }) });
    if (r) { ZL.toast("Tax code saved."); ZL.refresh(); }
  }
  ZL.register("taxcodes", {
    title: "Tax codes",
    perm: "company.view",
    business: true,
    async render() {
      const [list, accounts] = await Promise.all([taxCodes(), ZL.accounts()]);
      const acc = new Map(accounts.map((a) => [a.id, a]));
      const edit = ZL.can("company.edit");
      return ZL.header("Tax codes (SST)", "Sales and service tax rates used on documents. Output tax posts to its account; input tax is part of the cost unless you mark it claimable.",
          edit ? `<button type="button" class="zl-btn primary" id="zl-xnew">+ New tax code</button>` : "") + `
        <section class="card"><div class="tablewrap"><table><thead><tr><th>Code</th><th>Name</th><th class="r">Rate</th><th>Output tax to</th><th>Input tax</th><th></th></tr></thead>
          <tbody>${list.map((x) => `<tr${x.is_active ? "" : ' style="opacity:.6"'}><td class="mono">${E(x.code)}</td><td>${E(x.name)}${x.is_active ? "" : ' <span class="chip">Inactive</span>'}</td>
            <td class="r num">${+x.rate}%</td><td class="nil">${acc.get(x.sales_account_id) ? `${E(acc.get(x.sales_account_id).name)} <span class="code">${E(acc.get(x.sales_account_id).code)}</span>` : "—"}</td>
            <td class="nil">${acc.get(x.purchase_account_id) ? `Claimable → ${E(acc.get(x.purchase_account_id).name)}` : "Part of the cost"}</td>
            <td class="r">${edit ? `<button type="button" class="zl-btn sm" data-xedit="${x.id}">Edit</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="6" class="nil">No tax codes.</td></tr>'}</tbody></table></div></section>
        <p class="hint">A rate can't change once a document uses it — add a new code (e.g. SV8 after SV6) so old documents keep their rate.</p>`;
    },
    after(root) {
      const n = root.querySelector("#zl-xnew");
      if (n) n.addEventListener("click", () => editTax(null));
      root.querySelectorAll("[data-xedit]").forEach((b) => b.addEventListener("click", async () => { const [x] = await ZL.select("tax_codes", "*", (q) => q.eq("id", b.dataset.xedit)); editTax(x); }));
    },
  });

  // ── Cash book ────────────────────────────────────────────────────────────
  /** A receipt or payment with several lines — one OR/PV, many accounts. */
  ZL.cashEntry = async (kind = "OUT", preset = {}) => {
    if (!(ZL.can("journal.create") && ZL.can("journal.post"))) { ZL.toast("Your role can't record transactions in these books.", "bad"); return; }
    const P = ZL.isPersonal();
    const [accounts, taxes, numRows] = await Promise.all([ZL.accounts(), P ? Promise.resolve([]) : taxCodes(), ZL.numbering.load(ZL.today()).catch(() => [])]);
    const money = accounts.filter(isMoney);
    if (!money.length) { ZL.toast("Create a cash or bank account first.", "bad"); return; }
    const liveTax = taxes.filter((x) => x.is_active);
    const side = () => (root.querySelector('[name="kind"]').value === "IN" ? "AR" : "AP");
    const rows = [{}, {}];
    const rowHtml = (l, i) => `<tr data-ln="${i}">
      <td><select class="zl-input" data-f="account_id" aria-label="Account">${accOptions(accounts.filter((a) => !isMoney(a)), side(), l.account_id)}</select></td>
      <td><input class="zl-input" data-f="description" value="${E(l.description || "")}" maxlength="200" aria-label="Description"></td>
      ${liveTax.length ? `<td><select class="zl-input" data-f="tax_code_id" aria-label="SST"><option value="">None</option>${liveTax.map((x) => opt(x.id, `${x.code} ${+x.rate}%`, l.tax_code_id)).join("")}</select></td>` : ""}
      <td><input class="zl-input num r" data-f="amount" value="${E(l.amount || "")}" inputmode="decimal" placeholder="0.00" aria-label="Amount"></td>
      <td><button type="button" class="zl-x" data-del aria-label="Remove line">×</button></td></tr>`;
    const numKind = () => (root.querySelector('[name="kind"]').value === "IN" ? "RECEIPT" : "PAYMENT");
    const numHtml = (fs) => fs.map((x) => `<label class="zl-field"><span>${E(x.label)}</span>${x.type === "select" ? `<select class="zl-input" name="${x.name}">${x.options.map((o) => opt(o.value, o.label, x.value)).join("")}</select>` : `<input class="zl-input" name="${x.name}" value="${E(x.value)}">`}</label>`).join("");
    const numFields = ZL.numbering.fields(numRows, kind === "IN" ? "RECEIPT" : "PAYMENT", preset.money || money[0].id);
    const body = `<div class="zl-dochead">
        <label class="zl-field"><span>Type</span><select class="zl-input" name="kind">${opt("OUT", "Money out (PV)", kind)}${opt("IN", "Money in (OR)", kind)}</select></label>
        <label class="zl-field"><span>Date</span><input class="zl-input" type="date" name="date" value="${E(ZL.today())}"></label>
        <label class="zl-field wide"><span>Bank / cash account</span><select class="zl-input" name="money">${money.map((a) => opt(a.id, `${a.name} · ${a.code}`, preset.money)).join("")}</select></label>
        <label class="zl-field wide"><span>${P ? "Paid to / received from" : "Payee / payer"}</span><input class="zl-input" name="party" maxlength="200"></label>
        <label class="zl-field"><span>Method</span><select class="zl-input" name="method">${METHODS.map((m) => opt(m, m, "Bank transfer")).join("")}</select></label>
        <label class="zl-field"><span>Reference</span><input class="zl-input" name="reference" maxlength="40" placeholder="Optional"></label>
        <label class="zl-field wide"><span>Description</span><input class="zl-input" name="description" maxlength="500" placeholder="Optional — first line is used"></label>
        <div data-numslot style="display:contents">${numHtml(numFields)}</div>
      </div>
      ${liveTax.length ? `<label class="zl-check" style="margin:12px 0 4px"><input type="checkbox" name="incl" checked><span>Amounts include SST</span></label>` : ""}
      <div class="zl-lines-wrap"><table class="zl-lines" style="min-width:${liveTax.length ? 620 : 520}px"><thead><tr><th style="width:230px">Account</th><th>Description</th>${liveTax.length ? '<th style="width:110px">SST</th>' : ""}<th style="width:120px" class="r">Amount</th><th style="width:30px"></th></tr></thead><tbody id="zl-cl"></tbody></table></div>
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-top:8px"><button type="button" class="zl-btn sm ghost" id="zl-cladd">+ Add line</button><div class="zl-totals" id="zl-ctot"></div></div>`;
    let result = null, cap = null;
    const m = ZL.modal({ title: "Cash book entry", wide: true, body,
      actions: [{ label: "Cancel" }, { label: "Post", primary: true, onClick: async ({ root: r, close }) => {
        r.querySelectorAll("[data-ln]").forEach(read);
        const v = (n) => { const el = r.querySelector(`[name="${n}"]`); return el ? el.value.trim() : ""; };
        const lines = rows.filter((l) => l.account_id || l.amount).map((l) => {
          const a = ZL.parseAmount(l.amount);
          if (Number.isNaN(a) || !a) throw bad("Every line needs an amount like 1,250.00.");
          if (!l.account_id) throw bad("Every line needs an account.");
          return { account_id: l.account_id, description: l.description || null, amount: a, tax_code_id: l.tax_code_id || null };
        });
        if (!lines.length) throw bad("Add at least one line.");
        const num = numCtl ? numCtl.read() : {};
        result = await ZL.rpc("record_cash_entry", { p_company: cid(), p_kind: v("kind"), p_date: v("date"), p_money_account: v("money"), p_lines: lines,
          p_description: v("description") || null, p_party: v("party") || null, p_method: v("method") || null, p_reference: v("reference") || null,
          p_series: num.p_series || null, p_doc_no: num.p_doc_no || null, p_tax_inclusive: r.querySelector('[name="incl"]') ? r.querySelector('[name="incl"]').checked : true });
        if (cap) await cap.link("JOURNAL", result.id);
        close();
      } }],
      onClose: () => { if (result) { ZL.toast(`Posted as ${result.doc_no} (${result.reference}).`); ZL.refresh(); } } });
    const root = m.root;
    const tb = root.querySelector("#zl-cl");
    function read(tr) { const l = rows[Number(tr.dataset.ln)]; tr.querySelectorAll("[data-f]").forEach((el) => { l[el.dataset.f] = el.value.trim(); }); }
    const draw = () => { tb.innerHTML = rows.map(rowHtml).join(""); tot(); };
    const taxById = new Map(liveTax.map((x) => [x.id, x]));
    /** What the voucher comes to: SST is inside the amounts when "include SST" is ticked, added on top when it isn't. */
    const sums = () => {
      const inclEl = root.querySelector('[name="incl"]');
      const incl = inclEl ? inclEl.checked : true;
      let net = 0, tax = 0;
      rows.forEach((l) => {
        const a = ZL.parseAmount(l.amount) || 0, rate = ZL.num((taxById.get(l.tax_code_id) || {}).rate);
        const t = rate ? (incl ? r2((a * rate) / (100 + rate)) : r2((a * rate) / 100)) : 0;
        net += ZL.cents(incl ? a - t : a); tax += ZL.cents(t);
      });
      return { net: net / 100, tax: tax / 100, total: (net + tax) / 100 };
    };
    const tot = () => {
      const s = sums();
      root.querySelector("#zl-ctot").innerHTML = `${s.tax ? `<span>Before SST</span><b>${M(s.net)}</b><span>SST</span><b>${M(s.tax)}</b>` : ""}
        <span class="grand">Total</span><b class="grand">RM ${M(s.total)}</b>`;
    };
    tb.addEventListener("input", (ev) => { const tr = ev.target.closest("[data-ln]"); if (tr) { read(tr); tot(); } });
    tb.addEventListener("change", (ev) => {
      const tr = ev.target.closest("[data-ln]");
      if (tr) read(tr);
      if (ev.target.dataset.f === "amount") { const a = ZL.parseAmount(ev.target.value); if (!Number.isNaN(a) && a) ev.target.value = M(a); }
      tot();
    });
    if (root.querySelector('[name="incl"]')) root.querySelector('[name="incl"]').addEventListener("change", tot);
    tb.addEventListener("click", (ev) => { const d = ev.target.closest("[data-del]"); if (!d) return; tb.querySelectorAll("[data-ln]").forEach(read); rows.splice(Number(d.closest("[data-ln]").dataset.ln), 1); if (!rows.length) rows.push({}); draw(); });
    root.querySelector("#zl-cladd").addEventListener("click", () => { tb.querySelectorAll("[data-ln]").forEach(read); rows.push({}); draw(); });
    const wireNum = () => ZL.numbering.wire(root, numRows, numKind(), { dateInput: root.querySelector('[name="date"]'), moneyInput: root.querySelector('[name="money"]'), money: () => root.querySelector('[name="money"]').value });
    let numCtl = numFields.length ? wireNum() : null;
    root.querySelector('[name="kind"]').addEventListener("change", () => {
      tb.querySelectorAll("[data-ln]").forEach(read);
      draw();
      // A PV and an OR number from different series: rebuild the number fields for the new kind.
      const slot = root.querySelector("[data-numslot]");
      const fresh = ZL.numbering.fields(numRows, numKind(), root.querySelector('[name="money"]').value);
      slot.innerHTML = numHtml(fresh);
      numCtl = fresh.length ? wireNum() : null;
    });
    draw();

    // A receipt or bill: read it into lines, keep it with the voucher.
    if (ZL.capture) {
      const C = ZL.capture;
      cap = C.evidence(m, { preset: preset.attachment, fill: async (s, att, ev) => {
        const want = s.direction === "MONEY_IN" ? "IN" : "OUT";
        if (root.querySelector('[name="kind"]').value !== want) C.put(root, "kind", want);
        C.put(root, "date", s.date);
        C.put(root, "party", (s.counterparty && s.counterparty.name) || "");
        C.put(root, "method", C.methodFor(s));
        if (!preset.money) C.put(root, "money", C.moneyFor(s, money));
        C.put(root, "reference", (s.doc_no || s.payment_reference || "").slice(0, 40));
        C.put(root, "description", s.summary);
        const acc = await C.accountFor(s, accounts.filter((a) => !isMoney(a)), { direction: want, usable: lineUsable });
        const taxId = liveTax.length ? C.taxFor(s, liveTax) : "";
        const got = C.linesOf(s, { taxCode: !!taxId });
        if (got.lines.length) {
          rows.length = 0;
          got.lines.forEach((l) => rows.push({ account_id: acc, description: (l.description || "").slice(0, 200), tax_code_id: l.tax_rate === 0 || got.noTax ? "" : taxId, amount: M(l.amount) }));
          if (s.discount && got.discountOnLast) {
            const last = rows[rows.length - 1];
            last.amount = M(ZL.parseAmount(last.amount) - s.discount);
          }
          const incl = root.querySelector('[name="incl"]');
          if (incl) incl.checked = got.inclusive || !taxId;
          draw();
          tb.querySelectorAll("[data-f]").forEach((el) => { if (el.value) el.classList.add("zl-filled"); });
        }
        const got2 = sums();
        if (s.total != null && Math.abs(got2.total - Math.abs(s.total)) > 0.05) {
          ev.note(`The document's total is <b>RM ${M(Math.abs(s.total))}</b>; this voucher comes to RM ${M(got2.total)}. Adjust a line or the SST before you post.`, "warn");
        }
        if (s.tax_total > 0 && !taxId) ev.note(`SST of RM ${M(s.tax_total)} is shown but no tax code has that rate, so it's kept in the amount.`, "warn");
        if (!acc) ev.note("Choose the account on each line.");
      } });
    }
  };

  ZL.register("cashbook", {
    title: "Cash book",
    perm: "ledger.view",
    async render(ctx) {
      const p = ctx.params;
      const accounts = await ZL.accounts();
      const money = accounts.filter((a) => a.is_postable && (a.is_cash || (ZL.isPersonal() && a.type === "LIABILITY" && a.sub_type === "CURRENT_LIABILITY")));
      if (!money.length) return ZL.header("Cash book", "") + ZL.empty("No bank or cash accounts", "Add a bank or cash account in the chart of accounts first.");
      const acc = money.find((a) => a.id === p.account) || money.find((a) => a.code === "1131") || money[0];
      const from = p.from || ZL.monthStart(ctx.today), to = p.to || ZL.monthEnd(ctx.today);
      const cb = await ZL.rpc("cash_book", { p_company: cid(), p_account: acc.id, p_from: from, p_to: to });
      ctx.cb = cb; ctx.acc = acc;
      const canRecord = ZL.can("journal.create") && ZL.can("journal.post");
      return ZL.header("Cash book", "Every receipt and payment through one bank or cash account, with the running balance.",
          `<button type="button" class="zl-btn ghost" id="zl-cbcsv">Export CSV</button><button type="button" class="zl-btn ghost" id="zl-cbprint">Print</button>` +
          (canRecord ? `<button type="button" class="zl-btn primary" id="zl-cbnew">+ Cash book entry</button>` : "")) + `
        <div class="toolbar">
          <label class="field"><select id="zl-cbacc" aria-label="Account">${money.map((a) => opt(a.id, `${a.name} · ${a.code}`, acc.id)).join("")}</select></label>
          <label class="field"><span class="hint">From</span><input id="zl-cbfrom" type="date" value="${E(from)}" aria-label="From"></label>
          <label class="field"><span class="hint">To</span><input id="zl-cbto" type="date" value="${E(to)}" aria-label="To"></label>
          ${ZL.applyButton("zl-cbapply")}
        </div>
        <div class="zl-sumrow"><span>Opening<b class="num">${M(cb.opening, { symbol: true })}</b></span><span>Receipts<b class="num" style="color:var(--good)">${M(cb.receipts, { symbol: true })}</b></span>
          <span>Payments<b class="num">${M(cb.payments, { symbol: true })}</b></span><span>Closing<b class="num">${M(cb.closing, { symbol: true })}</b></span></div>
        <section class="card" id="zl-cbtable"><div class="tablewrap"><table>
          <thead><tr><th>Date</th><th>No.</th><th>Particulars</th><th>Account</th><th class="r">Receipts</th><th class="r">Payments</th><th class="r">Balance</th></tr></thead>
          <tbody><tr><td class="nil">${ZL.date(from)}</td><td></td><td class="nil">Opening balance</td><td></td><td></td><td></td><td class="r num"><b>${M(cb.opening)}</b></td></tr>
          ${cb.lines.map((l) => `<tr class="click" data-open-journal="${l.entry_id}"><td class="nil" style="white-space:nowrap">${ZL.date(l.date)}</td>
            <td style="white-space:nowrap"><span class="mono">${E(l.doc_no || l.reference)}</span>${l.doc_no ? `<div class="hint">${E(l.reference)}</div>` : ""}</td>
            <td>${E(l.party || l.description || "")}${l.party && l.description ? `<div class="hint">${E(l.description)}</div>` : ""}${l.status === "REVERSED" ? ' <span class="chip warn">Reversed</span>' : ""}</td>
            <td class="nil">${E(l.contra || "")}</td>
            <td class="r num" style="color:var(--good)">${ZL.num(l.receipt) ? M(l.receipt) : ""}</td><td class="r num">${ZL.num(l.payment) ? M(l.payment) : ""}</td>
            <td class="r num">${M(l.balance)}</td></tr>`).join("")}
          </tbody><tfoot><tr><td colspan="4"><b>Closing balance</b></td><td class="r num"><b>${M(cb.receipts)}</b></td><td class="r num"><b>${M(cb.payments)}</b></td><td class="r num"><b>${M(cb.closing)}</b></td></tr></tfoot></table></div>
          ${cb.lines.length ? "" : `<p class="nil" style="padding:0 18px 16px">No receipts or payments in this period.</p>`}</section>`;
    },
    after(root, ctx) {
      const p = ctx.params;
      if (!ctx.cb) return;
      const n = root.querySelector("#zl-cbnew");
      if (n) n.addEventListener("click", () => ZL.cashEntry("OUT", { money: ctx.acc.id }));
      root.querySelector("#zl-cbacc").addEventListener("change", (ev) => ZL.open("cashbook", Object.assign({}, p, { account: ev.target.value })));
      ZL.wireApply(root, ["zl-cbfrom", "zl-cbto"], "zl-cbapply", () => {
        const from = root.querySelector("#zl-cbfrom").value, to = root.querySelector("#zl-cbto").value;
        if (from && to && from > to) { ZL.toast("The start date is after the end date.", "warn"); return; }
        ZL.open("cashbook", Object.assign({}, p, { from, to }));
      });
      root.querySelector("#zl-cbcsv").addEventListener("click", () => ZL.csv(`cash-book-${ctx.acc.code}-${ctx.cb.from || ""}-${ctx.cb.to}.csv`,
        [["Date", "No.", "Journal", "Particulars", "Account", "Receipts", "Payments", "Balance"], [ctx.cb.from || "", "", "", "Opening balance", "", "", "", ZL.num(ctx.cb.opening)]]
          .concat(ctx.cb.lines.map((l) => [l.date, l.doc_no || "", l.reference, l.party || l.description || "", l.contra || "", ZL.num(l.receipt), ZL.num(l.payment), ZL.num(l.balance)]))));
      root.querySelector("#zl-cbprint").addEventListener("click", async () => {
        const info = await ZL.companyInfo();
        const ds = await ZL.docSettings();
        const cb = ctx.cb;
        const html = shell(ds, `${letterhead(info, ds, "Cash Book", [["Account", `${ctx.acc.code} ${ctx.acc.name}`], ["Period", `${ZL.date(cb.from)} – ${ZL.date(cb.to)}`]])}
          <table class="zv-lines zv-items" style="margin-top:14px"><thead><tr><th>Date</th><th>No.</th><th>Particulars</th><th class="r">Receipts</th><th class="r">Payments</th><th class="r">Balance</th></tr></thead>
          <tbody><tr><td>${E(ZL.date(cb.from))}</td><td></td><td>Opening balance</td><td></td><td></td><td class="r">${M(cb.opening)}</td></tr>
          ${cb.lines.map((l) => `<tr><td>${E(ZL.date(l.date))}</td><td>${E(l.doc_no || l.reference)}</td><td>${E(l.party || l.description || "")}<div class="acct">${E(l.contra || "")}</div></td>
            <td class="r">${ZL.num(l.receipt) ? M(l.receipt) : ""}</td><td class="r">${ZL.num(l.payment) ? M(l.payment) : ""}</td><td class="r">${M(l.balance)}</td></tr>`).join("")}</tbody>
          <tfoot><tr><td colspan="3">Closing balance</td><td class="r">${M(cb.receipts)}</td><td class="r">${M(cb.payments)}</td><td class="r">${M(cb.closing)}</td></tr></tfoot></table>
          <div class="zv-gen">Computer-generated from the general ledger in Zycount.</div>`);
        ZL.voucherPrint(html, `Cash book ${ctx.acc.code}`);
      });
      ZL.wireJournalLinks(root);
    },
  });

  const css = document.createElement("style");
  css.textContent = `
  .zl-scrim .zl-modal{min-width:0}
  .zl-scrim .zl-modal.xl{width:min(1160px,100%)}
  .zl-modal-body{min-width:0}
  .zl-dochead{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 14px}
  .zl-dochead .zl-field{margin:0}
  .zl-dochead .wide{grid-column:span 2}
  @media (max-width:900px){.zl-dochead{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media (max-width:520px){.zl-dochead{grid-template-columns:minmax(0,1fr)}.zl-dochead .wide{grid-column:auto}}
  .zl-lines-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;margin-top:6px;width:100%;min-width:0}
  .zl-lines{width:100%;min-width:1150px;border-collapse:collapse;font-size:13px}
  html .zl-lines th,html.zl-live .zl-lines th{font-size:11.5px;color:var(--ink-3);font-weight:500;text-align:left;padding:7px 6px;background:var(--sunk);border-bottom:1px solid var(--line);text-transform:none;letter-spacing:0;height:auto;position:static}
  html .zl-lines td,html.zl-live .zl-lines td{padding:4px 4px;border-bottom:1px solid var(--line-2);vertical-align:middle;height:auto}
  .zl-lines tr:last-child td{border-bottom:0}
  .zl-lines .zl-input{padding:6px 8px;font-size:13px;width:100%;min-width:0}
  .zl-lines .r,.zl-lines .zl-input.r{text-align:right}
  .zl-lines .amt{padding:8px;font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right}
  .zl-x{all:unset;cursor:pointer;color:var(--ink-3);padding:4px 8px;border-radius:6px;font-size:16px;line-height:1}
  .zl-x:hover,.zl-x:focus-visible{color:var(--bad);background:var(--bad-soft)}
  .zl-totals{display:grid;grid-template-columns:auto minmax(120px,auto);gap:4px 18px;justify-content:end;font-size:13.5px;color:var(--ink-2);margin-left:auto}
  .zl-totals b{text-align:right;font-variant-numeric:tabular-nums;color:var(--ink)}
  .zl-totals .grand{font-size:16px;font-weight:700;color:var(--ink)}
  .zl-new{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}
  .zl-facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px 22px;padding:16px 20px}
  .zl-facts span{display:block;font-size:12px;color:var(--ink-3);margin-bottom:2px}
  .zl-facts b{font-size:14.5px;font-weight:600;word-break:break-word}
  @media (max-width:760px){.zl-facts{grid-template-columns:repeat(2,minmax(0,1fr))}}
  .zl-crumbs{font-size:12.5px;color:var(--ink-3);margin:0 0 6px}
  `;
  document.head.appendChild(css);
})();
