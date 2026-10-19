/* ═══════════════════════════════════════════════════════════════════════════
 * Zycount live workspace — payment vouchers (PV) and official receipts (OR).
 * Every money-in and money-out gets its own number (OR-2026-000001, PV-2026-000001)
 * in the database when it is posted. This file prints them on the company's own
 * template (logo, colour, titles, signature boxes) and saves them as PDF.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const ZL = window.ZL;
  const E = ZL.esc;
  const M = ZL.money;
  const cid = () => ZL.company.company_id;

  const LIBS = {
    pdf: { src: "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js",
      integrity: "sha384-Yv5O+t3uE3hunW8uyrbpPW3iw6/5/Y7HitWJBLgqfMoA36NogMmy+8wWZMpn3HWc" },
    xlsx: { src: "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
      integrity: "sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw" },
    pdfjs: { src: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
      integrity: "sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e" },
    qr: { src: "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js",
      integrity: "sha384-mZT2gIty7ZDdOGkxfP6joZcYdMW1Jvj9dRlfpTmaJAKKXTqzygtB22k7FLe+KZC1" },
  };
  const loading = {};
  /** Loads a pinned library from cdnjs once, checked against its hash. */
  ZL.lib = (name) => loading[name] || (loading[name] = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = LIBS[name].src;
    s.integrity = LIBS[name].integrity;
    s.crossOrigin = "anonymous";
    s.onload = resolve;
    s.onerror = () => { delete loading[name]; s.remove(); reject(new ZL.ZLError("NETWORK", "A component didn't load. Check your connection and try again.")); };
    document.head.appendChild(s);
  }));

  // ── Template settings ─────────────────────────────────────────────────────
  const DEFAULTS = { logo: null, accent: "#3A3FD0", pv_title: "Payment Voucher", or_title: "Official Receipt", footer: "",
    sign_labels: ["Prepared by", "Approved by", "Received by"], show_lines: true };
  ZL.docSettings = async (force = false) => {
    if (!ZL._docs || force || ZL._docs.company_id !== cid()) {
      const rows = await ZL.select("document_settings", "*", (q) => q.eq("company_id", cid()));
      ZL._docs = Object.assign({}, DEFAULTS, rows[0] || {}, { company_id: cid() });
    }
    return ZL._docs;
  };

  // ── Amount in words (Malaysian cheque style) ──────────────────────────────
  const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
    "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const hundreds = (n) => {
    const out = [];
    if (n >= 100) { out.push(ONES[Math.floor(n / 100)] + " Hundred"); n %= 100; }
    if (n >= 20) out.push(TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : ""));
    else if (n) out.push(ONES[n]);
    return out.join(" ");
  };
  const words = (n) => {
    if (!n) return "Zero";
    const scale = ["", " Thousand", " Million", " Billion", " Trillion"];
    const out = [];
    for (let i = 0; n > 0; i++, n = Math.floor(n / 1000)) if (n % 1000) out.unshift(hundreds(n % 1000) + scale[i]);
    return out.join(" ");
  };
  ZL.amountWords = (v) => {
    const c = Math.abs(ZL.cents(v)), rm = Math.floor(c / 100), sen = c % 100;
    return `Ringgit Malaysia ${words(rm)}${sen ? ` and Sen ${words(sen)}` : ""} Only`;
  };

  // ── The document ──────────────────────────────────────────────────────────
  const VCSS = `
  .zv{--acc:#3A3FD0;background:#fff;color:#1b1d24;font:12.5px/1.45 "Inter",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
    width:100%;max-width:760px;margin:0 auto;padding:34px 36px 26px;box-sizing:border-box;position:relative;border:1px solid #e6e7ec;border-radius:6px}
  .zv *{box-sizing:border-box}
  .zv.zv table th,.zv.zv table td{height:auto;position:static;background:none;text-transform:none;letter-spacing:0;font-size:inherit;color:inherit;border:0;vertical-align:top}
  .zv.zv .zv-top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;padding-bottom:18px;border-bottom:3px solid var(--acc)}
  .zv.zv .zv-co{display:flex;gap:14px;align-items:flex-start;min-width:0}
  .zv.zv .zv-co img{max-height:64px;max-width:150px;object-fit:contain}
  .zv.zv .zv-co b{display:block;font-size:15px;color:#0f1116}
  .zv.zv .zv-co div{color:#5b6070;font-size:11.5px}
  .zv.zv .zv-ttl{text-align:right;flex-shrink:0}
  .zv.zv .zv-ttl h2{margin:0 0 8px;font-size:20px;letter-spacing:.06em;text-transform:uppercase;color:var(--acc);font-weight:700}
  .zv.zv .zv-meta{border-collapse:collapse;margin-left:auto}
  .zv.zv .zv-meta th{font-weight:500;color:#5b6070;text-align:left;padding:2px 12px 2px 0;font-size:11.5px}
  .zv.zv .zv-meta td{text-align:right;font-weight:600;font-variant-numeric:tabular-nums;padding:2px 0}
  .zv.zv .zv-party{display:grid;grid-template-columns:1.6fr 1fr 1fr;gap:10px 18px;margin:18px 0}
  .zv.zv .zv-party span{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#7a7f8c;margin-bottom:2px}
  .zv.zv .zv-party b{font-weight:600;display:block;min-height:18px;border-bottom:1px dotted #c9ccd6;padding-bottom:2px}
  .zv.zv .zv-lines{width:100%;border-collapse:collapse;margin-top:4px}
  .zv.zv .zv-lines th{background:var(--acc-soft,#eef0fb);color:#2a2e3a;font-weight:600;font-size:11px;text-align:left;padding:8px 10px;border-bottom:1px solid #dcdfe7}
  .zv.zv .zv-lines td{padding:9px 10px;border-bottom:1px solid #eceef3;vertical-align:top}
  .zv.zv .zv-lines .r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .zv.zv .zv-lines .acct{color:#6b7080;font-size:11px}
  .zv.zv .zv-lines tfoot td{font-weight:700;border-bottom:2px solid #1b1d24;border-top:1px solid #1b1d24;font-size:13px}
  .zv.zv .zv-words{margin:14px 0 4px;padding:10px 12px;background:#f6f7f9;border-radius:4px}
  .zv.zv .zv-words span{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#7a7f8c;display:block}
  .zv.zv .zv-words b{font-weight:600}
  .zv.zv .zv-sign{display:grid;gap:22px;margin-top:46px}
  .zv.zv .zv-sign div{border-top:1px solid #1b1d24;padding-top:5px;font-size:11px;color:#5b6070}
  .zv.zv .zv-sign div small{display:block;margin-top:14px;color:#9a9fab}
  .zv.zv .zv-foot{margin-top:22px;padding-top:10px;border-top:1px solid #eceef3;color:#5b6070;font-size:11px;white-space:pre-line}
  .zv.zv .zv-gen{margin-top:8px;color:#9a9fab;font-size:10px}
  .zv.zv .zv-void{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
  .zv.zv .zv-void span{transform:rotate(-24deg);font-size:84px;font-weight:800;letter-spacing:.1em;color:rgba(200,30,30,.13);border:6px solid rgba(200,30,30,.13);padding:4px 26px;border-radius:10px}
  @media (max-width:640px){.zv.zv{padding:20px 16px}.zv.zv .zv-top{flex-direction:column}.zv.zv .zv-ttl{text-align:left}.zv.zv .zv-meta{margin-left:0}.zv.zv .zv-party{grid-template-columns:1fr 1fr}}
  .zl-vwrap{background:#eef0f4;padding:18px;border-radius:8px;overflow:auto;max-height:70vh}
  html.zl-live.dark .zl-vwrap,html[data-theme="dark"] .zl-vwrap{background:#23262e}
  .zl-tpl{display:grid;grid-template-columns:minmax(280px,360px) 1fr;gap:20px;align-items:start}
  .zl-tpl .zl-vwrap{max-height:none;position:sticky;top:12px}
  @media (max-width:1000px){.zl-tpl{grid-template-columns:1fr}.zl-tpl .zl-vwrap{position:static}}
  .zl-logo-box{display:flex;gap:12px;align-items:center;padding:10px;border:1px dashed var(--line);border-radius:8px;margin-bottom:14px}
  .zl-logo-box img{max-height:48px;max-width:120px;object-fit:contain;background:#fff;border-radius:4px}
  .zl-logo-box .nil{font-size:12px}
  `;
  const style = document.createElement("style");
  style.id = "zl-voucher-css";
  style.textContent = VCSS;
  document.head.appendChild(style);

  const methodLabel = (m) => m || "";
  /** The accent mixed with white (PDF rendering can't read color-mix). */
  const tint = (hex, k) => {
    const n = /^#[0-9a-f]{6}$/i.test(hex || "") ? parseInt(hex.slice(1), 16) : 0x3a3fd0;
    const ch = (sh) => Math.round(((n >> sh) & 255) * k + 255 * (1 - k)).toString(16).padStart(2, "0");
    return `#${ch(16)}${ch(8)}${ch(0)}`;
  };

  /** Builds the printable voucher/receipt. data = { entry, accounts, info, ds } */
  ZL.voucherHtml = ({ entry, accounts, info, ds }) => {
    const acc = new Map(accounts.map((a) => [a.id, a]));
    const isOR = entry.doc_type === "OR";
    const lines = (entry.journal_lines || []).slice().sort((a, b) => (a.line_no || 0) - (b.line_no || 0));
    const moneyLine = lines.find((l) => ZL.cents(isOR ? l.debit : l.credit) > 0);
    const items = lines.filter((l) => l !== moneyLine && ZL.cents(isOR ? l.credit : l.debit) > 0);
    const total = ZL.cents(entry.total_debit) / 100;
    const accName = (l) => { const a = l && acc.get(l.account_id); return a ? `${a.name} · ${a.code}` : ""; };
    const title = entry.series_title || (isOR ? ds.or_title : ds.pv_title);
    const labels = (ds.sign_labels || []).filter(Boolean).slice(0, 4);
    const addr = [info.address].filter(Boolean).map(E).join("");
    const contact = [info.phone, info.email].filter(Boolean).map(E).join(" · ");
    const ids = [info.registration_no ? `Reg. no. ${E(info.registration_no)}` : "", info.tax_no ? `SST no. ${E(info.tax_no)}` : ""].filter(Boolean).join(" · ");
    const rows = ds.show_lines && items.length
      ? items.map((l) => `<tr><td>${E(l.description || entry.description || "")}<div class="acct">${E(accName(l))}</div></td>
          <td class="r">${M(isOR ? l.credit : l.debit)}</td></tr>`).join("")
      : `<tr><td>${E(entry.description || "")}</td><td class="r">${M(total)}</td></tr>`;
    const accent = /^#[0-9a-f]{6}$/i.test(ds.accent || "") ? ds.accent : DEFAULTS.accent;
    return `<div class="zv" style="--acc:${accent};--acc-soft:${tint(accent, 0.09)}">
      ${entry.status === "REVERSED" ? `<div class="zv-void"><span>CANCELLED</span></div>` : ""}
      <div class="zv-top">
        <div class="zv-co">${ds.logo ? `<img src="${E(ds.logo)}" alt="">` : ""}
          <div><b>${E(info.name || "")}</b>${ids ? `<div>${ids}</div>` : ""}${addr ? `<div style="white-space:pre-line">${addr}</div>` : ""}${contact ? `<div>${contact}</div>` : ""}</div></div>
        <div class="zv-ttl"><h2>${E(title)}</h2>
          <table class="zv-meta"><tr><th>No.</th><td>${E(entry.doc_no || "—")}</td></tr>
            <tr><th>Date</th><td>${E(ZL.date(entry.date))}</td></tr>
            ${entry.memo ? `<tr><th>Reference</th><td>${E(entry.memo)}</td></tr>` : ""}</table></div>
      </div>
      <div class="zv-party">
        <div><span>${isOR ? "Received from" : "Paid to"}</span><b>${E(entry.party || "")}</b></div>
        <div><span>${isOR ? "Received into" : "Paid from"}</span><b>${E(accName(moneyLine).split(" · ")[0])}</b></div>
        <div><span>Payment method</span><b>${E(methodLabel(entry.pay_method))}</b></div>
      </div>
      <table class="zv-lines"><thead><tr><th>${isOR ? "Being payment for" : "Particulars"}</th><th class="r" style="width:150px">Amount (RM)</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td>Total</td><td class="r">RM ${M(total)}</td></tr></tfoot></table>
      <div class="zv-words"><span>Amount in words</span><b>${E(ZL.amountWords(total))}</b></div>
      ${labels.length ? `<div class="zv-sign" style="grid-template-columns:repeat(${labels.length},1fr)">${labels.map((l) =>
        `<div>${E(l)}<small>Name / date</small></div>`).join("")}</div>` : ""}
      ${ds.footer ? `<div class="zv-foot">${E(ds.footer)}</div>` : ""}
      <div class="zv-gen">Computer-generated from journal ${E(entry.reference || "")} in Zycount.${entry.status === "REVERSED" ? " This document was cancelled by a reversal." : ""}</div>
    </div>`;
  };

  const ENTRY_COLS = "id,reference,date,description,memo,status,doc_type,doc_no,doc_series_id,party,pay_method,total_debit,reversal_of_id,journal_lines(account_id,description,debit,credit,line_no)";

  async function loadVoucher(id) {
    const [rows, accounts, info, ds] = await Promise.all([
      ZL.select("journal_entries", ENTRY_COLS, (q) => q.eq("id", id).eq("company_id", cid())),
      ZL.accounts(), ZL.companyInfo(), ZL.docSettings(),
    ]);
    if (!rows[0]) throw new ZL.ZLError("NOT_FOUND", "That transaction isn't in these books.");
    if (!rows[0].doc_no) throw new ZL.ZLError("VALIDATION", "Only money in and money out have a voucher or receipt.");
    if (rows[0].doc_series_id) {
      const [ser] = await ZL.select("document_series", "title", (q) => q.eq("id", rows[0].doc_series_id));
      if (ser && ser.title) rows[0].series_title = ser.title;
    }
    return { entry: rows[0], accounts, info, ds };
  }

  /** A4 PDF of a rendered .zv element. */
  ZL.voucherPdf = async (html, filename) => {
    await ZL.lib("pdf");
    const holder = document.createElement("div");
    holder.style.cssText = "position:fixed;left:-10000px;top:0;width:760px;background:#fff";
    holder.innerHTML = html;
    const el = holder.firstElementChild;
    el.style.border = "0";
    document.body.appendChild(holder);
    try {
      await window.html2pdf().set({
        margin: [8, 8, 8, 8], filename,
        image: { type: "jpeg", quality: 0.96 },
        html2canvas: { scale: 2, backgroundColor: "#ffffff", useCORS: true },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      }).from(el).save();
    } finally { holder.remove(); }
  };

  /** Prints only the document, through a hidden frame. */
  ZL.voucherPrint = (html, title) => {
    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    document.body.appendChild(f);
    const d = f.contentDocument;
    d.open();
    d.write(`<!doctype html><html><head><meta charset="utf-8"><title>${E(title)}</title><style>${VCSS}
      @page{size:A4;margin:10mm} body{margin:0} .zv{border:0;max-width:none}</style></head><body>${html}</body></html>`);
    d.close();
    setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 1500); }, 250);
  };

  /** Opens the voucher/receipt for a posted money-in or money-out. */
  ZL.voucher = async (id) => {
    let data;
    try { data = await loadVoucher(id); } catch (e) { ZL.toast(ZL.errorText(e), "bad"); return; }
    const html = ZL.voucherHtml(data);
    const e = data.entry;
    const name = `${e.doc_no}.pdf`;
    ZL.modal({
      title: `${e.series_title || (e.doc_type === "OR" ? data.ds.or_title : data.ds.pv_title)} ${e.doc_no}`, wide: true,
      body: `<div class="zl-vwrap">${html}</div>`,
      actions: [
        ...(ZL.can("company.edit") ? [{ label: "Edit template", onClick: ({ close }) => { close(); ZL.open("templates", {}); } }] : []),
        { label: "Print", onClick: () => ZL.voucherPrint(html, e.doc_no) },
        { label: "Download PDF", primary: true, onClick: async () => { await ZL.voucherPdf(html, name); ZL.toast(`Saved ${name}.`); } },
      ],
    });
  };

  // ── Template page ─────────────────────────────────────────────────────────
  /** Shrinks an uploaded logo so it stays small in the database and sharp on A4. */
  function readLogo(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) return reject(new ZL.ZLError("VALIDATION", "Use a PNG, JPG, WebP or SVG image."));
      if (file.size > 5 * 1024 * 1024) return reject(new ZL.ZLError("VALIDATION", "That image is over 5 MB. Choose a smaller one."));
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, 600 / img.naturalWidth, 240 / img.naturalHeight);
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.naturalWidth * k));
        c.height = Math.max(1, Math.round(img.naturalHeight * k));
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        let out = c.toDataURL("image/png");
        if (out.length > 380000) {
          // Too detailed for PNG: flatten onto white and use JPEG.
          g.globalCompositeOperation = "destination-over";
          g.fillStyle = "#fff";
          g.fillRect(0, 0, c.width, c.height);
          out = c.toDataURL("image/jpeg", 0.85);
        }
        resolve(out);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new ZL.ZLError("VALIDATION", "That file couldn't be read as an image.")); };
      img.src = url;
    });
  }

  const SAMPLE = (kind) => ({
    id: "sample", reference: "JV-2026-000123", date: ZL.today(), status: "POSTED", doc_type: kind, total_debit: 1060,
    doc_no: `${kind}-${ZL.today().slice(0, 4)}-000001`, memo: kind === "OR" ? "INV-1024" : "TNB-0925",
    description: kind === "OR" ? "Payment for invoice 1024" : "Electricity for September",
    party: kind === "OR" ? "Syarikat ABC Sdn Bhd" : "Tenaga Nasional Berhad", pay_method: "Bank transfer",
    journal_lines: kind === "OR"
      ? [{ account_id: "m", debit: 1060, credit: 0, line_no: 1 }, { account_id: "r", debit: 0, credit: 1000, line_no: 2, description: "Consulting services — September" },
        { account_id: "t", debit: 0, credit: 60, line_no: 3, description: "SST 6%" }]
      : [{ account_id: "x", debit: 1060, credit: 0, line_no: 1, description: "Electricity — September" }, { account_id: "m", debit: 0, credit: 1060, line_no: 2 }],
  });
  const SAMPLE_ACCOUNTS = [{ id: "m", code: "1131", name: "Bank — current account" }, { id: "r", code: "4100", name: "Sales" },
    { id: "t", code: "2150", name: "SST output tax" }, { id: "x", code: "6200", name: "Utilities" }];

  ZL.register("templates", {
    title: "Voucher template",
    perm: "company.view",
    async render(ctx) {
      const [ds, info, latest] = await Promise.all([
        ZL.docSettings(true), ZL.companyInfo(),
        ZL.select("journal_entries", "id,doc_type", (q) => q.eq("company_id", cid()).not("doc_no", "is", null).order("posted_at", { ascending: false }).limit(1)),
      ]);
      ctx.params.ds = ctx.params.ds || Object.assign({}, ds);
      const d = ctx.params.ds;
      const edit = ZL.can("company.edit");
      const P = ZL.isPersonal();
      const labels = (d.sign_labels || []).concat(["", "", "", ""]).slice(0, 4);
      const kind = ctx.params.kind || "PV";
      const field = (name, label, value, attrs = "") => `<label class="zl-field"><span>${label}</span><input class="zl-input" name="${name}" value="${E(value || "")}" ${attrs}${edit ? "" : " disabled"}></label>`;
      return ZL.header(P ? "Receipt template" : "Voucher template",
          "How your payment vouchers (PV) and official receipts (OR) look when printed or saved as PDF.",
          edit ? `<button type="button" class="zl-btn primary" id="zl-tsave">Save template</button>` : "") + `
        <div class="zl-tpl">
          <section class="card" style="padding:18px 20px">
            <div class="zl-logo-box" id="zl-logo-box">${d.logo ? `<img src="${E(d.logo)}" alt="Logo">` : `<span class="nil">No logo yet</span>`}
              ${edit ? `<span style="margin-left:auto;display:flex;gap:6px"><label class="zl-btn sm" style="cursor:pointer">Upload logo<input type="file" id="zl-logo" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden></label>
              ${d.logo ? `<button type="button" class="zl-btn sm ghost" id="zl-logo-x">Remove</button>` : ""}</span>` : ""}</div>
            <div class="zl-form" id="zl-tform">
              <label class="zl-field half"><span>Accent colour</span><input class="zl-input" type="color" name="accent" value="${E(d.accent)}" style="height:38px;padding:3px"${edit ? "" : " disabled"}></label>
              <label class="zl-field half"><span>Show</span><select class="zl-input" name="show_lines"${edit ? "" : " disabled"}>
                <option value="1"${d.show_lines ? " selected" : ""}>Each line</option><option value="0"${d.show_lines ? "" : " selected"}>One total line</option></select></label>
              ${field("pv_title", "Payment title", d.pv_title, 'maxlength="60"')}
              ${field("or_title", "Receipt title", d.or_title, 'maxlength="60"')}
              <label class="zl-field"><span>Footer note</span><textarea class="zl-input" name="footer" rows="3" maxlength="500" placeholder="e.g. Bank details, terms, or a thank-you line"${edit ? "" : " disabled"}>${E(d.footer || "")}</textarea></label>
              <div class="zl-field"><span>Signature boxes <small class="hint">(leave blank to hide)</small></span>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${labels.map((l, i) =>
                  `<input class="zl-input" name="sign${i}" value="${E(l)}" maxlength="40" placeholder="Box ${i + 1}"${edit ? "" : " disabled"}>`).join("")}</div></div>
            </div>
            <p class="hint" style="margin-top:12px">Company name, registration no., SST no., address and phone come from <button type="button" class="zl-ref" id="zl-tco">Settings</button>.</p>
          </section>
          <div>
            <div class="seg" role="group" aria-label="Preview" style="margin-bottom:10px">
              <button type="button" data-tkind="PV" aria-pressed="${kind === "PV"}">Payment voucher</button>
              <button type="button" data-tkind="OR" aria-pressed="${kind === "OR"}">Official receipt</button>
              <button type="button" class="zl-btn sm ghost" id="zl-tpdf" style="margin-left:8px">Sample PDF</button>
            </div>
            <div class="zl-vwrap" id="zl-tprev">${ZL.voucherHtml({ entry: SAMPLE(kind), accounts: SAMPLE_ACCOUNTS, info, ds: d })}</div>
            <p class="hint" style="margin-top:8px">Sample figures. ${latest[0] ? `<button type="button" class="zl-ref" id="zl-tlatest" data-id="${latest[0].id}">Open your latest ${latest[0].doc_type === "OR" ? "receipt" : "voucher"}</button>` : "Your own vouchers appear under Transactions once you record money in or out."}</p>
          </div>
        </div>`;
    },
    after(root, ctx) {
      const p = ctx.params;
      const d = p.ds;
      const info = ZL._info || {};
      const form = root.querySelector("#zl-tform");
      const read = () => {
        const g = (n) => form.querySelector(`[name="${n}"]`).value;
        Object.assign(d, { accent: g("accent"), show_lines: g("show_lines") === "1", pv_title: g("pv_title").trim() || "Payment Voucher",
          or_title: g("or_title").trim() || "Official Receipt", footer: g("footer").trim(),
          sign_labels: [0, 1, 2, 3].map((i) => g("sign" + i).trim()).filter(Boolean) });
      };
      const draw = () => { root.querySelector("#zl-tprev").innerHTML = ZL.voucherHtml({ entry: SAMPLE(p.kind || "PV"), accounts: SAMPLE_ACCOUNTS, info, ds: d }); };
      form.addEventListener("input", () => { read(); draw(); });
      form.addEventListener("change", () => { read(); draw(); });
      root.querySelectorAll("[data-tkind]").forEach((b) => b.addEventListener("click", () => ZL.open("templates", Object.assign({}, p, { kind: b.dataset.tkind }))));
      root.querySelector("#zl-tco").addEventListener("click", () => go("settings"));
      root.querySelector("#zl-tpdf").addEventListener("click", async (ev) => {
        ev.target.disabled = true;
        try { await ZL.voucherPdf(root.querySelector("#zl-tprev").innerHTML, `sample-${(p.kind || "PV").toLowerCase()}.pdf`); }
        catch (e) { ZL.toast(ZL.errorText(e), "bad"); } finally { ev.target.disabled = false; }
      });
      const latest = root.querySelector("#zl-tlatest");
      if (latest) latest.addEventListener("click", () => ZL.voucher(latest.dataset.id));
      const file = root.querySelector("#zl-logo");
      if (file) file.addEventListener("change", async () => {
        if (!file.files[0]) return;
        try { read(); d.logo = await readLogo(file.files[0]); ZL.open("templates", p); ZL.toast("Logo added — save the template to keep it."); }
        catch (e) { ZL.toast(ZL.errorText(e), "bad"); }
      });
      const rm = root.querySelector("#zl-logo-x");
      if (rm) rm.addEventListener("click", () => { read(); d.logo = null; ZL.open("templates", p); });
      const save = root.querySelector("#zl-tsave");
      if (save) save.addEventListener("click", async () => {
        read();
        save.disabled = true;
        try {
          await ZL.rpc("save_document_settings", { p_company: cid(), p_logo: d.logo || null, p_accent: d.accent, p_pv_title: d.pv_title,
            p_or_title: d.or_title, p_footer: d.footer || null, p_sign_labels: d.sign_labels, p_show_lines: d.show_lines });
          await ZL.docSettings(true);
          ZL.toast("Template saved. Every voucher and receipt now uses it.");
          ZL.open("templates", { kind: p.kind });
        } catch (e) { ZL.toast(ZL.errorText(e), "bad"); save.disabled = false; }
      });
    },
  });
})();
