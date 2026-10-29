/* ═══════════════════════════════════════════════════════════════════════════
 * Zycount live workspace — capture: receipts, bills and payment slips as
 * photos, scans and PDFs.
 *
 *   Inbox       snap or drop documents; each is read and waits to be recorded
 *   In forms    "Snap receipt" beside every receipt, payment, bill and
 *               expense form: the picture sits next to the form, what was
 *               read is filled in and highlighted, and everything stays
 *               editable by hand
 *   On entries  the files behind a document or journal, for anyone checking
 *
 * Files go to the private `attachments` bucket and the attachments register
 * (attachments migration). Reading is done by the scan-document function;
 * when it isn't switched on, a text PDF is still read on this device and a
 * photo is simply shown beside the form for keying in.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const ZL = window.ZL;
  const E = ZL.esc;
  const M = ZL.money;
  const cid = () => ZL.company.company_id;
  const bad = (msg) => new ZL.ZLError("VALIDATION", msg);
  const BUCKET = "attachments";
  const MAX = 10 * 1024 * 1024;
  const KINDS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
  const CAMERA = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/></svg>`;
  const CLIP = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 11-8.6 8.6a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7L10 17.3a1.7 1.7 0 0 1-2.3-2.3l8-8"/></svg>`;
  const PDF = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><text x="7" y="18" font-size="5.5" font-family="sans-serif" stroke="none" fill="currentColor">PDF</text></svg>`;

  const CSS = `
  .zl-evbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;margin:0 0 14px;border:1px dashed var(--line-2,var(--line));border-radius:10px;background:var(--sunk)}
  .zl-evbar .zl-btn{display:inline-flex;align-items:center;gap:6px}
  .zl-evbar small{flex:1 1 220px;color:var(--ink-3);font-size:12.5px;line-height:1.4}
  .zl-scrim .zl-modal.with-ev{width:min(1320px,100%)}
  .zl-modal.with-ev .zl-modal-body{display:grid;grid-template-columns:minmax(250px,32%) minmax(0,1fr);gap:18px;align-items:start}
  .zl-ev-main{min-width:0}
  .zl-ev-view{position:sticky;top:0;display:flex;flex-direction:column;gap:8px;min-width:0;max-height:calc(100vh - 180px)}
  .zl-ev-head{display:flex;align-items:center;gap:6px;font-size:13px}
  .zl-ev-head b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .zl-ev-frame{flex:1 1 auto;min-height:300px;border:1px solid var(--line);border-radius:10px;overflow:auto;background:var(--sunk);display:flex;align-items:flex-start;justify-content:center}
  .zl-ev-frame img{max-width:100%;display:block;cursor:zoom-in}
  .zl-ev-frame img.zoom{max-width:none;width:180%;cursor:zoom-out}
  .zl-ev-frame iframe{width:100%;height:100%;min-height:440px;border:0;background:#fff}
  .zl-ev-frame .zl-ev-ph{margin:auto;display:flex;flex-direction:column;align-items:center;gap:8px;color:var(--ink-3);padding:24px;text-align:center;font-size:13px}
  .zl-ev-status{font-size:12.5px;line-height:1.45;padding:8px 10px;border-radius:8px;background:var(--sunk);color:var(--ink-2)}
  .zl-ev-status.ok{background:var(--good-soft,var(--sunk));color:var(--good,var(--ink))}
  .zl-ev-status.warn{background:var(--warn-soft,var(--sunk));color:var(--ink)}
  .zl-ev-status.bad{background:var(--bad-soft,var(--sunk));color:var(--bad)}
  .zl-ev-status ul{margin:6px 0 0 16px;padding:0}
  .zl-ev-status .zl-spin{vertical-align:-2px;margin-right:6px}
  .zl-ev-notes:empty{display:none}
  .zl-ev-notes{font-size:12.5px;line-height:1.45;display:flex;flex-direction:column;gap:6px}
  .zl-ev-notes>div{padding:8px 10px;border:1px solid var(--line);border-radius:8px}
  .zl-ev-acts{display:flex;gap:6px;flex-wrap:wrap}
  .zl-filled{box-shadow:inset 0 0 0 1.5px var(--brand)!important;background-color:var(--brand-soft)!important}
  @media (max-width:860px){
    .zl-modal.with-ev .zl-modal-body{grid-template-columns:minmax(0,1fr)}
    .zl-ev-view{position:static;max-height:none}
    .zl-ev-frame{min-height:150px;max-height:38vh}
    .zl-ev-frame iframe{min-height:300px}
  }
  .zl-drop{border:2px dashed var(--line-2,var(--line));border-radius:14px;padding:26px 18px;text-align:center;background:var(--card);transition:border-color .15s,background .15s}
  .zl-drop.over{border-color:var(--brand);background:var(--brand-soft)}
  .zl-drop h3{margin:0 0 4px;font-size:16px}
  .zl-drop p{margin:0 auto 14px;max-width:560px;color:var(--ink-3);font-size:13.5px;line-height:1.5}
  .zl-drop .zl-actions{justify-content:center}
  .zl-drop .zl-btn{display:inline-flex;align-items:center;gap:6px}
  .zl-tabs{display:flex;gap:4px;margin:18px 0 10px;flex-wrap:wrap}
  .zl-tabs button{border:1px solid var(--line);background:var(--card);color:var(--ink-2);border-radius:999px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}
  .zl-tabs button[aria-pressed="true"]{background:var(--brand-soft);color:var(--brand);border-color:transparent;font-weight:600}
  .zl-inbox{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
  .zl-icard{display:grid;grid-template-columns:84px minmax(0,1fr);gap:12px;padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
  .zl-thumb{width:84px;height:106px;border-radius:8px;border:1px solid var(--line);background:var(--sunk) center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:var(--ink-3);cursor:pointer;padding:0}
  .zl-icard h4{margin:0 0 2px;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .zl-icard .meta{font-size:12.5px;color:var(--ink-3);line-height:1.45}
  .zl-icard .amt{font-size:15px;font-weight:650;font-variant-numeric:tabular-nums;margin:4px 0}
  .zl-icard .row{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;align-items:center}
  .zl-icard select{max-width:100%;flex:1 1 150px}
  .zl-work{display:flex;flex-direction:column;gap:6px;margin-top:12px}
  .zl-work div{font-size:13px;color:var(--ink-2);display:flex;gap:8px;align-items:center}
  .zl-attach{margin-top:16px}
  .zl-attach .list{display:flex;gap:10px;flex-wrap:wrap;padding:12px 16px 16px}
  .zl-attach .item{width:132px;font-size:12px;color:var(--ink-2)}
  .zl-attach .item .zl-thumb{width:132px;height:150px;margin-bottom:4px}
  .zl-attach .item span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .zl-viewer{max-height:72vh;overflow:auto;background:var(--sunk);border-radius:10px;display:flex;justify-content:center}
  .zl-viewer img{max-width:100%;display:block}
  .zl-viewer iframe{width:100%;height:70vh;border:0;background:#fff}
  @media (max-width:560px){.zl-inbox{grid-template-columns:minmax(0,1fr)}}`;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  // ── Files ────────────────────────────────────────────────────────────────
  async function sha256(blob) {
    const h = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const loadImage = (file) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image")); };
    img.src = url;
  });

  /** Photos come upright, at most 2000 px and as JPEG; PDFs go as they are. */
  async function prepare(file) {
    const name = String(file.name || "document").slice(0, 180);
    if (file.type === "application/pdf" || /\.pdf$/i.test(name)) {
      if (file.size > MAX) throw bad(`${name} is larger than 10 MB.`);
      return { blob: file, mime: "application/pdf", name };
    }
    if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(name)) {
      throw bad(`${name}: attach a photo (JPG, PNG, WebP, HEIC) or a PDF.`);
    }
    let pic = null;
    try { pic = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (_) {
      pic = await loadImage(file).catch(() => null);
    }
    if (!pic) throw bad(`${name} couldn't be opened here. On iPhone, set Camera › Formats to Most Compatible, or send it as a JPEG.`);
    const w0 = pic.width || pic.naturalWidth, h0 = pic.height || pic.naturalHeight;
    const k = Math.min(1, 2000 / Math.max(w0, h0));
    if (k === 1 && KINDS[file.type] && file.type !== "application/pdf" && file.size <= 1.5 * 1024 * 1024) {
      return { blob: file, mime: file.type, name };
    }
    const c = document.createElement("canvas");
    c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(pic, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.86));
    if (!blob) throw bad(`${name} couldn't be prepared.`);
    return { blob, mime: "image/jpeg", name: name.replace(/\.[a-z0-9]+$/i, "") + ".jpg" };
  }

  /** Uploads one file and puts it on the register. */
  async function upload(file) {
    if (!ZL.can("journal.create")) throw new ZL.ZLError("PERMISSION_DENIED", "Your role can't add files in these books.");
    const [hash, p] = await Promise.all([sha256(file), prepare(file)]);
    const d = new Date();
    const path = `${cid()}/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${KINDS[p.mime]}`;
    const { error } = await ZL.sb.storage.from(BUCKET).upload(path, p.blob, { contentType: p.mime, upsert: false, cacheControl: "3600" });
    if (error) throw new ZL.ZLError("NETWORK", `${p.name} didn't upload. Check your connection and try again.`);
    let r;
    try {
      r = await ZL.rpc("register_attachment", { p_company: cid(), p_path: path, p_file_name: p.name, p_mime: p.mime, p_size: p.blob.size, p_sha256: hash });
    } catch (e) {
      await ZL.sb.storage.from(BUCKET).remove([path]).catch(() => null);
      throw e;
    }
    return { id: r.id, company_id: cid(), path, file_name: p.name, mime: p.mime, size_bytes: p.blob.size, status: "NEW", scan: null,
      created_at: new Date().toISOString(), uploaded_by: ZL.user && ZL.user.id, duplicate: r.duplicate, blob: p.blob };
  }

  const urls = new Map();
  /** A short-lived link to view a stored file. */
  async function urlFor(att) {
    if (att.blob) { if (!att.local) att.local = URL.createObjectURL(att.blob); return att.local; }
    const hit = urls.get(att.path);
    if (hit && hit.until > Date.now()) return hit.url;
    const { data, error } = await ZL.sb.storage.from(BUCKET).createSignedUrl(att.path, 3600);
    if (error || !data) throw new ZL.ZLError("NOT_FOUND", "That file couldn't be opened.");
    urls.set(att.path, { url: data.signedUrl, until: Date.now() + 3300e3 });
    return data.signedUrl;
  }
  async function urlsFor(list) {
    const need = list.filter((a) => !a.blob && !(urls.get(a.path) && urls.get(a.path).until > Date.now()));
    if (need.length) {
      const { data } = await ZL.sb.storage.from(BUCKET).createSignedUrls(need.map((a) => a.path), 3600);
      (data || []).forEach((x) => { if (x.signedUrl) urls.set(x.path, { url: x.signedUrl, until: Date.now() + 3300e3 }); });
    }
    return new Map(list.map((a) => [a.id, a.blob ? (a.local || (a.local = URL.createObjectURL(a.blob))) : (urls.get(a.path) || {}).url]));
  }

  async function remove(att) {
    const r = await ZL.rpc("delete_attachment", { p_id: att.id });
    if (r && r.own) await ZL.sb.storage.from(BUCKET).remove([r.path]).catch(() => null);
  }

  // ── Reading ──────────────────────────────────────────────────────────────
  const AI_KEY = "zl.capture.ai";
  // "off" is remembered for 10 minutes, so switching the reader on is picked up without signing out.
  const ai = {
    get state() {
      try { const [v, t] = String(sessionStorage.getItem(AI_KEY) || "").split(":"); return v === "off" && Date.now() - Number(t) > 600e3 ? null : v || null; }
      catch (_) { return null; }
    },
    set state(v) { try { sessionStorage.setItem(AI_KEY, `${v}:${Date.now()}`); } catch (_) { /* ignore */ } },
  };

  /** Reads a stored file. Resolves with the reading, or throws with a code. */
  async function read(att) {
    let aiError = null;
    if (ai.state !== "off") {
      const { data, error } = await ZL.sb.functions.invoke("scan-document", { body: { attachment_id: att.id } });
      if (!error && data && data.scan) { ai.state = "on"; return data.scan; }
      let body = null;
      try { body = error && error.context && typeof error.context.json === "function" ? await error.context.json() : null; } catch (_) { /* not JSON */ }
      const x = (body && body.error) || (data && data.error) || {};
      aiError = new ZL.ZLError(x.code || "NETWORK", x.message || "The reader didn't answer. Try again, or key it in by hand.");
      if (aiError.code === "AI_NOT_CONFIGURED") ai.state = "off";
      else if (att.mime !== "application/pdf" || ["LIMIT", "PERMISSION_DENIED"].includes(aiError.code)) throw aiError;
    }
    if (att.mime === "application/pdf") {
      const s = await readPdfText(att).catch(() => null);
      if (s) return s;
    }
    throw aiError || new ZL.ZLError("AI_NOT_CONFIGURED", "Automatic reading isn't switched on yet. Key the details in by hand.");
  }

  // A text PDF (e-Invoice, emailed bill) read on this device, field by field.
  const DATE_RX = /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b|\b(\d{4})-(\d{2})-(\d{2})\b|\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/;
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, mei: 5, jun: 6, jul: 7, aug: 8, ogo: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, dis: 12 };
  function dateOf(s) {
    const m = DATE_RX.exec(s);
    if (!m) return null;
    let y, mo, d;
    if (m[1]) { d = +m[1]; mo = +m[2]; y = +m[3]; } else if (m[4]) { y = +m[4]; mo = +m[5]; d = +m[6]; } else { d = +m[7]; mo = MON[m[8].slice(0, 3).toLowerCase()]; y = +m[9]; }
    if (y < 100) y += 2000;
    if (!mo || mo > 12 || d > 31) return null;
    const t = new Date(Date.UTC(y, mo - 1, d));
    return t.getUTCMonth() === mo - 1 ? t.toISOString().slice(0, 10) : null;
  }
  const lastAmount = (s) => {
    const all = String(s).match(/-?\(?(?:RM\s?)?\d{1,3}(?:,\d{3})*\.\d{2}\)?/gi);
    if (!all) return null;
    const t = all[all.length - 1];
    const v = Number(t.replace(/[^0-9.]/g, ""));
    return /^-|\(/.test(t) ? -v : v;
  };
  function parseText(lines, co) {
    const text = lines.join("\n");
    const own = String((co && co.name) || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
    const isOwn = (l) => own.length >= 4 && l.toUpperCase().replace(/[^A-Z0-9]+/g, " ").includes(own);
    const find = (rx, lookAhead = 1) => {
      for (let i = 0; i < lines.length; i++) {
        if (!rx.test(lines[i])) continue;
        for (let j = i; j <= Math.min(lines.length - 1, i + lookAhead); j++) { const v = lastAmount(lines[j]); if (v != null) return v; }
      }
      return null;
    };
    const findLast = (rx) => { let v = null; lines.forEach((l) => { if (rx.test(l)) { const a = lastAmount(l); if (a != null) v = a; } }); return v; };
    const total = find(/grand\s*total|jumlah\s*(besar|keseluruhan)|total\s*(amount\s*)?(payable|due)|amount\s*(due|payable)|net\s*total/i)
      ?? findLast(/\btotal\b|\bjumlah\b/i);
    const subtotal = find(/sub\s*-?\s*total|jumlah\s*kecil|total\s*excl/i, 0);
    const taxLine = lines.find((l) => /\b(sst|service\s*tax|sales\s*tax|cukai\s*(perkhidmatan|jualan)|gst)\b/i.test(l) && lastAmount(l) != null);
    const tax_total = taxLine ? lastAmount(taxLine) : null;
    const rateM = taxLine && /(\d{1,2}(?:\.\d+)?)\s*%/.exec(taxLine);
    const dateLine = lines.find((l) => /\b(date|tarikh)\b/i.test(l) && DATE_RX.test(l)) || lines.find((l) => DATE_RX.test(l));
    const dueLine = lines.find((l) => /\b(due|tarikh\s*akhir|payment\s*due)\b/i.test(l) && DATE_RX.test(l));
    const noM = /\b(?:invoice|invois|receipt|resit|bill|document|doc|tax\s*invoice)\s*(?:no|number|num|#)\.?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/.]{2,30})/i.exec(text);
    const tinM = /\b(?:TIN|No\.?\s*Cukai|Tax\s*ID(?:entification)?(?:\s*No)?)\s*[:.]?\s*((?:IG|C|D|E|F|J|PT|TA|TC|TN|TR|TP|LE)\d{8,12})\b/i.exec(text)
      || /\b((?:IG|C)\d{10,11})\b/.exec(text);
    const sstM = /\b([A-Z]\d{2}-\d{4}-\d{8})\b/.exec(text);
    const regM = /\b((?:19|20)\d{10}|\d{5,7}-[A-Z])\b/.exec(text);
    const uuidM = /\bUUID\s*[:.]?\s*([A-Z0-9]{20,40})\b/i.exec(text);
    const head = lines.slice(0, 12).filter((l) => /[A-Za-z]{3}/.test(l) && !isOwn(l) && !/invoice|invois|receipt|resit|tax|page|date|tarikh|bill\s*to/i.test(l));
    const name = (head.find((l) => /\b(sdn\.?\s*bhd|berhad|plt|enterprise|trading|services|resources|holdings)\b/i.test(l)) || head[0] || "").slice(0, 120);
    // We issued it only when our name heads the page, not when it's the "Bill to" party.
    const TO = /\b(bill(ed)?\s*to|sold\s*to|ship\s*to|deliver\s*to|customer|kepada|attn|to\s*:)/i;
    const ownAt = lines.findIndex(isOwn);
    const ownIsIssuer = ownAt >= 0 && ownAt < 4 && !TO.test(lines[ownAt]) && !TO.test(lines[ownAt - 1] || "");
    const fx = /\b(USD|SGD|EUR|GBP|CNY|THB|IDR)\b/.exec(text);
    const out = {
      v: 1, engine: "pdf-text", document_type: /credit\s*note|nota\s*kredit/i.test(text) ? "CREDIT_NOTE" : /receipt|resit/i.test(text) ? "RECEIPT" : /invoice|invois/i.test(text) ? (uuidM ? "EINVOICE" : "TAX_INVOICE") : "OTHER",
      direction: ownIsIssuer ? "MONEY_IN" : "MONEY_OUT",
      counterparty: { name, reg_no: regM ? regM[1] : "", tin: tinM ? tinM[1].toUpperCase() : "", sst_no: sstM ? sstM[1] : "", address: "", phone: "", email: (/[\w.+-]+@[\w-]+\.[\w.]+/.exec(text) || [""])[0] },
      doc_no: noM ? noM[1] : "", date: dateLine ? dateOf(dateLine) : null, due_date: dueLine ? dateOf(dueLine) : null, currency: fx && !/\bRM\b|MYR/.test(text) ? fx[1] : "MYR",
      payment_method: "UNKNOWN", payment_reference: "", bank_name: "",
      subtotal, discount: null, tax_total, rounding: findLast(/rounding|pelarasan/i), total,
      tax_type: taxLine ? (/sales/i.test(taxLine) ? "SALES_TAX" : "SERVICE_TAX") : "NONE", tax_rate: rateM ? Number(rateM[1]) : null,
      einvoice_uuid: uuidM ? uuidM[1] : "", lines: [], references_paid: [], suggested_account_code: "",
      summary: name ? `${/receipt|resit/i.test(text) ? "Receipt" : "Bill"} — ${name}`.slice(0, 80) : "",
      confidence: total != null && name ? "MEDIUM" : "LOW",
      warnings: ["Read from the PDF's text on this device, without the automatic reader. Check every field."],
      read_at: new Date().toISOString(),
    };
    if (total == null) out.warnings.push("No total was found.");
    return total == null && !name ? null : out;
  }
  async function readPdfText(att) {
    if (!ZL.pdfText) return null;
    let blob = att.blob;
    if (!blob) {
      const { data, error } = await ZL.sb.storage.from(BUCKET).download(att.path);
      if (error || !data) return null;
      blob = data;
    }
    const lines = await ZL.pdfText(blob);
    if (lines.join("").replace(/\s/g, "").length < 40) return null; // a scanned image in a PDF
    const s = parseText(lines, await ZL.companyInfo().catch(() => ZL.company));
    if (s) await ZL.rpc("save_attachment_scan", { p_id: att.id, p_scan: s, p_engine: "pdf-text" });
    return s;
  }

  // ── Turning a reading into form values ───────────────────────────────────
  const idn = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const nameKey = (s) => ` ${String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ")} `
    .replace(/ (SDN|BHD|BERHAD|PLT|ENTERPRISE|ENT|TRADING|CO|COMPANY|LTD|LIMITED|M|MSIA|MALAYSIA|THE|AND) /g, " ")
    .replace(/ (SDN|BHD|BERHAD|PLT|ENTERPRISE|ENT|TRADING|CO|COMPANY|LTD|LIMITED|M|MSIA|MALAYSIA|THE|AND) /g, " ").replace(/\s+/g, " ").trim();
  /** The customer or supplier on the document, if they're already in the books. */
  function matchContact(cp, list) {
    if (!cp) return null;
    const live = list.filter((c) => c.is_active !== false);
    const by = (f, min) => { const v = idn(cp[f]); return v.length >= min ? live.find((c) => idn(c[f]) === v) : null; };
    const hit = by("tin", 8) || by("reg_no", 5) || by("sst_no", 8);
    if (hit) return hit;
    const k = nameKey(cp.name);
    if (k.length < 3) return null;
    return live.find((c) => nameKey(c.name) === k)
      || (k.length >= 6 ? live.find((c) => { const n = nameKey(c.name); return n.length >= 6 && (n.includes(k) || k.includes(n)); }) : null) || null;
  }
  const rulesCache = new Map();
  async function rules() {
    if (!rulesCache.has(cid())) rulesCache.set(cid(), await ZL.select("category_rules", "pattern,direction,account_id", (q) => q.eq("company_id", cid())).catch(() => []));
    return rulesCache.get(cid());
  }
  /** The account to book it to: the contact's usual one, what the reader suggested, or what was learnt before. */
  async function accountFor(s, accounts, { contact, direction = "OUT", usable = () => true } = {}) {
    const ok = (id) => id && accounts.some((a) => a.id === id && usable(a));
    if (contact && ok(contact.default_account_id)) return contact.default_account_id;
    const byCode = s.suggested_account_code && accounts.find((a) => a.code === s.suggested_account_code && usable(a));
    if (byCode) return byCode.id;
    const key = ZL.categoryKey ? ZL.categoryKey(s.counterparty && s.counterparty.name) : "";
    if (key) {
      const r = (await rules()).find((x) => x.direction === direction && x.pattern === key && ok(x.account_id));
      if (r) return r.account_id;
    }
    return "";
  }
  /** The SST code whose rate matches the document. */
  function taxFor(s, taxes) {
    if (!(s && s.tax_total > 0)) return "";
    let rate = s.tax_rate;
    if (!rate && s.subtotal) rate = Math.round((s.tax_total / s.subtotal) * 100);
    const live = taxes.filter((x) => x.is_active !== false && Math.abs(Number(x.rate) - Number(rate)) < 0.01);
    const pref = s.tax_type === "SALES_TAX" ? /^ST/i : /^SV/i;
    return ((live.find((x) => pref.test(x.code)) || live[0]) || {}).id || "";
  }
  const METHOD = { CASH: "Cash", CARD: "Card", BANK_TRANSFER: "Bank transfer", DUITNOW: "DuitNow / FPX", FPX: "DuitNow / FPX", CHEQUE: "Cheque", EWALLET: "Other" };
  const methodFor = (s) => METHOD[s && s.payment_method] || "";
  /** Cash paid comes out of cash in hand; everything else out of the bank account used last. */
  function moneyFor(s, money) {
    const cashLike = (a) => /cash|tunai|petty/i.test(a.name);
    if (s && s.payment_method === "CASH") return ((money.find(cashLike)) || {}).id || "";
    if (s && s.payment_method === "CARD") {
      const card = money.find((a) => a.type === "LIABILITY" && /card|kad/i.test(a.name));
      if (card) return card.id;
    }
    if (!s || s.payment_method === "UNKNOWN" || s.payment_method === "CREDIT") return "";
    let last = null;
    try { last = localStorage.getItem(`zl.money.${cid()}`); } catch (_) { /* ignore */ }
    return ((money.find((a) => a.id === last && !cashLike(a))) || money.find((a) => a.code === "1131") || money.find((a) => !cashLike(a)) || {}).id || "";
  }

  /** Puts a value into a form field and marks it as read from the document. */
  function put(root, name, value, { silent = false } = {}) {
    const el = typeof name === "string" ? root.querySelector(`[name="${name}"]`) : name;
    if (!el || value == null || value === "") return false;
    if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === String(value))) return false;
    el.value = value;
    el.classList.add("zl-filled");
    if (!silent) { el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }
    return true;
  }
  const r2 = (n) => Math.round(Number(n) * 100) / 100;
  /**
   * Lines for a document: as printed when they add up, otherwise one line for
   * the whole amount. taxCode: whether an SST code matches the document's rate
   * (without one, the tax stays inside the amounts).
   */
  function linesOf(s, { taxCode = true } = {}) {
    const tax = s.tax_total || 0;
    const one = (amount) => [{ description: s.summary || (s.counterparty && s.counterparty.name) || "As per document", quantity: 1, amount }];
    const printed = (s.lines || []).filter((l) => l.amount != null && l.amount !== 0);
    const sum = r2(printed.reduce((a, l) => a + l.amount, 0));
    if (tax > 0 && !taxCode) {
      if (s.total == null) return { lines: printed, inclusive: true, noTax: true };
      return { lines: printed.length && Math.abs(sum - s.total) <= 0.05 ? printed : one(s.total), inclusive: true, noTax: true };
    }
    if (printed.length && s.total != null) {
      const net = s.subtotal != null ? s.subtotal : r2(s.total - tax - (s.rounding || 0) + (s.discount || 0));
      if (Math.abs(sum - net) <= 0.05) return { lines: printed, inclusive: false, discountOnLast: true };
      if (Math.abs(sum - s.total) <= 0.05) return { lines: printed, inclusive: true };
    } else if (printed.length) return { lines: printed, inclusive: false, discountOnLast: true };
    if (s.total == null) return { lines: [], inclusive: false };
    const net = s.subtotal != null ? r2(s.subtotal - (s.discount || 0)) : r2(s.total - tax - (s.rounding || 0));
    return { lines: one(tax > 0 ? net : s.total), inclusive: false };
  }
  /** A new customer or supplier, filled in from the document. */
  const contactFrom = (s) => {
    const cp = (s && s.counterparty) || {};
    return { name: cp.name || "", reg_no: cp.reg_no || "", tin: cp.tin || "", sst_no: cp.sst_no || "", address: cp.address || "",
      phone: cp.phone || "", email: cp.email || "", id_type: cp.reg_no ? "BRN" : "" };
  };

  // ── Evidence beside a form ───────────────────────────────────────────────
  /**
   * Adds "Snap receipt" to an open form dialog (m = { root }). opts:
   *   fill(scan, att, ev)  puts what was read into the form
   *   preset               an attachment picked in the Inbox
   * Returns { link(entityType, entityId), note(html, tone), files }.
   */
  function evidence(m, opts = {}) {
    const wrap = m.root, modal = wrap.querySelector(".zl-modal"), body = modal.querySelector(".zl-modal-body");
    const files = [];
    let cur = 0, aside = null, notes = [];
    const canAdd = ZL.can("journal.create");
    const pickers = `<input type="file" accept="image/*" capture="environment" hidden data-ev-cam>
      <input type="file" accept="image/*,application/pdf" multiple hidden data-ev-files>`;
    if (canAdd) {
      const bar = document.createElement("div");
      bar.className = "zl-evbar";
      bar.innerHTML = `<button type="button" class="zl-btn sm" data-ev-snap>${CAMERA}Snap receipt</button>
        <button type="button" class="zl-btn sm ghost" data-ev-up>${CLIP}Photo or PDF</button>
        <small>Zycount reads the document and fills in this form. Everything stays editable, and the file is kept with the entry.</small>${pickers}`;
      body.insertBefore(bar, body.firstChild);
      bar.querySelector("[data-ev-snap]").addEventListener("click", () => bar.querySelector("[data-ev-cam]").click());
      bar.querySelector("[data-ev-up]").addEventListener("click", () => bar.querySelector("[data-ev-files]").click());
      bar.querySelectorAll("input[type=file]").forEach((inp) => inp.addEventListener("change", () => {
        const list = [...inp.files];
        inp.value = "";
        list.forEach((f) => add(f));
      }));
    }
    // What the person types over is theirs: drop the "read from the document" mark.
    wrap.addEventListener("input", (ev) => { if (ev.isTrusted && ev.target.classList) ev.target.classList.remove("zl-filled"); }, true);

    function split() {
      if (aside) return;
      modal.classList.add("with-ev");
      const main = document.createElement("div");
      main.className = "zl-ev-main";
      while (body.firstChild) main.appendChild(body.firstChild);
      aside = document.createElement("aside");
      aside.className = "zl-ev-view";
      aside.setAttribute("aria-label", "Attached document");
      body.appendChild(aside);
      body.appendChild(main);
    }
    /** A message beside the picture. on: { selector: handler } for buttons in it. */
    const note = (html, tone = "", on = null) => { notes.push({ html, tone, on }); draw(); };
    async function draw() {
      if (!aside) return;
      const f = files[cur];
      if (!f) { aside.innerHTML = `<div class="zl-ev-status">No document attached.</div>`; return; }
      const s = f.scan;
      const status = f.state === "up" ? `<span class="zl-spin"></span>Uploading…`
        : f.state === "read" ? `<span class="zl-spin"></span>Reading the document…`
        : f.state === "done" ? `Filled in from the document${s && s.engine === "pdf-text" ? " (PDF text)" : ""} — check the highlighted fields before you post.${s && s.warnings && s.warnings.length ? `<ul>${s.warnings.map((w) => `<li>${E(w)}</li>`).join("")}</ul>` : ""}`
        : f.state === "manual" ? E(f.msg || "Not read automatically. Key the details in from the picture.")
        : E(f.msg || "Couldn't read it. Key the details in from the picture.");
      const tone = f.state === "done" ? (s && (s.confidence === "LOW" || (s.warnings || []).length) ? "warn" : "ok") : f.state === "err" ? "bad" : "";
      aside.innerHTML = `<div class="zl-ev-head"><b title="${E(f.att.file_name)}">${E(f.att.file_name)}</b>
          ${files.length > 1 ? `<button type="button" class="zl-btn sm ghost" data-ev-prev aria-label="Previous file">‹</button><span class="hint">${cur + 1}/${files.length}</span><button type="button" class="zl-btn sm ghost" data-ev-next aria-label="Next file">›</button>` : ""}</div>
        <div class="zl-ev-frame" data-ev-frame><div class="zl-ev-ph"><span class="zl-spin"></span></div></div>
        <div class="zl-ev-status ${tone}" role="status">${status}</div>
        <div class="zl-ev-notes">${notes.map((n, i) => `<div class="${n.tone}" data-note="${i}">${n.html}</div>`).join("")}</div>
        <div class="zl-ev-acts">
          ${f.att.id && f.state !== "up" && f.state !== "read" ? `<button type="button" class="zl-btn sm ghost" data-ev-read>${f.scan ? "Read again" : "Read it"}</button>` : ""}
          ${f.att.id ? `<button type="button" class="zl-btn sm ghost" data-ev-open>Open</button>` : ""}
          <button type="button" class="zl-btn sm ghost" data-ev-rm>Remove</button></div>`;
      const on = (sel, fn) => { const el = aside.querySelector(sel); if (el) el.addEventListener("click", fn); };
      // A handler that resolves true has dealt with its note, which then goes away.
      notes.forEach((n, i) => Object.entries(n.on || {}).forEach(([sel, fn]) => aside.querySelectorAll(`[data-note="${i}"] ${sel}`)
        .forEach((b) => b.addEventListener("click", async () => {
          b.disabled = true;
          let done = false;
          try { done = await fn(); } catch (e) { ZL.toast(ZL.errorText(e), "bad"); } finally { b.disabled = false; }
          if (done) { notes.splice(notes.indexOf(n), 1); draw(); }
        }))));
      on("[data-ev-prev]", () => { cur = (cur - 1 + files.length) % files.length; draw(); });
      on("[data-ev-next]", () => { cur = (cur + 1) % files.length; draw(); });
      on("[data-ev-read]", () => scanOne(f, true));
      on("[data-ev-open]", () => view(f.att));
      on("[data-ev-rm]", async () => {
        files.splice(files.indexOf(f), 1);
        cur = 0;
        if (f.own && f.att.id) remove(f.att).catch(() => null);
        if (!files.length) { notes = []; }
        draw();
      });
      const frame = aside.querySelector("[data-ev-frame]");
      if (!f.att.id && !f.att.blob) return;
      try {
        const url = await urlFor(f.att);
        if (files[cur] !== f || !frame.isConnected) return;
        if (f.att.mime === "application/pdf") {
          frame.innerHTML = window.matchMedia("(max-width:860px)").matches
            ? `<div class="zl-ev-ph">${PDF}<a class="zl-btn sm" href="${E(url)}" target="_blank" rel="noopener">Open the PDF</a></div>`
            : `<iframe src="${E(url)}" title="${E(f.att.file_name)}"></iframe>`;
        } else {
          frame.innerHTML = `<img src="${E(url)}" alt="${E(f.att.file_name)}">`;
          const img = frame.querySelector("img");
          img.addEventListener("click", () => img.classList.toggle("zoom"));
        }
      } catch (e) {
        frame.innerHTML = `<div class="zl-ev-ph">${E(ZL.errorText(e))}</div>`;
      }
    }

    async function scanOne(f, again = false) {
      if (!again && f.scan && (f.scan.total != null || f.scan.date)) { f.state = "done"; draw(); return apply(f); }
      f.state = "read"; draw();
      try {
        f.scan = await read(f.att);
        const s = f.scan;
        if (s.total == null && !s.date && !(s.counterparty && s.counterparty.name)) {
          f.state = "manual";
          f.msg = "Nothing readable was found on this file — key the details in from the picture.";
        } else {
          f.state = "done";
          await apply(f);
        }
      } catch (e) {
        f.state = e.code === "AI_NOT_CONFIGURED" ? "manual" : "err";
        f.msg = e.code === "AI_NOT_CONFIGURED" ? "Automatic reading isn't switched on yet — key the details in from the picture." : ZL.errorText(e);
      }
      draw();
    }
    async function apply(f) {
      if (!opts.fill || !f.scan || !document.body.contains(wrap)) return;
      notes = [];
      try { await opts.fill(f.scan, f.att, ctl); } catch (e) { note(E(ZL.errorText(e)), "bad"); }
      draw();
    }
    async function add(file) {
      split();
      const f = { att: { file_name: file.name || "document", mime: file.type }, own: true, state: "up" };
      files.push(f);
      cur = files.length - 1;
      draw();
      try {
        f.att = await upload(file);
      } catch (e) {
        files.splice(files.indexOf(f), 1);
        cur = Math.max(0, files.length - 1);
        draw();
        ZL.toast(ZL.errorText(e), "bad");
        return;
      }
      if (f.att.duplicate) {
        const d = f.att.duplicate;
        note(`<b>Uploaded before.</b> The same file was added ${E(ZL.date(String(d.created_at).slice(0, 10)))}${d.label ? ` and is attached to <b>${E(d.label)}</b>` : ""}. Make sure you aren't recording it twice.`, "warn");
      }
      // Only the first document fills the form; later ones are extra evidence.
      if (files.indexOf(f) === 0 || !files.some((x) => x.scan)) await scanOne(f);
      else { f.state = "manual"; f.msg = "Kept as extra evidence."; draw(); }
    }

    const ctl = {
      files,
      note,
      /** Attaches every file here to the saved entry. */
      async link(type, id) {
        const failed = [];
        for (const f of files) {
          if (!f.att.id) continue;
          try { await ZL.rpc("link_attachment", { p_id: f.att.id, p_entity_type: type, p_entity_id: id }); } catch (e) { failed.push(ZL.errorText(e)); }
        }
        if (failed.length) ZL.toast(`Saved, but a file couldn't be attached: ${failed[0]} It's still in the Inbox.`, "warn");
      },
    };
    if (opts.preset && opts.preset.id) {
      split();
      files.push({ att: opts.preset, own: false, scan: opts.preset.scan || null, state: "manual" });
      if (opts.preset.scan) scanOne(files[0]);
      else if (ai.state !== "off" || opts.preset.mime === "application/pdf") scanOne(files[0]);
      else draw();
    }
    return ctl;
  }

  // ── Viewer ───────────────────────────────────────────────────────────────
  async function view(att) {
    let url;
    try { url = await urlFor(att); } catch (e) { ZL.toast(ZL.errorText(e), "bad"); return; }
    ZL.modal({
      title: att.file_name, wide: true,
      body: `<div class="zl-viewer">${att.mime === "application/pdf" ? `<iframe src="${E(url)}" title="${E(att.file_name)}"></iframe>` : `<img src="${E(url)}" alt="${E(att.file_name)}">`}</div>
        <p class="hint" style="margin-top:8px">${E(att.file_name)} · ${Math.max(1, Math.round((att.size_bytes || 0) / 1024))} KB${att.created_at ? ` · added ${E(ZL.dateTime(att.created_at))}` : ""}</p>`,
      actions: [{ label: "Close" }, { label: "Open in new tab", primary: true, onClick: ({ close }) => { window.open(url, "_blank", "noopener"); close(); } }],
    });
  }

  // ── Files on a document or journal ───────────────────────────────────────
  /** Lists (and lets you add) the files behind an entry. extra: more [type, id] pairs to show. */
  async function panel(el, type, id, { extra = [], posted = false } = {}) {
    if (!el) return;
    const ids = [id, ...extra.map((x) => x[1])];
    const load = () => ZL.select("attachments", "*", (q) => q.in("entity_id", ids).order("linked_at"));
    const render = async () => {
      const list = await load().catch(() => []);
      const canAdd = ZL.can("journal.create");
      if (!list.length && !canAdd) { el.innerHTML = ""; return; }
      const u = await urlsFor(list.filter((a) => a.mime !== "application/pdf")).catch(() => new Map());
      el.innerHTML = `<section class="card zl-attach"><div class="zl-sec-h"><h3>Supporting documents${list.length ? ` (${list.length})` : ""}</h3>
          ${canAdd ? `<div class="zl-actions"><button type="button" class="zl-btn sm" data-at-add>${CLIP}Attach file</button>
            <input type="file" accept="image/*,application/pdf" multiple hidden data-at-in></div>` : ""}</div>
        ${list.length ? `<div class="list">${list.map((a) => `<div class="item">
            <button type="button" class="zl-thumb" data-at-view="${a.id}" style="${u.get(a.id) ? `background-image:url('${E(u.get(a.id))}')` : ""}" aria-label="View ${E(a.file_name)}">${a.mime === "application/pdf" ? PDF : ""}</button>
            <span title="${E(a.file_name)}">${E(a.file_name)}</span>
            ${a.entity_id !== id ? `<span class="hint">From the ${a.entity_type === "TRADE_DOC" ? "document" : "journal"}</span>` : ""}
            ${a.entity_id === id && (posted ? ZL.can("journal.reverse") : canAdd) ? `<button type="button" class="zl-ref" data-at-off="${a.id}">Detach</button>` : ""}</div>`).join("")}</div>`
          : `<p class="nil" style="padding:0 16px 16px">No receipt or bill attached yet. Attach the photo or PDF so anyone checking can see it.</p>`}</section>`;
      const byId = new Map(list.map((a) => [a.id, a]));
      el.querySelectorAll("[data-at-view]").forEach((b) => b.addEventListener("click", () => view(byId.get(b.dataset.atView))));
      const inp = el.querySelector("[data-at-in]");
      if (inp) {
        el.querySelector("[data-at-add]").addEventListener("click", () => inp.click());
        inp.addEventListener("change", async () => {
          const picked = [...inp.files];
          inp.value = "";
          for (const f of picked) {
            try {
              const a = await upload(f);
              await ZL.rpc("link_attachment", { p_id: a.id, p_entity_type: type, p_entity_id: id });
              if (a.duplicate) ZL.toast(`${a.file_name} was uploaded before${a.duplicate.label ? ` (on ${a.duplicate.label})` : ""}. Attached anyway.`, "warn");
            } catch (e) { ZL.toast(ZL.errorText(e), "bad"); }
          }
          ZL.toast("Attached.");
          render();
        });
      }
      el.querySelectorAll("[data-at-off]").forEach((b) => b.addEventListener("click", async () => {
        const a = byId.get(b.dataset.atOff);
        const r = await ZL.form({
          title: `Detach ${a.file_name}?`, confirmLabel: "Detach", danger: true,
          intro: posted ? "This entry is posted, so its evidence is part of the audit trail. The file goes back to the Inbox and the reason is recorded." : "The file goes back to the Inbox.",
          fields: posted ? [{ name: "reason", label: "Reason", required: true, placeholder: "e.g. Wrong receipt attached" }] : [],
          submit: (v) => ZL.rpc("unlink_attachment", { p_id: a.id, p_reason: v.reason || null }),
        });
        if (r) { ZL.toast("Detached — it's back in the Inbox."); render(); }
      }));
    };
    el.innerHTML = "";
    await render();
  }

  // ── What to record a document as ─────────────────────────────────────────
  const ACTIONS = {
    BILL: { label: "Purchase invoice — owe the supplier", run: (a) => ZL.tradeEdit("BILL", null, { attachment: a }) },
    CASH_PURCHASE: { label: "Cash purchase — paid on the spot", run: (a) => ZL.tradeEdit("CASH_PURCHASE", null, { attachment: a }) },
    EXPENSE: { label: "Expense — payment voucher (PV)", run: (a) => ZL.cashEntry("OUT", { attachment: a }) },
    PAYMENT: { label: "Payment to a supplier", run: (a) => ZL.tradePay("PAYMENT", { attachment: a }) },
    SUPPLIER_CN: { label: "Supplier credit note", run: (a) => ZL.tradeEdit("SUPPLIER_CN", null, { attachment: a }) },
    RECEIPT: { label: "Receipt from a customer (OR)", run: (a) => ZL.tradePay("RECEIPT", { attachment: a }) },
    INCOME: { label: "Other money in (OR)", run: (a) => ZL.cashEntry("IN", { attachment: a }) },
    INVOICE: { label: "Sales invoice", run: (a) => ZL.tradeEdit("INVOICE", null, { attachment: a }) },
    P_OUT: { label: "Money out", run: (a) => ZL.quick("OUT", { attachment: a }) },
    P_IN: { label: "Money in", run: (a) => ZL.quick("IN", { attachment: a }) },
  };
  const PAYSLIP = ["PAYMENT_SLIP", "BANK_TRANSFER", "CHEQUE"];
  const INVOICES = ["INVOICE", "TAX_INVOICE", "EINVOICE"];
  function suggestAction(s) {
    if (ZL.isPersonal()) return s && s.direction === "MONEY_IN" ? "P_IN" : "P_OUT";
    if (!s) return "EXPENSE";
    if (s.direction === "MONEY_IN") return INVOICES.includes(s.document_type) ? "INVOICE" : PAYSLIP.includes(s.document_type) ? "RECEIPT" : "INCOME";
    if (s.document_type === "CREDIT_NOTE") return "SUPPLIER_CN";
    if (PAYSLIP.includes(s.document_type)) return "PAYMENT";
    if (INVOICES.includes(s.document_type) && (s.due_date || s.payment_method === "CREDIT" || s.payment_method === "UNKNOWN")) return "BILL";
    return "EXPENSE";
  }
  const actionKeys = () => (ZL.isPersonal() ? ["P_OUT", "P_IN"] : ["EXPENSE", "BILL", "CASH_PURCHASE", "PAYMENT", "SUPPLIER_CN", "RECEIPT", "INCOME", "INVOICE"]);
  const TYPE_WORD = { RECEIPT: "Receipt", TAX_INVOICE: "Tax invoice", INVOICE: "Invoice", CASH_BILL: "Cash bill", EINVOICE: "e-Invoice", PAYMENT_SLIP: "Payment slip",
    BANK_TRANSFER: "Transfer", CHEQUE: "Cheque", CREDIT_NOTE: "Credit note", DEBIT_NOTE: "Debit note", QUOTATION: "Quotation", PURCHASE_ORDER: "Purchase order",
    DELIVERY_ORDER: "Delivery order", STATEMENT: "Statement", OTHER: "Document" };

  // ── Inbox ────────────────────────────────────────────────────────────────
  ZL.register("capture", {
    title: "Inbox",
    perm: "journal.view",
    async render(ctx) {
      const P = ZL.isPersonal();
      const tab = ctx.params.tab || "todo";
      ctx.tab = tab;
      const all = await ZL.select("attachments", "*", (q) => q.eq("company_id", cid()).order("created_at", { ascending: false }).limit(300));
      const list = all.filter((a) => (tab === "todo" ? a.status !== "RECORDED" : tab === "done" ? a.status === "RECORDED" : true));
      ctx.list = list;
      const canAdd = ZL.can("journal.create");
      const [docs, jes, people] = await Promise.all([
        list.some((a) => a.entity_type === "TRADE_DOC") ? ZL.select("trade_docs", "id,doc_no,doc_type,status", (q) => q.in("id", list.filter((a) => a.entity_type === "TRADE_DOC").map((a) => a.entity_id))) : [],
        list.some((a) => a.entity_type === "JOURNAL") ? ZL.select("journal_entries", "id,doc_no,reference", (q) => q.in("id", list.filter((a) => a.entity_type === "JOURNAL").map((a) => a.entity_id))) : [],
        ZL.people(list.map((a) => a.uploaded_by)).catch(() => ({})),
      ]);
      const label = new Map([...docs.map((d) => [d.id, d.doc_no || "Draft"]), ...jes.map((j) => [j.id, j.doc_no || j.reference])]);
      const who = (id) => (people && people[id]) || "";
      const counts = { todo: all.filter((a) => a.status !== "RECORDED").length, done: all.filter((a) => a.status === "RECORDED").length, all: all.length };
      const card = (a) => {
        const s = a.scan;
        const sug = suggestAction(s);
        const cp = s && s.counterparty && s.counterparty.name;
        return `<article class="zl-icard" data-att="${a.id}">
          <button type="button" class="zl-thumb" data-view aria-label="View ${E(a.file_name)}">${a.mime === "application/pdf" ? PDF : ""}</button>
          <div style="min-width:0">
            <h4 title="${E(cp || a.file_name)}">${E(cp || a.file_name)}</h4>
            <div class="meta">${s ? `${E(TYPE_WORD[s.document_type] || "Document")}${s.doc_no ? ` ${E(s.doc_no)}` : ""}${s.date ? ` · ${ZL.date(s.date)}` : ""}` : E(a.file_name)}</div>
            ${s && s.total != null ? `<div class="amt">${s.currency && s.currency !== "MYR" ? E(s.currency) : "RM"} ${M(s.total)}${s.tax_total ? ` <span class="hint" style="font-weight:400">incl. SST ${M(s.tax_total)}</span>` : ""}</div>` : ""}
            <div class="meta">${a.status === "RECORDED" ? `<span class="chip ok">Recorded</span> <button type="button" class="zl-ref" data-go="${a.entity_type}:${a.entity_id}">${E(label.get(a.entity_id) || "Open")}</button>`
              : s ? `<span class="chip${(s.warnings || []).length || s.confidence === "LOW" ? " warn" : ""}">${(s.warnings || []).length ? `${s.warnings.length} to check` : "Read"}</span>`
              : `<span class="chip">Not read yet</span>`} · ${E(ZL.date(String(a.created_at).slice(0, 10)))}${who(a.uploaded_by) ? ` · ${E(who(a.uploaded_by))}` : ""}</div>
            ${a.status !== "RECORDED" && canAdd && ZL.can("journal.post") ? `<div class="row">
              <select class="zl-input" data-as aria-label="Record as">${actionKeys().map((k) => `<option value="${k}"${k === sug ? " selected" : ""}>${E(ACTIONS[k].label)}</option>`).join("")}</select>
              <button type="button" class="zl-btn sm primary" data-rec>Record</button></div>
              <div class="row">${!s ? `<button type="button" class="zl-btn sm ghost" data-read>Read it</button>` : ""}<button type="button" class="zl-btn sm ghost" data-del>Delete</button></div>` : ""}
          </div></article>`;
      };
      return ZL.header("Inbox", P ? "Snap receipts and bills — Zycount reads them, you check and record." : "Receipts, bills and payment slips waiting to be recorded. Snap or drop them here; Zycount reads each one.") +
        (canAdd ? `<section class="zl-drop" data-drop>
          <h3>Drop receipts, bills or payment slips here</h3>
          <p>Photos (JPG, PNG, HEIC) or PDFs, several at once. Each is read automatically — date, amount, SST, ${P ? "shop" : "supplier or customer"} and reference — and waits here until you record it. You can also paste a screenshot.</p>
          <div class="zl-actions"><button type="button" class="zl-btn primary" data-cam>${CAMERA}Take a photo</button>
            <button type="button" class="zl-btn" data-pick>${CLIP}Choose files</button></div>
          <input type="file" accept="image/*" capture="environment" hidden data-cam-in>
          <input type="file" accept="image/*,application/pdf" multiple hidden data-pick-in>
          <div class="zl-work" data-work></div></section>` : "") +
        `<div class="zl-tabs" role="group" aria-label="Show">${[["todo", "To record"], ["done", "Recorded"], ["all", "All"]].map(([k, l]) =>
          `<button type="button" data-tab="${k}" aria-pressed="${k === tab}">${l} (${counts[k]})</button>`).join("")}</div>` +
        (list.length ? `<div class="zl-inbox">${list.map(card).join("")}</div>`
          : ZL.empty(tab === "done" ? "Nothing recorded from the Inbox yet" : "Nothing waiting", tab === "done" ? "Documents you record from here show up in this list with a link to their entry." : "Snap or drop a receipt above. It's read and kept here until you record it."));
    },
    async after(root, ctx) {
      const list = ctx.list || [];
      const byId = new Map(list.map((a) => [a.id, a]));
      // Thumbnails
      urlsFor(list.filter((a) => a.mime !== "application/pdf")).then((u) => {
        root.querySelectorAll("[data-att]").forEach((c) => { const url = u.get(c.dataset.att); if (url) c.querySelector("[data-view]").style.backgroundImage = `url('${url}')`; });
      }).catch(() => null);
      root.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => ZL.open("capture", { tab: b.dataset.tab })));
      root.querySelectorAll("[data-att]").forEach((c) => {
        const a = byId.get(c.dataset.att);
        const on = (sel, fn) => { const el = c.querySelector(sel); if (el) el.addEventListener("click", () => fn(el)); };
        on("[data-view]", () => view(a));
        on("[data-rec]", () => ACTIONS[c.querySelector("[data-as]").value].run(a));
        on("[data-read]", async (el) => {
          el.disabled = true; el.textContent = "Reading…";
          try { await read(a); ZL.refresh(); } catch (e) { ZL.toast(ZL.errorText(e), e.code === "AI_NOT_CONFIGURED" ? "warn" : "bad"); el.disabled = false; el.textContent = "Read it"; }
        });
        on("[data-del]", async () => {
          if (!(await ZL.confirm({ title: `Delete ${E(a.file_name)}?`, message: "It isn't attached to anything, so nothing in the books changes. This can't be undone.", confirmLabel: "Delete", danger: true }))) return;
          try { await remove(a); ZL.toast("Deleted."); ZL.refresh(); } catch (e) { ZL.toast(ZL.errorText(e), "bad"); }
        });
        on("[data-go]", (el) => { const [t, id] = el.dataset.go.split(":"); if (t === "TRADE_DOC") ZL.open("tradedoc", { id }); else ZL.open("journal", { id }); });
      });
      const drop = root.querySelector("[data-drop]");
      if (!drop) return;
      const work = drop.querySelector("[data-work]");
      let busy = 0, done = 0;
      const take = async (fileList) => {
        const picked = [...fileList].filter((f) => f && f.size);
        if (!picked.length) return;
        busy += picked.length;
        const rows = picked.map((f) => { const d = document.createElement("div"); d.innerHTML = `<span class="zl-spin"></span>${E(f.name || "Pasted image")} — uploading…`; work.appendChild(d); return d; });
        let pending = [];
        for (let i = 0; i < picked.length; i++) {
          try {
            const a = await upload(picked[i]);
            rows[i].innerHTML = `<span class="zl-spin"></span>${E(a.file_name)} — reading…${a.duplicate ? ` <span class="chip warn">Uploaded before</span>` : ""}`;
            pending.push(read(a).then(() => { rows[i].innerHTML = `✓ ${E(a.file_name)} — read.`; })
              .catch((e) => { rows[i].innerHTML = `• ${E(a.file_name)} — ${E(e.code === "AI_NOT_CONFIGURED" ? "kept; key it in when you record it." : ZL.errorText(e))}`; }));
            if (pending.length >= 2) { await Promise.all(pending); pending = []; }
          } catch (e) {
            rows[i].innerHTML = `✕ ${E(picked[i].name || "File")} — ${E(ZL.errorText(e))}`;
          }
        }
        await Promise.all(pending);
        done += picked.length;
        busy -= picked.length;
        if (!busy) { ZL.toast(`${done} document${done === 1 ? "" : "s"} added to the Inbox.`); setTimeout(() => { if (root.isConnected) ZL.refresh(); }, 600); }
      };
      drop.querySelector("[data-cam]").addEventListener("click", () => drop.querySelector("[data-cam-in]").click());
      drop.querySelector("[data-pick]").addEventListener("click", () => drop.querySelector("[data-pick-in]").click());
      drop.querySelectorAll("input[type=file]").forEach((inp) => inp.addEventListener("change", () => { const f = [...inp.files]; inp.value = ""; take(f); }));
      drop.addEventListener("dragover", (ev) => { ev.preventDefault(); drop.classList.add("over"); });
      drop.addEventListener("dragleave", () => drop.classList.remove("over"));
      drop.addEventListener("drop", (ev) => { ev.preventDefault(); drop.classList.remove("over"); take(ev.dataTransfer.files); });
      const onPaste = (ev) => {
        if (!root.isConnected) { document.removeEventListener("paste", onPaste); return; }
        if (document.querySelector(".zl-scrim")) return; // a form is open
        const f = [...(ev.clipboardData ? ev.clipboardData.files : [])];
        if (f.length) { ev.preventDefault(); take(f); }
      };
      document.addEventListener("paste", onPaste);
    },
  });

  ZL.capture = { evidence, panel, view, upload, read, matchContact, accountFor, taxFor, methodFor, moneyFor, put, linesOf, contactFrom, parseText, suggestAction };
})();
