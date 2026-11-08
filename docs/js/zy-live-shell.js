/* ═══════════════════════════════════════════════════════════════════════════
 * Zycount live workspace — the shell a finance team works in all day.
 *   ⌘K / Ctrl+K / "/"   one search box for pages, actions, customers, suppliers,
 *                       documents, journals and accounts (like Xero, NetSuite).
 *   + New (N)           every "create" in one menu.
 *   Needs attention     a bell and a dashboard worklist: overdue invoices, bills
 *                       due, drafts, bank lines to clear, unfiled receipts,
 *                       e-Invoice problems, months left open (attention_summary).
 *   Tables              click any column heading to sort.
 *   Rail footer         the plan and trial status, instead of a roadmap note.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const ZL = window.ZL;
  const E = ZL.esc;
  const M = ZL.money;
  const cid = () => ZL.company && ZL.company.company_id;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  const ico = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden>${d}</svg>`;
  const I = {
    search: ico('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>'),
    plus: ico('<path d="M12 5v14M5 12h14"/>'),
    bell: ico('<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
    doc: ico('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'),
    user: ico('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
    book: ico('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>'),
    go: ico('<path d="M5 12h14M13 6l6 6-6 6"/>'),
    bolt: ico('<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>'),
    help: ico('<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>'),
  };

  // ── Things you can create, in the order a finance team reaches for them ────
  function actions() {
    const P = ZL.isPersonal();
    const can = (p) => ZL.can(p);
    const list = [];
    const add = (group, label, hint, run, ok = true, kw = "") => { if (ok) list.push({ group, label, hint, run, kw }); };
    const trade = !P && can("journal.create") && typeof ZL.tradeEdit === "function";
    add("Sales · money in", "New invoice", "Bill a customer — adds to what they owe you", () => ZL.tradeEdit("INVOICE"), trade, "invois sales ar");
    add("Sales · money in", "Receive payment", "A customer paid — knock it off their invoices", () => ZL.tradePay("RECEIPT"), trade, "receipt or terima bayaran");
    add("Sales · money in", "New quotation", "A price offer; turn it into an invoice later", () => ZL.tradeEdit("QUOTATION"), trade, "quote sebut harga");
    add("Sales · money in", "Cash sale", "Sold and paid on the spot", () => ZL.tradeEdit("CASH_SALE"), trade);
    add("Sales · money in", "Credit note", "Reduce what a customer owes", () => ZL.tradeEdit("CREDIT_NOTE"), trade, "cn");
    add("Purchases · money out", "New purchase invoice (bill)", "Record a supplier's invoice — adds to what you owe", () => ZL.tradeEdit("BILL"), trade, "bill ap supplier invoice");
    add("Purchases · money out", "Pay supplier", "Pay bills and knock them off", () => ZL.tradePay("PAYMENT"), trade, "pv payment voucher bayar");
    add("Purchases · money out", "New purchase order", "Order from a supplier before the bill arrives", () => ZL.tradeEdit("PURCHASE_ORDER"), trade, "po");
    add("Purchases · money out", "Expense (payment voucher)", "Money out that isn't a supplier bill — fees, rent, petrol", () => ZL.cashEntry("OUT"), !P && can("journal.create") && typeof ZL.cashEntry === "function", "pv belanja");
    add("Purchases · money out", "Other money in (official receipt)", "Interest, refunds, owner's money", () => ZL.cashEntry("IN"), !P && can("journal.create") && typeof ZL.cashEntry === "function", "or");
    add("Money", "Money in", "Record money that came in", () => ZL.quick("IN"), P && can("journal.create"), "income");
    add("Money", "Money out", "Record money you spent", () => ZL.quick("OUT"), P && can("journal.create"), "spending");
    add("Money", "Snap a receipt or bill", "Upload a photo or PDF; Zycount reads it", () => go("capture"), can("journal.create"), "scan ocr capture inbox");
    add("Money", "Upload a bank statement", "Match the bank against the books", () => go("bankrec"), can("journal.view"), "bank rec reconcile");
    add("Contacts", "New customer", "Someone you sell to", () => ZL.editContact("CUSTOMER"), !P && can("journal.create") && typeof ZL.editContact === "function", "pelanggan");
    add("Contacts", "New supplier", "Someone you buy from", () => ZL.editContact("SUPPLIER"), !P && can("journal.create") && typeof ZL.editContact === "function", "pembekal vendor");
    add("Accounting", "Journal entry", "A manual double entry — for accountants", () => ZL.open("journal", { isNew: true }), can("journal.create"), "jv adjustment");
    return list;
  }

  function pages() {
    const out = [];
    (typeof NAV !== "undefined" ? NAV : []).forEach((g) => g.items.forEach(([id, label]) => { if (ZL.modules[id]) out.push({ group: "Go to", label, hint: g.label || "", run: () => go(id), kw: id }); }));
    return out;
  }

  // ══ Command palette ═══════════════════════════════════════════════════════
  let pal = null;
  function closePalette() { if (pal) { pal.remove(); pal = null; document.removeEventListener("keydown", palKeys, true); } }
  function palKeys(ev) {
    if (!pal) return;
    const items = [...pal.querySelectorAll("[data-pi]")];
    let i = items.findIndex((x) => x.classList.contains("on"));
    if (ev.key === "Escape") { ev.preventDefault(); closePalette(); return; }
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!items.length) return;
      i = ev.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items.forEach((x) => x.classList.remove("on"));
      items[i].classList.add("on");
      items[i].scrollIntoView({ block: "nearest" });
    }
    if (ev.key === "Enter") { ev.preventDefault(); const el = items[i >= 0 ? i : 0]; if (el) el.click(); }
  }

  ZL.palette = (start = "") => {
    if (!ZL.company) return;
    closePalette();
    pal = document.createElement("div");
    pal.className = "zk-scrim";
    pal.innerHTML = `<div class="zk" role="dialog" aria-modal="true" aria-label="Search">
      <div class="zk-in">${I.search}<input id="zk-q" type="search" autocomplete="off" spellcheck="false" placeholder="Search pages, actions, customers, invoice no., accounts…" value="${E(start)}" aria-label="Search">
        <kbd>Esc</kbd></div>
      <div class="zk-list" id="zk-list" role="listbox"></div>
      <div class="zk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>${isMac ? "⌘" : "Ctrl"}</kbd><kbd>K</kbd> search</span><span><kbd>N</kbd> new</span></div></div>`;
    document.body.appendChild(pal);
    pal.addEventListener("mousedown", (ev) => { if (ev.target === pal) closePalette(); });
    document.addEventListener("keydown", palKeys, true);
    const q = pal.querySelector("#zk-q");
    const list = pal.querySelector("#zk-list");
    let seq = 0;
    const staticItems = () => actions().map((a) => Object.assign({ icon: I.bolt }, a)).concat(pages().map((p) => Object.assign({ icon: I.go }, p)));
    const score = (it, t) => {
      const hay = `${it.label} ${it.hint || ""} ${it.kw || ""} ${it.group}`.toLowerCase();
      if (!t) return 1;
      const words = t.split(/\s+/).filter(Boolean);
      if (!words.every((w) => hay.includes(w))) return 0;
      return it.label.toLowerCase().startsWith(words[0]) ? 3 : it.label.toLowerCase().includes(words[0]) ? 2 : 1;
    };
    const draw = (items, note = "") => {
      const groups = new Map();
      items.forEach((it) => { if (!groups.has(it.group)) groups.set(it.group, []); groups.get(it.group).push(it); });
      let k = 0;
      const runs = [];
      list.innerHTML = [...groups.entries()].map(([g, arr]) => `<div class="zk-g">${E(g)}</div>` + arr.map((it) => {
        runs.push(it.run);
        return `<button type="button" class="zk-i${k === 0 ? " on" : ""}" data-pi="${k++}" role="option">${it.icon || ""}<span><b>${E(it.label)}</b>${it.hint ? `<small>${E(it.hint)}</small>` : ""}</span>${it.right ? `<em class="num">${it.right}</em>` : ""}</button>`;
      }).join("")).join("") + (note ? `<div class="zk-note">${note}</div>` : "") || `<div class="zk-note">Nothing matches. Try an invoice number, a customer's name or an account code.</div>`;
      list.querySelectorAll("[data-pi]").forEach((b) => {
        b.addEventListener("click", () => { const fn = runs[+b.dataset.pi]; closePalette(); try { fn(); } catch (e) { ZL.toast(ZL.errorText(e), "bad"); } });
        b.addEventListener("mousemove", () => { list.querySelectorAll(".on").forEach((x) => x.classList.remove("on")); b.classList.add("on"); });
      });
    };
    const run = async () => {
      const t = q.value.trim().toLowerCase();
      const my = ++seq;
      const local = staticItems().map((it) => [score(it, t), it]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).map(([, it]) => it);
      const base = t ? local.slice(0, 12) : local.filter((x) => x.icon === I.bolt).slice(0, 8).concat(local.filter((x) => x.icon === I.go).slice(0, 10));
      draw(base, t.length >= 2 ? "Searching your books…" : "");
      if (t.length < 2) return;
      const term = t.replace(/[,()*%\\:"']/g, " ").trim().slice(0, 60);
      const P = ZL.isPersonal();
      const [docs, people, journals, accounts] = await Promise.all([
        P || !ZL.can("journal.view") ? [] : ZL.select("trade_docs", "id,doc_no,doc_type,side,bill_name,total,date,status",
          (x) => x.eq("company_id", cid()).or(`doc_no.ilike.*${term}*,bill_name.ilike.*${term}*,reference.ilike.*${term}*`).order("date", { ascending: false }).limit(6)).catch(() => []),
        P || !ZL.can("journal.view") ? [] : ZL.select("contacts", "id,name,code,kind",
          (x) => x.eq("company_id", cid()).or(`name.ilike.*${term}*,code.ilike.*${term}*`).limit(6)).catch(() => []),
        !ZL.can("journal.view") ? [] : ZL.select("journal_entries", "id,reference,doc_no,description,date,total_debit",
          (x) => x.eq("company_id", cid()).or(`reference.ilike.*${term}*,doc_no.ilike.*${term}*,description.ilike.*${term}*`).order("date", { ascending: false }).limit(5)).catch(() => []),
        ZL.accounts().catch(() => []),
      ]);
      if (my !== seq || !pal) return;
      const found = [];
      people.forEach((c) => found.push({ group: "Customers & suppliers", icon: I.user, label: c.name, hint: `${c.kind === "CUSTOMER" ? "Customer" : "Supplier"} · ${c.code || ""}`,
        run: () => ZL.open("contact", { id: c.id, side: c.kind === "CUSTOMER" ? "AR" : "AP" }) }));
      docs.forEach((d) => found.push({ group: "Documents", icon: I.doc, label: `${d.doc_no || "Draft"} · ${d.bill_name || ""}`.replace(/ · $/, ""),
        hint: `${String(d.doc_type).replace(/_/g, " ").toLowerCase()} · ${ZL.date(d.date)}${d.status === "DRAFT" ? " · draft" : ""}`, right: M(d.total),
        run: () => ZL.open("tradedoc", { id: d.id, side: d.side }) }));
      journals.forEach((j) => found.push({ group: "Journals", icon: I.book, label: `${j.doc_no || j.reference || "Journal"} — ${j.description || ""}`,
        hint: ZL.date(j.date), right: M(j.total_debit), run: () => ZL.open("journal", { id: j.id }) }));
      accounts.filter((a) => `${a.code} ${a.name}`.toLowerCase().includes(t)).slice(0, 6).forEach((a) => found.push({ group: "Accounts", icon: I.book,
        label: `${a.code} ${a.name}`, hint: String(a.type).replace(/_/g, " ").toLowerCase() + " · open the ledger",
        run: () => ZL.open("gl", { account: a.id, from: ZL.yearStart(), to: ZL.today() }) }));
      draw(local.slice(0, 6).concat(found));
    };
    q.addEventListener("input", ZL.debounce(run, 180));
    run();
    setTimeout(() => q.focus(), 0);
  };

  // ══ + New menu ════════════════════════════════════════════════════════════
  function newMenu(anchor) {
    const old = document.getElementById("zk-new");
    if (old) { old.remove(); return; }
    const list = actions();
    if (!list.length) { ZL.toast("Your role can't create entries in these books.", "warn"); return; }
    const m = document.createElement("div");
    m.id = "zk-new";
    m.className = "zk-menu";
    m.setAttribute("role", "menu");
    const groups = new Map();
    list.forEach((a, i) => { if (!groups.has(a.group)) groups.set(a.group, []); groups.get(a.group).push([a, i]); });
    m.innerHTML = [...groups.entries()].map(([g, arr]) => `<div class="zk-mg"><span>${E(g)}</span>${arr.map(([a, i]) =>
      `<button type="button" role="menuitem" data-ni="${i}"><b>${E(a.label)}</b><small>${E(a.hint)}</small></button>`).join("")}</div>`).join("");
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = `${r.bottom + 6}px`;
    m.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8))}px`;
    m.querySelectorAll("[data-ni]").forEach((b) => b.addEventListener("click", () => { m.remove(); list[+b.dataset.ni].run(); }));
    const off = (ev) => { if (!m.contains(ev.target) && ev.target !== anchor && !anchor.contains(ev.target)) { m.remove(); document.removeEventListener("mousedown", off); } };
    setTimeout(() => document.addEventListener("mousedown", off), 0);
    const first = m.querySelector("button");
    if (first) first.focus();
    m.addEventListener("keydown", (ev) => {
      const bs = [...m.querySelectorAll("button")];
      const i = bs.indexOf(document.activeElement);
      if (ev.key === "Escape") { m.remove(); anchor.focus(); }
      if (ev.key === "ArrowDown") { ev.preventDefault(); bs[(i + 1) % bs.length].focus(); }
      if (ev.key === "ArrowUp") { ev.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
    });
  }

  // ══ Needs attention ═══════════════════════════════════════════════════════
  let att = null, attAt = 0, attFor = null;
  ZL.attention = async (force = false) => {
    if (!cid() || ZL.isPersonal()) return null;
    if (!force && att && attFor === cid() && Date.now() - attAt < 60000) return att;
    try { att = await ZL.rpc("attention_summary", { p_company: cid() }); attAt = Date.now(); attFor = cid(); } catch (_) { att = null; }
    paintBell();
    return att;
  };
  /** The worklist: [{key, tone, title, detail, route, params, cta}] — only what needs doing. */
  function tasks(a) {
    if (!a || !a.can_view) return [];
    const t = [];
    const rm = (v) => M(v, { symbol: true });
    if (a.overdue_invoices.count) t.push({ tone: "bad", side: "AR", title: `${a.overdue_invoices.count} invoice${a.overdue_invoices.count === 1 ? " is" : "s are"} overdue`, detail: `${rm(a.overdue_invoices.amount)} your customers should have paid`, route: "araging", cta: "Chase" });
    if (a.overdue_bills.count) t.push({ tone: "bad", side: "AP", title: `${a.overdue_bills.count} bill${a.overdue_bills.count === 1 ? " is" : "s are"} past due`, detail: `${rm(a.overdue_bills.amount)} you owe suppliers`, route: "apaging", cta: "Pay" });
    if (a.bills_due_7.count) t.push({ tone: "warn", side: "AP", title: `${a.bills_due_7.count} bill${a.bills_due_7.count === 1 ? "" : "s"} due in the next 7 days`, detail: rm(a.bills_due_7.amount), route: "apaging", cta: "Review" });
    if (a.bank_to_clear) t.push({ tone: "warn", title: `${a.bank_to_clear} bank line${a.bank_to_clear === 1 ? "" : "s"} to reconcile`, detail: "On the statement but not yet in the books", route: "bankrec", cta: "Reconcile" });
    if (a.inbox) t.push({ tone: "", title: `${a.inbox} receipt${a.inbox === 1 ? "" : "s"} or bill${a.inbox === 1 ? "" : "s"} in the inbox`, detail: "Uploaded, not yet recorded", route: "capture", cta: "File" });
    if (a.einvoice_problems) t.push({ tone: "bad", title: `${a.einvoice_problems} e-Invoice${a.einvoice_problems === 1 ? "" : "s"} rejected by LHDN`, detail: "Fix and send again", route: "sales", params: {}, cta: "Fix" });
    if (a.draft_documents) t.push({ tone: "", title: `${a.draft_documents} draft document${a.draft_documents === 1 ? "" : "s"}`, detail: "Not in the books until posted", route: "sales", params: { status: "DRAFT" }, cta: "Open" });
    if (a.draft_journals) t.push({ tone: "", title: `${a.draft_journals} draft journal${a.draft_journals === 1 ? "" : "s"}`, detail: "Not in the books until posted", route: "journals", params: { status: "DRAFT" }, cta: "Open" });
    if (a.open_past_periods) t.push({ tone: "", title: `${a.open_past_periods} past month${a.open_past_periods === 1 ? " is" : "s are"} still open`, detail: a.oldest_open_period ? `Oldest: ${a.oldest_open_period.name}. Close months you've checked so nobody changes them.` : "", route: "periods", cta: "Close" });
    return t;
  }
  ZL.attentionTasks = tasks;
  function paintBell() {
    const b = document.getElementById("zk-bell");
    if (!b) return;
    const n = tasks(att).length;
    b.querySelector(".zk-badge").textContent = n ? String(n) : "";
    b.classList.toggle("has", n > 0);
    b.title = n ? `${n} thing${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} attention` : "Nothing needs attention";
  }
  function bellMenu(anchor) {
    const old = document.getElementById("zk-attn");
    if (old) { old.remove(); return; }
    const m = document.createElement("div");
    m.id = "zk-attn";
    m.className = "zk-menu zk-attn";
    const list = tasks(att);
    m.innerHTML = `<div class="zk-mh">Needs attention</div>${list.length ? list.map((t, i) => `<button type="button" data-ai="${i}" class="tone-${t.tone || "none"}">
        <b>${E(t.title)}</b><small>${E(t.detail || "")}</small></button>`).join("") : `<p class="zk-empty">You're all caught up.</p>`}`;
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = `${r.bottom + 6}px`;
    m.style.left = `${Math.max(8, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 8))}px`;
    m.querySelectorAll("[data-ai]").forEach((b) => b.addEventListener("click", () => { const t = list[+b.dataset.ai]; m.remove(); ZL.open(t.route, t.params || {}); }));
    const off = (ev) => { if (!m.contains(ev.target) && !anchor.contains(ev.target)) { m.remove(); document.removeEventListener("mousedown", off); } };
    setTimeout(() => document.addEventListener("mousedown", off), 0);
  }

  /** The dashboard worklist card. */
  ZL.worklistHtml = (a) => {
    const list = tasks(a);
    if (!a || !a.can_view) return "";
    return `<section class="card zk-work"><header><div><h3>Needs attention</h3><p>${list.length ? "Work waiting in these books, most urgent first" : "Nothing is waiting — the books are up to date"}</p></div></header>
      ${list.length ? `<div class="zk-wl">${list.map((t, i) => `<div class="zk-w tone-${t.tone || "none"}${t.side ? " " + ZL.SIDE_INFO[t.side].cls : ""}">
        <i></i><div><b>${E(t.title)}</b><small>${E(t.detail || "")}</small></div>
        <button type="button" class="zl-btn sm" data-wi="${i}">${E(t.cta)}</button></div>`).join("")}</div>`
        : `<p class="zk-done">${TICK} All caught up.</p>`}</section>`;
  };

  // ══ Topbar and rail ═══════════════════════════════════════════════════════
  function shell() {
    const bar = document.querySelector(".topbar");
    if (!bar || bar.dataset.zk) return;
    bar.dataset.zk = "1";
    const s = bar.querySelector(".search");
    if (s) {
      s.removeAttribute("aria-hidden");
      s.setAttribute("role", "button");
      s.setAttribute("tabindex", "0");
      s.classList.add("zk-search");
      s.innerHTML = `${I.search}<span>Search or jump to…</span><kbd>${isMac ? "⌘" : "Ctrl"} K</kbd>`;
      s.addEventListener("click", () => ZL.palette());
      s.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ZL.palette(); } });
    }
    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.id = "zk-newbtn";
    newBtn.className = "zl-btn primary zk-newbtn";
    newBtn.setAttribute("aria-haspopup", "menu");
    newBtn.innerHTML = `${I.plus}<span>New</span>`;
    newBtn.addEventListener("click", () => newMenu(newBtn));
    const bell = document.createElement("button");
    bell.type = "button";
    bell.id = "zk-bell";
    bell.className = "iconbtn zk-bell";
    bell.setAttribute("aria-label", "Needs attention");
    bell.innerHTML = `${I.bell}<span class="zk-badge"></span>`;
    bell.addEventListener("click", async () => { await ZL.attention(); bellMenu(bell); });
    const help = document.createElement("button");
    help.type = "button";
    help.className = "iconbtn";
    help.title = "Accounting words explained";
    help.setAttribute("aria-label", "Help");
    help.innerHTML = I.help;
    help.addEventListener("click", () => ZL.glossary && ZL.glossary());
    const theme = document.getElementById("theme");
    if (s) s.after(newBtn);
    if (theme) { theme.before(bell); theme.before(help); } else { bar.append(bell, help); }
  }

  async function railStatus() {
    const foot = document.querySelector(".rail-foot");
    if (!foot || !ZL.company) return;
    if (ZL.isPersonal()) { foot.innerHTML = `<span class="dot"></span>Personal books · free`; return; }
    try {
      const [sub] = await ZL.select("subscriptions", "plan_code,status,trial_ends_at,current_period_end", (q) => q.eq("company_id", cid()));
      if (!sub) { foot.textContent = ""; return; }
      const days = (iso) => Math.ceil((new Date(iso) - Date.now()) / 86400000);
      const plan = sub.plan_code.charAt(0) + sub.plan_code.slice(1).toLowerCase();
      let text = `${plan} plan`, tone = "";
      if (sub.status === "TRIAL") { const d = days(sub.trial_ends_at); text += d > 0 ? ` · trial, ${d} day${d === 1 ? "" : "s"} left` : " · trial ended"; tone = d > 0 ? "warn" : "bad"; }
      else if (sub.status === "ACTIVE") { const d = days(sub.current_period_end); text += d >= 0 ? ` · paid to ${ZL.date(sub.current_period_end)}` : " · payment due"; tone = d >= 0 ? "" : "bad"; }
      else text += ` · ${sub.status.toLowerCase()}`;
      foot.innerHTML = `<button type="button" class="zk-plan ${tone}" data-route-plan><span class="dot"></span>${E(text)}</button>`;
      foot.querySelector("[data-route-plan]").addEventListener("click", () => go("billing"));
    } catch (_) { foot.textContent = ""; }
  }

  // ══ Sortable tables ═══════════════════════════════════════════════════════
  const cellValue = (td) => {
    const t = (td ? td.innerText : "").trim();
    if (!t || t === "—" || t === "–") return { n: null, s: "" };
    const money = t.replace(/^RM\s*/i, "").replace(/\s*(Dr|Cr)$/, "");
    if (/^[(−-]?[\d,]+(\.\d+)?\)?%?$/.test(money)) {
      const neg = /^\(|^[−-]/.test(money) || /Cr$/.test(t);
      return { n: (neg ? -1 : 1) * Number(money.replace(/[(),−%-]/g, "")), s: t };
    }
    const d = /^\d{1,2} [A-Z][a-z]{2} \d{4}/.test(t) ? Date.parse(t.slice(0, 11)) : NaN;
    if (!Number.isNaN(d)) return { n: d, s: t };
    return { n: null, s: t.toLowerCase() };
  };
  function sortable(root) {
    root.querySelectorAll(".card .tablewrap > table").forEach((table) => {
      if (table.dataset.zkSort || table.closest(".stmt") || table.classList.contains("zl-lines") || table.classList.contains("zl-proof")) return;
      const head = table.tHead, body = table.tBodies[0];
      if (!head || !body || body.rows.length < 3) return;
      if ([...body.rows].some((r) => /\b(grp|sub|tot)\b/.test(r.className) || r.cells.length !== head.rows[0].cells.length)) return;
      table.dataset.zkSort = "1";
      [...head.rows[0].cells].forEach((th, col) => {
        if (!th.textContent.trim() || th.querySelector("button,input,select")) return;
        th.classList.add("zk-th");
        th.tabIndex = 0;
        const doSort = () => {
          const dir = th.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
          head.querySelectorAll("th[aria-sort]").forEach((x) => x.removeAttribute("aria-sort"));
          th.setAttribute("aria-sort", dir);
          const k = dir === "ascending" ? 1 : -1;
          const rows = [...body.rows].map((r) => [r, cellValue(r.cells[col])]);
          rows.sort((a, b) => {
            const x = a[1], y = b[1];
            if (x.n == null && y.n == null) return x.s.localeCompare(y.s) * k;
            if (x.n == null) return 1;
            if (y.n == null) return -1;
            return (x.n - y.n) * k;
          });
          rows.forEach(([r]) => body.appendChild(r));
        };
        th.addEventListener("click", doSort);
        th.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); doSort(); } });
      });
    });
  }

  // ══ Hooks into the core ═══════════════════════════════════════════════════
  const baseChrome = ZL.applyChrome;
  ZL.applyChrome = (...a) => {
    const r = baseChrome.apply(ZL, a);
    shell();
    railStatus();
    if (ZL.company) ZL.attention(true);
    return r;
  };
  const baseMount = ZL.mount;
  ZL.mount = async (route) => {
    await baseMount(route);
    const page = document.getElementById("page");
    if (page) {
      sortable(page);
      page.querySelectorAll("[data-wi]").forEach((b) => b.addEventListener("click", () => {
        const t = tasks(att)[+b.dataset.wi];
        if (t) ZL.open(t.route, t.params || {});
      }));
    }
    if (route !== "dashboard") ZL.attention();
  };
  // Dashboard: the worklist goes first, above the numbers.
  const dash = ZL.modules.dashboard;
  if (dash) {
    const baseRender = dash.render;
    dash.render = async function (ctx) {
      const [html, a] = await Promise.all([baseRender.call(this, ctx), ZL.isPersonal() ? null : ZL.attention(true)]);
      const work = a ? ZL.worklistHtml(a) : "";
      const at = html.indexOf('<div class="kpi-head');
      return work && at > -1 ? html.slice(0, at) + work + html.slice(at) : html + work;
    };
  }

  // Keyboard: ⌘K / Ctrl+K anywhere; "/" and "N" when not typing.
  document.addEventListener("keydown", (ev) => {
    if (!ZL.company) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName) || ev.target.isContentEditable;
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") { ev.preventDefault(); ZL.palette(); return; }
    if (typing || ev.metaKey || ev.ctrlKey || ev.altKey || document.querySelector(".zl-scrim,.zk-scrim")) return;
    if (ev.key === "/") { ev.preventDefault(); ZL.palette(); }
    else if (ev.key === "n" || ev.key === "N") { const b = document.getElementById("zk-newbtn"); if (b) { ev.preventDefault(); newMenu(b); } }
  });

  const css = document.createElement("style");
  css.textContent = `
  .zk-search{cursor:pointer;color:var(--ink-3);transition:border-color .12s,background .12s}
  .zk-search:hover{border-color:var(--brand);background:var(--card)}
  .zk-search span{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .zk-search svg{width:14px;height:14px;flex:none}
  .zk-newbtn{display:inline-flex;align-items:center;gap:5px;padding:5px 12px}
  .zk-newbtn svg{width:15px;height:15px}
  .zk-bell{position:relative}
  .zk-badge{position:absolute;top:-4px;right:-4px;min-width:16px;height:16px;padding:0 4px;border-radius:99px;background:var(--bad);color:#fff;font-size:10px;font-weight:700;line-height:16px;text-align:center;display:none}
  .zk-bell.has .zk-badge{display:block}
  .zk-scrim{position:fixed;inset:0;z-index:200;background:rgba(10,14,23,.45);display:flex;justify-content:center;align-items:flex-start;padding:10vh 16px 16px}
  .zk{width:min(640px,100%);background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 24px 64px rgba(0,0,0,.28);overflow:hidden;display:flex;flex-direction:column;max-height:72vh}
  .zk-in{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line);color:var(--ink-3)}
  .zk-in input{flex:1;border:0;outline:none;background:none;font:inherit;font-size:15px;color:var(--ink);min-width:0}
  .zk kbd,.zk-search kbd{font-family:"IBM Plex Mono",monospace;font-size:10.5px;border:1px solid var(--line);border-radius:4px;padding:0 4px;background:var(--sunk);color:var(--ink-3)}
  .zk-list{overflow-y:auto;padding:6px}
  .zk-g{padding:8px 10px 4px;font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
  .zk-i{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:8px 10px;border-radius:8px;color:var(--ink)}
  .zk-i svg{color:var(--ink-3);flex:none}
  .zk-i span{flex:1;min-width:0}
  .zk-i b{display:block;font-weight:500;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .zk-i small{display:block;color:var(--ink-3);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .zk-i em{font-style:normal;color:var(--ink-2);font-size:12.5px}
  .zk-i.on{background:var(--brand-soft)}
  .zk-i.on svg{color:var(--brand)}
  .zk-note{padding:14px 12px;color:var(--ink-3);font-size:13px}
  .zk-foot{display:flex;gap:14px;flex-wrap:wrap;padding:8px 14px;border-top:1px solid var(--line);font-size:11.5px;color:var(--ink-3)}
  .zk-menu{position:fixed;z-index:150;width:min(360px,calc(100vw - 16px));max-height:70vh;overflow-y:auto;background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:0 18px 48px rgba(0,0,0,.2);padding:6px}
  .zk-mg>span,.zk-mh{display:block;padding:8px 10px 4px;font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
  .zk-menu button{display:block;width:100%;text-align:left;padding:7px 10px;border-radius:7px}
  .zk-menu button:hover,.zk-menu button:focus-visible{background:var(--sunk);outline:none}
  .zk-menu b{display:block;font-weight:500;font-size:13px}
  .zk-menu small{display:block;color:var(--ink-3);font-size:12px}
  .zk-attn button{border-left:3px solid var(--line);border-radius:0 7px 7px 0;margin:2px 0}
  .zk-attn .tone-bad,.zk-w.tone-bad i{border-color:var(--bad)}
  .zk-attn .tone-warn,.zk-w.tone-warn i{border-color:var(--warn)}
  .zk-empty{padding:10px 12px;color:var(--ink-3);font-size:13px;margin:0}
  .zk-wl{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px;padding:10px 14px 14px}
  .zk-w{display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:8px;padding:9px 10px;background:var(--card)}
  .zk-w i{align-self:stretch;width:0;border-left:3px solid var(--brand);border-radius:2px}
  .zk-w.tone-none i{border-color:var(--ink-3)}
  .zk-w.zs-ar.tone-bad i,.zk-w.zs-ap.tone-bad i{border-color:var(--bad)}
  .zk-w div{flex:1;min-width:0}
  .zk-w b{display:block;font-size:13px;font-weight:600}
  .zk-w small{display:block;font-size:12px;color:var(--ink-3)}
  .zk-done{padding:12px 16px 16px;color:var(--good);font-weight:500;display:flex;gap:6px;align-items:center}
  .zk-plan{display:flex;align-items:center;gap:0;color:var(--rail-ink);font-size:11px;text-align:left;padding:0}
  .zk-plan:hover{color:#fff}
  .zk-plan.warn .dot{background:var(--warn)}.zk-plan.bad .dot{background:var(--bad)}
  th.zk-th{cursor:pointer;user-select:none;white-space:nowrap}
  th.zk-th:hover{color:var(--ink)}
  th.zk-th::after{content:"↕";opacity:.25;margin-left:4px;font-size:10px}
  th.zk-th[aria-sort="ascending"]::after{content:"↑";opacity:.8}
  th.zk-th[aria-sort="descending"]::after{content:"↓";opacity:.8}
  @media (max-width:760px){.zk-search span,.zk-search kbd{display:none}.zk-search{flex:0 0 auto;min-width:0;max-width:none}.zk-newbtn span{display:none}.zk-foot{display:none}}
  `;
  document.head.appendChild(css);
})();
