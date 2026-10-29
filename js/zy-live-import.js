/* ═══════════════════════════════════════════════════════════════════════════
 * Zycount live workspace — statement import.
 * Reads PDF e-statements from any bank or card (text PDFs; scanned images
 * can't be read), guesses a category for every line from what you chose
 * before and from common Malaysian merchants, and records the lines you tick
 * in one go. Lines already in the books or already imported are skipped by
 * the database (see statement_import migration).
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const ZL = window.ZL;
  const E = ZL.esc;
  const M = ZL.money;
  const cid = () => ZL.company.company_id;
  const btn = (id, label, cls = "") => `<button type="button" class="zl-btn ${cls}" id="${id}">${label}</button>`;

  // ── PDF reading ───────────────────────────────────────────────────────────
  const WORKER = { src: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
    integrity: "sha384-SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2" };
  let workerUrl = null;
  async function pdfReady() {
    await ZL.lib("pdfjs");
    if (!workerUrl) {
      // A same-origin copy of the pinned worker, checked against its hash.
      const res = await fetch(WORKER.src, { integrity: WORKER.integrity, mode: "cors", credentials: "omit" });
      if (!res.ok) throw new ZL.ZLError("NETWORK", "The PDF reader didn't load. Check your connection and try again.");
      workerUrl = URL.createObjectURL(new Blob([await res.text()], { type: "text/javascript" }));
    }
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  }

  const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, MEI: 5, JUN: 6, JUL: 7, AUG: 8, OGO: 8, SEP: 9, SEPT: 9, OCT: 10, OKT: 10, NOV: 11, DEC: 12, DIS: 12 };
  const iso = (y, m, d) => {
    if (y < 100) y += 2000;
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
      ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
  };
  const AMOUNT = /^\(?(?:RM)?[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\)?(?:[-+]|CR|DR)?$/i;
  const SUFFIX = /^(?:CR|DR|[-+])$/i;
  const amountOf = (s) => {
    const t = s.toUpperCase().replace(/^RM/, "");
    let sign = 0;
    if (/^\(|^-|-$|DR$/.test(t)) sign = -1;
    else if (/\+$|CR$|^\+/.test(t)) sign = 1;
    return { value: Number(t.replace(/[^0-9.]/g, "")), sign };
  };

  /** Rows of positioned words from every page. */
  async function pdfRows(file, password) {
    await pdfReady();
    const data = new Uint8Array(await file.arrayBuffer());
    let doc;
    try {
      doc = await window.pdfjsLib.getDocument({ data, password: password || undefined, isEvalSupported: false }).promise;
    } catch (e) {
      if (e && e.name === "PasswordException") {
        throw new ZL.ZLError("PDF_PASSWORD", e.code === 2 ? "That password didn't open the file. Try again."
          : "This statement is locked with a password. Banks often use your IC number or date of birth.");
      }
      throw new ZL.ZLError("VALIDATION", "That PDF couldn't be opened. Is it a complete statement file?");
    }
    const rows = [];
    let chars = 0;
    for (let p = 1; p <= Math.min(doc.numPages, 80); p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const words = [];
      tc.items.forEach((it) => {
        const s = String(it.str || "");
        if (!s.trim()) return;
        chars += s.trim().length;
        const x0 = it.transform[4], y = it.transform[5], w = it.width || s.length * 5;
        // Split a text run into words, keeping each word's approximate x.
        let i = 0;
        s.split(/(\s+)/).forEach((part) => {
          if (part && !/^\s+$/.test(part)) words.push({ s: part, x: x0 + (i / Math.max(1, s.length)) * w, y });
          i += part.length;
        });
      });
      words.sort((a, b) => b.y - a.y || a.x - b.x);
      let cur = null;
      words.forEach((wd) => {
        if (!cur || Math.abs(cur.y - wd.y) > 2.5) { cur = { page: p, y: wd.y, words: [] }; rows.push(cur); }
        cur.words.push(wd);
      });
    }
    rows.forEach((r) => r.words.sort((a, b) => a.x - b.x));
    if (chars < 40) {
      throw new ZL.ZLError("VALIDATION", "This PDF has no readable text — it is probably a scanned image. Download the e-statement from your online banking instead (PDF, CSV or Excel).");
    }
    return rows;
  }

  /** The statement's year, from the full dates printed on it. */
  function statementYear(rows) {
    const count = {};
    rows.forEach((r) => {
      const text = r.words.map((w) => w.s).join(" ");
      (text.match(/\b\d{1,2}[/.-]\d{1,2}[/.-](\d{4}|\d{2})\b/g) || []).forEach((m) => {
        let y = +m.split(/[/.-]/)[2]; if (y < 100) y += 2000; if (y > 1990 && y < 2100) count[y] = (count[y] || 0) + 1;
      });
      (text.match(/\b\d{1,2}[\s-]?[A-Za-z]{3,4}[\s-]?(\d{4})\b/g) || []).forEach((m) => {
        const y = +m.slice(-4); if (y > 1990 && y < 2100) count[y] = (count[y] || 0) + 1;
      });
    });
    const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
    return best ? +best[0] : new Date().getFullYear();
  }

  /** A date at the start of a row; returns { iso, used } or null. */
  function leadingDate(ws, year) {
    const t0 = (ws[0] || {}).s || "", t1 = (ws[1] || {}).s || "", t2 = (ws[2] || {}).s || "";
    let m;
    if ((m = t0.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return { iso: iso(+m[1], +m[2], +m[3]), used: 1 };
    if ((m = t0.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/))) return { iso: iso(+m[3], +m[2], +m[1]), used: 1 };
    if ((m = t0.match(/^(\d{1,2})[/.-](\d{1,2})$/))) return { iso: iso(year, +m[2], +m[1]), used: 1, noYear: true };
    if ((m = t0.match(/^(\d{1,2})-?([A-Za-z]{3,4})-?(\d{2}|\d{4})?$/)) && MONTHS[m[2].toUpperCase()]) {
      if (m[3]) return { iso: iso(+m[3], MONTHS[m[2].toUpperCase()], +m[1]), used: 1 };
      if (/^(\d{4}|\d{2})$/.test(t1)) return { iso: iso(+t1, MONTHS[m[2].toUpperCase()], +m[1]), used: 2 };
      return { iso: iso(year, MONTHS[m[2].toUpperCase()], +m[1]), used: 1, noYear: true };
    }
    if (/^\d{1,2}$/.test(t0) && MONTHS[t1.toUpperCase()]) {
      if (/^(\d{4}|\d{2})$/.test(t2)) return { iso: iso(+t2, MONTHS[t1.toUpperCase()], +t0), used: 3 };
      return { iso: iso(year, MONTHS[t1.toUpperCase()], +t0), used: 2, noYear: true };
    }
    return null;
  }

  const OPENING = /(OPENING|BEGINNING|PREVIOUS)\s+BALANCE|BALANCE\s+(B\/?F|BROUGHT)|BAKI\s+(MULA|AWAL|DIBAWA|PERMULAAN)|BROUGHT\s+FORWARD|B\/F\b/i;
  const CLOSING = /(CLOSING|ENDING|CURRENT|NEW|OUTSTANDING)\s+BALANCE|BALANCE\s+C\/?F|BAKI\s+(AKHIR|PENUTUP)|CARRIED\s+FORWARD|\bC\/F\b|^TOTAL\b|^JUMLAH\b/i;
  const NOISE = /\bPAGE\s+\d|MUKA\s+SURAT|STATEMENT\s+(DATE|OF)|PENYATA|ACCOUNT\s+(NO|NUMBER)|NO\.?\s+AKAUN/i;

  /**
   * Turns positioned rows into statement lines. The sign of each amount comes,
   * in order, from its own marker (CR/DR, +/-, brackets), the change in the
   * running balance, the debit/credit column it sits under, else the account
   * type (card statements list charges).
   */
  function parseRows(rows, liability) {
    const year = statementYear(rows);
    const out = [];
    let opening = null, closing = null, prevBal = null, cols = null, last = null, skipped = 0, cont = 0;
    const gaps = [];
    for (let i = 1; i < rows.length; i++) if (rows[i].page === rows[i - 1].page) gaps.push(rows[i - 1].y - rows[i].y);
    gaps.sort((a, b) => a - b);
    const lineH = gaps.length ? Math.max(8, gaps[Math.floor(gaps.length / 2)]) : 12;

    rows.forEach((row) => {
      const ws = row.words.slice();
      for (let i = ws.length - 1; i > 0; i--) { // "1,234.56" + "CR" → one token
        if (SUFFIX.test(ws[i].s) && AMOUNT.test(ws[i - 1].s)) { ws[i - 1] = Object.assign({}, ws[i - 1], { s: ws[i - 1].s + ws[i].s }); ws.splice(i, 1); }
      }
      const text = ws.map((w) => w.s).join(" ");
      const amts = ws.filter((w) => AMOUNT.test(w.s));
      if (!amts.length && /DEBIT|WITHDRAWAL|PENGELUARAN|KELUAR/i.test(text) && /CREDIT|DEPOSIT|SIMPANAN|MASUK/i.test(text)) {
        const at = (re) => { const w = ws.find((x) => re.test(x.s)); return w ? w.x : null; };
        cols = { debit: at(/DEBIT|WITHDRAWAL|PENGELUARAN|KELUAR/i), credit: at(/CREDIT|DEPOSIT|SIMPANAN|MASUK/i) };
        return;
      }
      if (OPENING.test(text) && amts.length) {
        const a = amountOf(amts[amts.length - 1].s);
        opening = (a.sign || 1) * a.value; prevBal = opening; last = null; return;
      }
      if (CLOSING.test(text)) {
        if (amts.length && /BALANCE|BAKI|C\/F|FORWARD/i.test(text)) { const a = amountOf(amts[amts.length - 1].s); closing = (a.sign || 1) * a.value; }
        last = null; return;
      }
      const d = leadingDate(ws, year);
      if (d && d.iso && amts.length) {
        let txn = amts[0], bal = null;
        if (amts.length >= 2) { bal = amts[amts.length - 1]; txn = amts[amts.length - 2]; }
        const a = amountOf(txn.s);
        const b = bal ? amountOf(bal.s) : null;
        const balVal = b ? (b.sign === -1 ? -b.value : b.value) : null;
        let sign = a.sign, how = sign ? "marker" : "";
        if (!sign && balVal != null && prevBal != null) {
          const delta = Math.round((balVal - prevBal) * 100) / 100;
          if (Math.abs(Math.abs(delta) - a.value) < 0.005 && delta !== 0) { sign = Math.sign(delta) * (liability ? -1 : 1); how = "balance"; }
        }
        if (!sign && cols && cols.debit != null && cols.credit != null) {
          sign = Math.abs(txn.x - cols.debit) <= Math.abs(txn.x - cols.credit) ? -1 : 1; how = "column";
        }
        if (!sign) { sign = -1; how = liability ? "card" : "guess"; }
        if (balVal != null) prevBal = balVal;
        const skip = new Set([...ws.slice(0, d.used), ...amts]);
        const desc = ws.filter((w) => !skip.has(w) && !leadingDate([w], year)).map((w) => w.s).join(" ").replace(/\s+/g, " ").trim();
        last = { date: d.iso, description: desc.slice(0, 300), reference: "", amount: sign * a.value, balance: balVal, uncertain: how === "guess", page: row.page, y: row.y };
        out.push(last); cont = 0;
        return;
      }
      // A wrapped description continues on the next line or two.
      if (!d && !amts.length && last && row.page === last.page && last.y - row.y > 0 && last.y - row.y < lineH * 2.6 && cont < 2 && !NOISE.test(text)) {
        last.description = `${last.description} ${text}`.replace(/\s+/g, " ").trim().slice(0, 300);
        last.y = row.y; cont++;
        return;
      }
      if (amts.length) skipped++;
    });

    // Lines dated without a year that fall after the statement's end belong to the year before.
    const lines = out.map(({ page, y, ...l }) => l);
    // Balance check: opening + movements = closing (a card owes the other way round).
    const net = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    let balanced = null, flipped = 0;
    if (opening != null && closing != null) {
      const expect = (o, n) => Math.round((liability ? o - n : o + n) * 100) / 100;
      balanced = Math.abs(expect(opening, net) - closing) < 0.01;
      if (!balanced && lines.some((l) => l.uncertain)) {
        const flipNet = Math.round(lines.reduce((s, l) => s + (l.uncertain ? -l.amount : l.amount), 0) * 100) / 100;
        if (Math.abs(expect(opening, flipNet) - closing) < 0.01) {
          lines.forEach((l) => { if (l.uncertain) { l.amount = -l.amount; flipped++; } });
          balanced = true;
        }
      }
    }
    return { lines, opening, closing, balanced, uncertain: lines.filter((l) => l.uncertain).length, flipped, skipped, year };
  }

  ZL.statementPdf = {
    async read(file, { password, liability } = {}) {
      return parseRows(await pdfRows(file, password), !!liability);
    },
    parseRows,
  };

  /** The text of a PDF as lines, top to bottom (first 10 pages). Empty for a scanned image. */
  ZL.pdfText = async (blob) => {
    await pdfReady();
    let doc;
    try {
      doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
    } catch (e) {
      throw new ZL.ZLError("VALIDATION", e && e.name === "PasswordException" ? "This PDF is locked with a password." : "That PDF couldn't be opened.");
    }
    const out = [];
    for (let p = 1; p <= Math.min(doc.numPages, 10); p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      const rows = new Map();
      tc.items.forEach((it) => {
        const s = String(it.str || "").trim();
        if (!s) return;
        const y = Math.round(it.transform[5] / 3);
        if (!rows.has(y)) rows.set(y, []);
        rows.get(y).push({ x: it.transform[4], s });
      });
      [...rows.keys()].sort((a, b) => b - a).forEach((y) => out.push(rows.get(y).sort((a, b) => a.x - b.x).map((w) => w.s).join(" ")));
    }
    return out;
  };

  // ── Categories ────────────────────────────────────────────────────────────
  const STOP = new Set(("IBG DUITNOW FPX TRANSFER TRF TFR TRSF FUND FUNDS PAYMENT PYMT PMT POS PURCHASE PURCHASES DEBIT CREDIT CARD SALE SALES " +
    "MYDEBIT VISA MASTERCARD MASTER INSTANT INTERBANK GIRO FROM ACCOUNT ACC ONLINE MBB MAYBANK CIMB RHB PBB PUBLIC HLB HONG LEONG AMB AMBANK " +
    "BIMB BSN AFFIN ALLIANCE OCBC UOB HSBC SCB SDN BHD BERHAD THE AND FOR MALAYSIA REF TXN TRX TRANS PAY JOMPAY BILL BILLS INTERNET BANKING " +
    "CDT INWARD OUTWARD RECEIVED RECV SENT DEBITED CREDITED DUIT NOW MOBILE APP").split(" "));
  /** A short, stable key for a description: its first two meaningful words. */
  ZL.categoryKey = (desc) => String(desc || "").toUpperCase().replace(/'/g, "").replace(/[^A-Z& ]+/g, " ")
    .split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)).slice(0, 2).join(" ");

  // Common Malaysian payees → personal categories. Asset/liability codes become transfers.
  const PERSONAL_RULES = [
    [/TNG\s*E-?WALLET|TOUCH\s*'?N\s*'?GO\s*E-?WALLET|GRABPAY|BOOST|SHOPEEPAY|MAE\s*WALLET|E-?WALLET|RELOAD/, "1140", "OUT"],
    [/\bPTPTN\b/, "2540", "OUT"],
    [/HOUSING\s*LOAN|HOME\s*LOAN|PINJAMAN\s*PERUMAHAN|MORTGAGE|LPPSA/, "2510", "OUT"],
    [/CAR\s*LOAN|HIRE\s*PURCHASE|SEWA\s*BELI|AUTO\s*FINANCE/, "2520", "OUT"],
    [/PERSONAL\s*LOAN|PINJAMAN\s*PERIBADI/, "2530", "OUT"],
    [/ATOME|SPAYLATER|PAYLATER|HOOLAH/, "2120", "OUT"],
    [/CREDIT\s*CARD|KAD\s*KREDIT|\bCC\s*(PAYMENT|PYMT)|CARD\s*PAYMENT/, "2110", "OUT"],
    [/PAYMENT.*THANK|BAYARAN.*TERIMA|PAYMENT\s*RECEIVED/, "1120", "IN"],
    [/\bASB\b|ASNB|AMANAH\s*SAHAM|UNIT\s*TRUST|PUBLIC\s*MUTUAL/, "1220", "OUT"],
    [/TABUNG\s*HAJI|\bLTH\b/, "1250", "OUT"],
    [/FIXED\s*DEPOSIT|\bFD\s*PLACEMENT|SIMPANAN\s*TETAP/, "1210", "OUT"],
    [/\bATM\b|CASH\s*WITHDRAWAL|PENGELUARAN\s*TUNAI|\bCDM\s*WDL/, "1110", "OUT"],
    [/CASH\s*DEPOSIT|DEPOSIT\s*TUNAI|\bCDM\b/, "1110", "IN"],
    [/SALARY|GAJI|PAYROLL|\bSAL\b|EMOLUMEN/, "4110", "IN"],
    [/BONUS|ALLOWANCE|ELAUN|INSENTIF|INCENTIVE/, "4120", "IN"],
    [/DIVIDEN|INTEREST|FAEDAH|HIBAH|PROFIT\s*PAID/, "4510", "IN"],
    [/RENTAL|SEWA/, "4520", "IN"],
    [/TNB|TENAGA|SYABAS|AIR\s*SELANGOR|INDAH\s*WATER|\bIWK\b|PBAPP|\bSAJ\b|SESB|SARAWAK\s*ENERGY/, "6120", "OUT"],
    [/UNIFI|TM\s*NET|TELEKOM|MAXIS|CELCOM|\bDIGI\b|U\s*MOBILE|YES\s*4G|TIME\s*(DOTCOM|FIBRE)|HOTLINK|\bXOX\b|TUNETALK|REDONE/, "6130", "OUT"],
    [/GRABFOOD|FOODPANDA|SHOPEEFOOD|MCDONALD|\bMCD\b|\bKFC\b|PIZZA|STARBUCKS|\bZUS\b|TEALIVE|CHAGEE|SECRET\s*RECIPE|RESTORAN|RESTAURANT|NASI|MAMAK|KOPITIAM|CAFE|COFFEE|OLDTOWN|MARRYBROWN|SUBWAY|DOMINO|SUSHI|BURGER/, "6220", "OUT"],
    [/LOTUS|TESCO|AEON|GIANT|MYDIN|SPEEDMART|JAYA\s*GROCER|VILLAGE\s*GROCER|\bNSK\b|ECONSAVE|FAMILYMART|7-?\s*ELEVEN|KK\s*(SUPER|MART)|HERO\s*MARKET|PASARAYA|GROCER|BILLION/, "6210", "OUT"],
    [/PETRONAS|SHELL|PETRON|CALTEX|BHPETROL|\bBHP\b|TOUCH\s*'?N\s*'?GO|\bTNG\b|PLUS\s*MALAYSIA|SMART\s*TAG|PARKING|PARKIR|FLEXIPARKING|JOMPARKING/, "6310", "OUT"],
    [/\bGRAB\b|MYCAR|RAPID\s*KL|\bMRT\b|\bLRT\b|\bKTM\b|\bERL\b|PRASARANA/, "6320", "OUT"],
    [/PUSPAKOM|\bJPJ\b|ROAD\s*TAX|CUKAI\s*JALAN|MYEG|PROTON|PERODUA|TYRE|TAYAR|WORKSHOP|BENGKEL/, "6330", "OUT"],
    [/UNIQLO|\bH&M\b|ZARA|PADINI|BRANDS\s*OUTLET|COTTON\s*ON|SPORTS\s*DIRECT|\bBATA\b|NIKE|ADIDAS/, "6410", "OUT"],
    [/CLINIC|KLINIK|HOSPITAL|FARMASI|PHARMACY|GUARDIAN|WATSONS|CARING|DENTAL|PERGIGIAN|\bKPJ\b|COLUMBIA\s*ASIA|PANTAI/, "6420", "OUT"],
    [/UNIVERSITI|UNIVERSITY|COLLEGE|KOLEJ|SCHOOL|SEKOLAH|TUITION|TUISYEN|UDEMY|COURSERA/, "6430", "OUT"],
    [/NETFLIX|SPOTIFY|ASTRO|YOUTUBE|DISNEY|APPLE\.COM|ITUNES|GOOGLE|STEAM|PLAYSTATION|CINEMA|\bGSC\b|\bTGV\b|\bMBO\b|\bVIU\b|IQIYI/, "6440", "OUT"],
    [/SALON|BARBER|GUNTING|\bSPA\b|SEPHORA/, "6450", "OUT"],
    [/TASKA|TADIKA|NURSERY|KINDERGARTEN|MOTHERCARE/, "6510", "OUT"],
    [/LOAN\s*INTEREST|FINANCE\s*CHARGE|CAJ\s*KEWANGAN/, "6610", "OUT"],
    [/SERVICE\s*CHARGE|SVC\s*CHG|BANK\s*CHARGE|CAJ\s*PERKHIDMATAN|ANNUAL\s*FEE|LATE\s*(CHARGE|FEE)|STAMP\s*DUTY|DUTI\s*SETEM|\bFEE\b|COMMISSION/, "6620", "OUT"],
    [/INSURANCE|INSURANS|TAKAFUL|PRUDENTIAL|\bAIA\b|GREAT\s*EASTERN|ALLIANZ|ETIQA|ZURICH|TOKIO\s*MARINE|MANULIFE|SUN\s*LIFE|\bFWD\b/, "6630", "OUT"],
    [/LHDN|\bHASIL\b|INCOME\s*TAX|CUKAI\s*PENDAPATAN|\bPCB\b/, "6640", "OUT"],
    [/ZAKAT|\bLZS\b|MAIWP|\bPPZ\b/, "6650", "OUT"],
    [/SEDEKAH|DERMA|DONATION|WAKAF|MASJID|SURAU|YAYASAN/, "6710", "OUT"],
    [/\bRENT\b|SEWA\s*RUMAH/, "6110", "OUT"],
    [/SHOPEE|LAZADA|ZALORA|\bTEMU\b|TIKTOK\s*SHOP|AMAZON|ALIEXPRESS/, "6790", "OUT"],
  ];

  /** Returns guess(line) → { account, why } | null, from learned rules first, then common payees. */
  ZL.categoriser = (accounts, rules, statementAccount) => {
    const usable = new Map(accounts.filter((a) => a.is_postable && a.is_active && a.id !== statementAccount).map((a) => [a.id, a]));
    const byCode = new Map(accounts.filter((a) => usable.has(a.id)).map((a) => [a.code, a]));
    const personal = ZL.isPersonal();
    return (line) => {
      const dir = line.amount > 0 ? "IN" : "OUT";
      const key = ZL.categoryKey(line.description);
      const mine = rules.filter((r) => r.direction === dir && usable.has(r.account_id));
      let r = key && mine.find((x) => x.pattern === key);
      if (!r && key) {
        const first = key.split(" ")[0];
        r = mine.filter((x) => x.pattern.split(" ")[0] === first).sort((a, b) => b.uses - a.uses)[0];
      }
      if (r) return { account: r.account_id, why: "You chose this before" };
      if (!personal) return null;
      const text = String(line.description || "").toUpperCase();
      for (const [re, code, d] of PERSONAL_RULES) {
        if (d && d !== dir) continue;
        if (re.test(text)) { const a = byCode.get(code); if (a) return { account: a.id, why: "Common payee" }; }
      }
      return null;
    };
  };

  // ── Review and record ─────────────────────────────────────────────────────
  ZL.register("bankreview", {
    title: "Review statement",
    perm: "journal.view",
    nav: "bankrec",
    detail: true,
    async render(ctx) {
      const p = ctx.params;
      const P = ZL.isPersonal();
      const [sts, accounts, rules] = await Promise.all([
        ZL.select("bank_statements", "*", (q) => q.eq("id", p.st).eq("company_id", cid())),
        ZL.accounts(),
        ZL.select("category_rules", "pattern,direction,account_id,uses", (q) => q.eq("company_id", cid()).limit(5000)),
      ]);
      const st = sts[0];
      if (!st) return ZL.empty("Statement not found", "It may have been deleted.", btn("zl-rvback", "← Statements", "ghost"));
      const lines = await ZL.select("bank_lines", "*", (q) => q.eq("statement_id", st.id).order("line_no").limit(6000));
      const acc = new Map(accounts.map((a) => [a.id, a]));
      const bank = acc.get(st.account_id) || { name: "", code: "" };
      const todo = lines.filter((l) => l.status === "UNMATCHED");
      const matched = lines.filter((l) => l.status === "MATCHED").length;
      const dups = lines.filter((l) => l.status === "IGNORED" && /earlier statement/i.test(l.note || "")).length;
      const guess = ZL.categoriser(accounts, rules, st.account_id);
      const usable = accounts.filter((a) => a.is_postable && a.is_active && a.id !== st.account_id);
      const group = (types, label) => {
        const list = usable.filter((a) => types.includes(a.type));
        return list.length ? `<optgroup label="${E(label)}">${list.map((a) => `<option value="${a.id}">${E(a.name)} · ${E(a.code)}</option>`).join("")}</optgroup>` : "";
      };
      const optsIn = `<option value="">Choose…</option>${group(["REVENUE"], P ? "Income" : "Revenue")}${group(["ASSET"], P ? "From my own accounts (transfer)" : "Assets (transfer)")}${group(["LIABILITY"], P ? "Borrowed (transfer)" : "Liabilities (transfer)")}${group(["EQUITY"], P ? "Net worth" : "Equity")}`;
      const optsOut = `<option value="">Choose…</option>${group(["EXPENSE", "COST_OF_SALES"], P ? "Spending" : "Expenses")}${group(["ASSET"], P ? "To my own accounts (transfer)" : "Assets (transfer)")}${group(["LIABILITY"], P ? "Paying off (transfer)" : "Liabilities (transfer)")}${group(["EQUITY"], P ? "Net worth" : "Equity")}`;
      ctx.params._rows = todo.map((l) => ({ id: l.id, guess: guess(l), key: ZL.categoryKey(l.description) }));
      const guessed = ctx.params._rows.filter((r) => r.guess).length;
      return ZL.header(P ? "Record your statement" : "Record statement lines",
          `${st.name} · ${bank.name} ${bank.code} — ${ZL.date(st.date_from)} to ${ZL.date(st.date_to)}`,
          `${btn("zl-rvback", "← Statement", "ghost")}${todo.length && ZL.can("journal.post") ? btn("zl-rvgo", `Record ${todo.length}`, "primary") : ""}`) + `
        <div class="zl-sumrow"><span>To record<b class="num">${todo.length}</b></span><span>Categorised for you<b class="num">${guessed}</b></span>
          <span>Already in your books<b class="num">${matched}</b></span><span>Already imported<b class="num">${dups}</b></span></div>
        ${todo.length ? `<section class="card"><div class="tablewrap"><table class="zl-review">
          <thead><tr><th style="width:34px"><input type="checkbox" id="zl-rvall" checked aria-label="Tick all"></th><th>Date</th><th>Description</th><th class="r">In</th><th class="r">Out</th><th style="min-width:230px">Category</th></tr></thead>
          <tbody>${todo.map((l, i) => { const g = ctx.params._rows[i].guess; return `<tr data-rvline="${l.id}">
            <td><input type="checkbox" data-rvtick${g ? " checked" : ""} aria-label="Record this line"></td>
            <td class="nil" style="white-space:nowrap">${ZL.date(l.date)}</td>
            <td>${E(l.description || "—")}</td>
            <td class="r num zl-amt-in">${l.amount > 0 ? M(l.amount) : ""}</td><td class="r num">${l.amount < 0 ? M(-l.amount) : ""}</td>
            <td><select class="zl-input" data-rvcat>${(l.amount > 0 ? optsIn : optsOut).replace(g ? `value="${g.account}"` : "\u0000", g ? `value="${g.account}" selected` : "")}</select>
              ${g ? `<small class="hint">${E(g.why)}</small>` : ""}</td></tr>`; }).join("")}</tbody></table></div>
          <div class="proofrow"><span>${P ? "Money moved to cash, an e-wallet, a card or a loan is recorded as a transfer, not spending." : "Lines categorised to an asset or liability are recorded as transfers."} What you choose is remembered for the next statement.</span></div></section>`
          : ZL.empty("Nothing left to record", `Every line on this statement is in your books${dups ? " or was imported before" : ""}.`,
            btn("zl-rvdone", P ? "See money in & out" : "See the reconciliation", "primary"))}`;
    },
    after(root, ctx) {
      const p = ctx.params;
      const back = root.querySelector("#zl-rvback");
      if (back) back.addEventListener("click", () => ZL.open("bankrec", { st: p.st }));
      const done = root.querySelector("#zl-rvdone");
      if (done) done.addEventListener("click", () => (ZL.isPersonal() ? go("transactions") : ZL.open("bankrec", { st: p.st })));
      const all = root.querySelector("#zl-rvall");
      const ticks = () => [...root.querySelectorAll("[data-rvline]")];
      const count = () => {
        const n = ticks().filter((tr) => tr.querySelector("[data-rvtick]").checked && tr.querySelector("[data-rvcat]").value).length;
        const b = root.querySelector("#zl-rvgo");
        if (b) { b.textContent = n ? `Record ${n}` : "Record"; b.disabled = !n; }
      };
      if (all) all.addEventListener("change", () => { ticks().forEach((tr) => { tr.querySelector("[data-rvtick]").checked = all.checked; }); count(); });
      root.querySelectorAll("[data-rvcat]").forEach((s) => s.addEventListener("change", () => {
        const tr = s.closest("tr");
        tr.querySelector("[data-rvtick]").checked = !!s.value;
        const hint = tr.querySelector("small.hint"); if (hint) hint.remove();
        count();
      }));
      root.querySelectorAll("[data-rvtick]").forEach((c) => c.addEventListener("change", count));
      count();
      const go_ = root.querySelector("#zl-rvgo");
      if (go_) go_.addEventListener("click", async () => {
        const keys = new Map((p._rows || []).map((r) => [r.id, r.key]));
        const items = ticks().filter((tr) => tr.querySelector("[data-rvtick]").checked && tr.querySelector("[data-rvcat]").value)
          .map((tr) => ({ line_id: tr.dataset.rvline, account_id: tr.querySelector("[data-rvcat]").value, key: keys.get(tr.dataset.rvline) || "" }));
        const missing = ticks().filter((tr) => tr.querySelector("[data-rvtick]").checked && !tr.querySelector("[data-rvcat]").value).length;
        if (!items.length) { ZL.toast(missing ? "Choose a category for the ticked lines." : "Tick the lines to record.", "warn"); return; }
        go_.disabled = true; go_.textContent = "Recording…";
        try {
          const r = await ZL.rpc("record_bank_lines", { p_statement: p.st, p_items: items });
          if (r.errors && r.errors.length) {
            ZL.toast(`Recorded ${r.recorded}. ${r.errors.length} not recorded — line ${r.errors[0].line_no}: ${r.errors[0].message}`, "warn");
          } else ZL.toast(`Recorded ${r.recorded} transaction${r.recorded === 1 ? "" : "s"}.`);
          ZL.invalidate();
          ZL.open("bankreview", { st: p.st });
        } catch (e) { ZL.toast(ZL.errorText(e), "bad"); go_.disabled = false; count(); }
      });
      ZL.wireJournalLinks(root);
    },
  });

  const css = document.createElement("style");
  css.textContent = `
  .zl-review select.zl-input{padding:6px 8px;font-size:13px}
  .zl-review td{vertical-align:middle}
  .zl-review small.hint{display:block;margin-top:3px}
  `;
  document.head.appendChild(css);
})();
