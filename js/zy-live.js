/* ═══════════════════════════════════════════════════════════════════════════
 * Zycount live workspace — core.
 *
 * When a real user signs in (session.mode === "live"), app.html hands control to
 * ZL.boot(). The core connects to Supabase, loads the user's books (business or
 * personal), and replaces the demo pages with modules that read and write them.
 *
 * Module files (zy-live-*.js) register pages with ZL.register(route, module):
 *
 *   ZL.register("journals", {
 *     perm: "journal.view",                   // hidden without it
 *     title: "Journals",                      // used for the no-access card
 *     nav: "journals",                        // rail item to highlight (detail pages)
 *     detail: true,                           // needs params; not a landing page
 *     async render(ctx) { return "<html>"; }, // ctx = { company, params, can, today }
 *     after(root, ctx) { ...wire events... }, // optional, runs after insert
 *   });
 *
 * app.html's page functions stay synchronous: a live page returns a loading
 * placeholder, then ZL.mount() renders the module asynchronously.
 * Relies on globals from app.html: PAGES, VALID, NAV, ICONS, state, go,
 * renderNav, wire, crumbs, head, densityControl, compact, TICK.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const SUPABASE_URL = "https://qkrikvmkoelusyjjqdkd.supabase.co";
  // Publishable key: safe in the browser. Every table is protected by RLS and
  // every write goes through a permission-checked database function.
  const SUPABASE_KEY = "sb_publishable_BoPf8kDj05jPr9__E2hcHQ_p0RH1Hm8";
  const SESSION_KEY = "zycount.session";
  const COMPANY_KEY = "zl.company";
  const PARAMS_KEY = "zl.params";

  class ZLError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  /** Splits "CODE: message" raised by the database into its parts. */
  function toZLError(err) {
    if (err instanceof ZLError) return err;
    const raw = String((err && (err.message || err.error_description || err.error)) || err || "Something went wrong.");
    const m = raw.match(/^([A-Z][A-Z_]+):\s*([\s\S]*)$/);
    if (m) return new ZLError(m[1], m[2]);
    if (/Failed to fetch|NetworkError|network|Load failed/i.test(raw)) {
      return new ZLError("NETWORK", "Can't reach the server. Check your connection — nothing was saved.");
    }
    if (/JWT|refresh token|not authenticated/i.test(raw)) return new ZLError("AUTH_REQUIRED", "Your session has expired. Sign in again.");
    return new ZLError("INTERNAL", raw);
  }

  const ZL = {
    SUPABASE_URL,
    SUPABASE_KEY,
    ZLError,
    sb: null,
    user: null, // { id, email, name }
    companies: [], // rows from my_companies()
    company: null, // current books
    modules: {},
    params: {},
    _mountSeq: 0,
  };
  window.ZL = ZL;

  // ── formatting ─────────────────────────────────────────────────────────
  ZL.esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  ZL.num = (v) => (v == null || v === "" ? 0 : Number(v));
  /** 1234.5 → "1,234.50"; negatives in brackets like a statement. */
  ZL.money = (v, opts = {}) => {
    const n = ZL.num(v);
    const s = Math.abs(n).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const body = (opts.symbol ? "RM " : "") + s;
    return n < 0 ? (opts.minus ? "−" + body : "(" + body + ")") : body;
  };
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  ZL.MONTHS = MONTHS;
  ZL.date = (iso) => {
    if (!iso) return "—";
    const [y, m, d] = String(iso).slice(0, 10).split("-");
    return `${+d} ${MONTHS[+m - 1]} ${y}`;
  };
  ZL.dateTime = (iso) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  ZL.today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  ZL.yearStart = (iso) => `${String(iso || ZL.today()).slice(0, 4)}-01-01`;
  ZL.monthStart = (iso) => `${String(iso || ZL.today()).slice(0, 7)}-01`;
  ZL.monthEnd = (iso) => {
    const [y, m] = String(iso || ZL.today()).slice(0, 7).split("-").map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  };
  ZL.addDays = (iso, n) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  ZL.can = (perm) => !!(ZL.company && ZL.company.permissions && ZL.company.permissions.includes(perm));
  ZL.isPersonal = () => !!(ZL.company && ZL.company.kind === "PERSONAL");
  /** Business wording or personal wording for the current books. */
  ZL.T = (business, personal) => (ZL.isPersonal() ? personal : business);

  // Money is summed in whole sen so totals never drift by a floating-point cent.
  ZL.cents = (v) => Math.round(ZL.num(v) * 100);
  ZL.sum = (rows, f = (x) => x) => rows.reduce((s, r) => s + ZL.cents(f(r)), 0) / 100;
  /** Signed balance (debit − credit) as "1,234.00 Dr" / "1,234.00 Cr". */
  ZL.drcr = (v) => {
    const c = ZL.cents(v);
    if (c === 0) return "—";
    return ZL.money(Math.abs(c) / 100) + (c > 0 ? " Dr" : " Cr");
  };
  /** Parses "1,234.50" typed by a person; NaN when it isn't a number. */
  ZL.parseAmount = (s) => {
    const t = String(s == null ? "" : s).replace(/[,\s]/g, "").replace(/^RM/i, "");
    if (t === "") return 0;
    return /^\d*\.?\d*$/.test(t) && t !== "." ? Math.round(Number(t) * 100) / 100 : NaN;
  };
  ZL.debounce = (fn, ms = 350) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  /** Date filters change nothing until Apply (or Enter); the button lights up once a date is edited. */
  ZL.applyButton = (id) => `<button type="button" class="zl-btn sm zl-apply" id="${id}">Apply</button>`;
  ZL.wireApply = (root, inputIds, buttonId, apply) => {
    const inputs = inputIds.map((i) => root.querySelector("#" + i)).filter(Boolean);
    const b = root.querySelector("#" + buttonId);
    if (!b) return;
    const start = inputs.map((i) => i.value);
    const sync = () => b.classList.toggle("primary", inputs.some((i, k) => i.value !== start[k]));
    inputs.forEach((i) => {
      i.addEventListener("input", sync);
      i.addEventListener("change", sync);
      i.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); apply(); } });
    });
    b.addEventListener("click", apply);
  };

  // ── data access ────────────────────────────────────────────────────────
  /** Calls a database function; throws ZLError { code, message } on failure. */
  ZL.rpc = async (name, args = {}) => {
    try {
      const { data, error } = await ZL.sb.rpc(name, args);
      if (error) throw error;
      return data;
    } catch (e) {
      const z = toZLError(e);
      if (z.code === "AUTH_REQUIRED") ZL.expireSession();
      throw z;
    }
  };

  /** Reads a table (RLS applies). build receives the query builder. */
  ZL.select = async (table, columns = "*", build = (q) => q) => {
    try {
      const { data, error } = await build(ZL.sb.from(table).select(columns));
      if (error) throw error;
      return data || [];
    } catch (e) {
      throw toZLError(e);
    }
  };

  /** A page of rows plus the total count matching the filter. */
  ZL.page = async (table, columns, build, from = 0, size = 100) => {
    try {
      const { data, error, count } = await build(ZL.sb.from(table).select(columns, { count: "exact" })).range(from, from + size - 1);
      if (error) throw error;
      return { rows: data || [], count: count || 0 };
    } catch (e) {
      throw toZLError(e);
    }
  };

  /** Number of rows matching a filter, without fetching them. */
  ZL.count = async (table, build) => {
    try {
      const { error, count } = await build(ZL.sb.from(table).select("id", { count: "exact", head: true }));
      if (error) throw error;
      return count || 0;
    } catch (e) {
      throw toZLError(e);
    }
  };

  /** Display names for user ids (co-members' profiles are readable). */
  ZL.people = async (ids) => {
    const want = [...new Set(ids.filter(Boolean))];
    if (!want.length) return {};
    const rows = await ZL.select("profiles", "id,full_name,email", (q) => q.in("id", want));
    const out = {};
    rows.forEach((p) => { out[p.id] = p.full_name || p.email; });
    return out;
  };

  ZL._accounts = null;
  /** The chart of accounts, cached per company until invalidated. */
  ZL.accounts = async (force = false) => {
    if (!ZL._accounts || force) {
      ZL._accounts = await ZL.select("accounts", "id,code,name,type,sub_type,parent_id,is_postable,is_active,is_system,is_cash,is_control,description",
        (q) => q.eq("company_id", ZL.company.company_id).order("code"));
    }
    return ZL._accounts;
  };

  ZL._info = null;
  /** The current company's full record (letterheads, settings). */
  ZL.companyInfo = async (force = false) => {
    if (!ZL._info || force || ZL._info.id !== ZL.company.company_id) {
      const rows = await ZL.select("companies", "*", (q) => q.eq("id", ZL.company.company_id));
      ZL._info = rows[0] || { id: ZL.company.company_id, name: ZL.company.name };
    }
    return ZL._info;
  };
  ZL.invalidate = () => { ZL._accounts = null; ZL._info = null; };

  ZL.errorText = (e) => toZLError(e).message || "Something went wrong.";

  // ── UI primitives ──────────────────────────────────────────────────────
  ZL.toast = (message, tone = "ok") => {
    let box = document.getElementById("zl-toasts");
    if (!box) {
      box = document.createElement("div");
      box.id = "zl-toasts";
      box.setAttribute("role", "status");
      box.setAttribute("aria-live", "polite");
      document.body.appendChild(box);
    }
    const t = document.createElement("div");
    t.className = "zl-toast " + tone;
    t.textContent = message;
    box.appendChild(t);
    setTimeout(() => t.classList.add("out"), 4200);
    setTimeout(() => t.remove(), 4700);
  };

  /** Error box for inside forms and dialogs. */
  const ERROR_TITLE = {
    INTERNAL: "Something went wrong", NETWORK: "No connection", AUTH_REQUIRED: "Signed out", PERMISSION_DENIED: "Not allowed",
    PERIOD_CLOSED: "Period closed", PERIOD_NOT_FOUND: "No period", JOURNAL_UNBALANCED: "Not balanced", CONFLICT: "Changed by someone else",
    IMMUTABLE: "Can't be changed", DUPLICATE: "Already exists", LAST_ADMIN: "Needs an administrator",
    CONTROL_ACCOUNT: "Control account", CREDIT_LIMIT: "Over the credit limit", LINKED_DOCUMENT: "Posted by a document", IN_USE: "In use",
    LIMIT: "Limit reached", BUSY: "Busy", UNREADABLE: "Couldn't read it", AI_NOT_CONFIGURED: "Reading is off",
  };
  /** Error box for inside forms and dialogs. Plain validation messages need no title. */
  ZL.errorBox = (e) => {
    const z = toZLError(e);
    const title = z.code === "VALIDATION" ? "" : ERROR_TITLE[z.code] || "";
    return `<div class="zl-err" role="alert">${title ? `<b>${ZL.esc(title)}.</b> ` : ""}${ZL.esc(z.message)}</div>`;
  };

  /**
   * Dialog. actions: [{ label, primary?, danger?, onClick: async ({ close, root, setError, setBusy }) => {} }]
   * Returns { root, close, setError }.
   */
  ZL.modal = ({ title, body, actions = [], wide = false, onClose }) => {
    const wrap = document.createElement("div");
    wrap.className = "zl-scrim";
    wrap.innerHTML = `
      <div class="zl-modal${wide ? " wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="zl-modal-title">
        <header><h3 id="zl-modal-title">${ZL.esc(title)}</h3>
          <button type="button" class="iconbtn" data-zl-close aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button></header>
        <div class="zl-modal-body">${body}<div class="zl-modal-error"></div></div>
        <footer>${actions.map((a, i) => `<button type="button" class="zl-btn${a.primary ? " primary" : ""}${a.danger ? " danger" : ""}${!a.primary && !a.danger ? " ghost" : ""}" data-zl-action="${i}">${ZL.esc(a.label)}</button>`).join("")}</footer>
      </div>`;
    document.body.appendChild(wrap);
    const prevFocus = document.activeElement;
    const close = () => {
      wrap.remove();
      document.removeEventListener("keydown", onKey);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      if (onClose) onClose();
    };
    const onKey = (ev) => { if (ev.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("mousedown", (ev) => { if (ev.target === wrap) close(); });
    wrap.querySelector("[data-zl-close]").addEventListener("click", close);
    const errSlot = wrap.querySelector(".zl-modal-error");
    const setError = (e) => { errSlot.innerHTML = e ? ZL.errorBox(e) : ""; };
    const buttons = [...wrap.querySelectorAll("[data-zl-action]")];
    const setBusy = (busy) => buttons.forEach((b) => { b.disabled = busy; });
    buttons.forEach((b) => b.addEventListener("click", async () => {
      const a = actions[Number(b.dataset.zlAction)];
      if (!a.onClick) return close();
      setError(null);
      setBusy(true);
      try {
        await a.onClick({ close, root: wrap, setError, setBusy });
      } catch (e) {
        setError(e);
      } finally {
        if (document.body.contains(wrap)) setBusy(false);
      }
    }));
    // Enter submits the primary action from single-line inputs.
    wrap.querySelectorAll("input").forEach((inp) => inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        const p = buttons.find((b) => actions[Number(b.dataset.zlAction)].primary || actions[Number(b.dataset.zlAction)].danger);
        if (p) p.click();
      }
    }));
    const first = wrap.querySelector("input:not([type=checkbox]):not([type=hidden]),select,textarea") || buttons[buttons.length - 1];
    if (first) setTimeout(() => first.focus(), 0);
    return { root: wrap, close, setError };
  };

  ZL.confirm = ({ title, message, confirmLabel = "Confirm", danger = false }) => new Promise((resolve) => {
    let done = false;
    ZL.modal({
      title,
      body: `<p class="zl-p">${message}</p>`,
      onClose: () => { if (!done) resolve(false); },
      actions: [
        { label: "Cancel" },
        { label: confirmLabel, primary: !danger, danger, onClick: ({ close }) => { done = true; resolve(true); close(); } },
      ],
    });
  });

  /**
   * Form dialog. fields: [{ name, label, type?: "text"|"date"|"number"|"select"|"textarea"|"checkbox"|"amount",
   *   value?, required?, placeholder?, options?: [{value,label,group?}], hint? }]
   * submit(values) may throw to keep the dialog open with an error.
   * Resolves with submit's result (or the values), or null when cancelled.
   */
  ZL.form = ({ title, intro = "", fields, confirmLabel = "Save", danger = false, wide = false, submit, onOpen }) => new Promise((resolve) => {
    let done = false;
    const body = (intro ? `<p class="zl-p" style="margin-bottom:16px">${intro}</p>` : "") + `<div class="zl-form">${fields.map((f) => ZL.fieldHtml(f)).join("")}</div>`;
    const m = ZL.modal({
      title, body, wide,
      onClose: () => { if (!done) resolve(null); },
      actions: [
        { label: "Cancel" },
        {
          label: confirmLabel, primary: !danger, danger,
          onClick: async ({ close, root }) => {
            const values = ZL.readForm(root, fields);
            for (const f of fields) { // first problem, in the order the fields appear
              if (f.type === "amount" && Number.isNaN(values[f.name])) throw new ZLError("VALIDATION", `${f.label}: enter a number like 1,250.00.`);
              if (f.required && (values[f.name] === "" || values[f.name] == null)) throw new ZLError("VALIDATION", `${f.label} is required.`);
            }
            const result = submit ? await submit(values) : values;
            done = true;
            resolve(result === undefined || result === null ? values : result);
            close();
          },
        },
      ],
    });
    // Amounts are tidied as the person leaves the field.
    m.root.querySelectorAll("[data-amount]").forEach((inp) => inp.addEventListener("blur", () => {
      const v = ZL.parseAmount(inp.value);
      if (!Number.isNaN(v) && v) inp.value = ZL.money(v);
    }));
    if (onOpen) onOpen(m.root);
  });

  ZL.fieldHtml = (f) => {
    const id = "zlf-" + f.name;
    const v = f.value == null ? "" : f.value;
    let control;
    if (f.type === "select") {
      const groups = [];
      (f.options || []).forEach((o) => {
        const g = o.group || "";
        let last = groups[groups.length - 1];
        if (!last || last.g !== g) { last = { g, items: [] }; groups.push(last); }
        last.items.push(o);
      });
      const opt = (o) => `<option value="${ZL.esc(o.value)}"${String(o.value) === String(v) ? " selected" : ""}>${ZL.esc(o.label)}</option>`;
      control = `<select id="${id}" name="${f.name}" class="zl-input">${groups.map((g) =>
        g.g ? `<optgroup label="${ZL.esc(g.g)}">${g.items.map(opt).join("")}</optgroup>` : g.items.map(opt).join("")).join("")}</select>`;
    } else if (f.type === "textarea") {
      control = `<textarea id="${id}" name="${f.name}" class="zl-input" rows="3" placeholder="${ZL.esc(f.placeholder || "")}">${ZL.esc(v)}</textarea>`;
    } else if (f.type === "checkbox") {
      return `<label class="zl-check"><input type="checkbox" id="${id}" name="${f.name}"${v ? " checked" : ""}><span>${ZL.esc(f.label)}${f.hint ? `<small>${ZL.esc(f.hint)}</small>` : ""}</span></label>`;
    } else if (f.type === "amount") {
      control = `<div class="zl-amount"><span>RM</span><input id="${id}" name="${f.name}" class="zl-input num" data-amount inputmode="decimal" value="${ZL.esc(v)}" placeholder="0.00" autocomplete="off"></div>`;
    } else {
      control = `<input id="${id}" name="${f.name}" class="zl-input" type="${f.type || "text"}" value="${ZL.esc(v)}" placeholder="${ZL.esc(f.placeholder || "")}"${f.type === "number" ? ' step="any"' : ""} autocomplete="off">`;
    }
    return `<label class="zl-field${f.half ? " half" : ""}" for="${id}"><span>${ZL.esc(f.label)}${f.required ? ' <i aria-hidden="true">*</i>' : ""}</span>${control}${f.hint ? `<small>${ZL.esc(f.hint)}</small>` : ""}</label>`;
  };

  ZL.readForm = (root, fields) => {
    const out = {};
    fields.forEach((f) => {
      const el = root.querySelector(`[name="${f.name}"]`);
      if (!el) return;
      if (f.type === "checkbox") out[f.name] = el.checked;
      else if (f.type === "amount") out[f.name] = el.value.trim() === "" ? "" : ZL.parseAmount(el.value);
      else out[f.name] = el.value.trim();
    });
    return out;
  };

  /** Downloads rows (array of arrays) as CSV. */
  ZL.csv = (filename, rows) => {
    const cell = (c) => {
      let s = c == null ? "" : String(c);
      // A text cell starting with = + - @ would run as a formula in Excel; numbers stay numbers.
      if (typeof c !== "number" && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const blob = new Blob(["﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  };

  ZL.noAccess = (title, perm) =>
    `<div class="phead"><div><h1>${ZL.esc(title)}</h1></div></div>
    <section class="card zl-empty"><h3>No access</h3><p>Your role (${ZL.esc(ZL.company ? ZL.company.role : "")}) doesn't include <b>${ZL.esc(perm)}</b> in these books. Ask an administrator to change your role.</p></section>`;

  ZL.empty = (title, text, actionHtml = "") =>
    `<section class="card zl-empty"><h3>${ZL.esc(title)}</h3><p>${text}</p>${actionHtml}</section>`;

  /** Page header: title, one-line subtitle, optional right-hand actions. */
  ZL.header = (title, sub, actions = "") => `
    <div class="phead"><div><h1>${ZL.esc(title)}</h1>${sub ? `<p class="sub">${ZL.esc(sub)}</p>` : ""}</div>
      ${actions ? `<div class="zl-actions">${actions}</div>` : ""}</div>`;

  // ── routing ────────────────────────────────────────────────────────────
  ZL.register = (route, mod) => { ZL.modules[route] = mod; };

  /** Navigate to a route with parameters (kept across reloads in this tab). */
  ZL.open = (route, params = {}) => {
    ZL.params = params;
    ZL.paramsRoute = route;
    try { sessionStorage.setItem(PARAMS_KEY, JSON.stringify({ route, params })); } catch (_) { /* ignore */ }
    if (state.route === route) ZL.mount(route);
    else go(route);
  };

  const LOADING = `<div class="zl-loading" aria-busy="true"><span class="zl-spin"></span>Loading…</div>`;
  ZL.placeholder = (route) => {
    queueMicrotask(() => ZL.mount(route));
    return LOADING;
  };

  ZL.mount = async (route) => {
    const mod = ZL.modules[route];
    const page = document.getElementById("page");
    if (!mod || !page) return;
    const seq = ++ZL._mountSeq;
    if (!page.querySelector(".zl-loading")) page.innerHTML = LOADING;
    // Filters belong to the page that set them; arriving from the menu starts clean.
    if (ZL.paramsRoute !== route) { ZL.params = {}; ZL.paramsRoute = route; }
    const ctx = { company: ZL.company, params: ZL.params, can: ZL.can, today: ZL.today() };
    const allowed = !mod.perm || ZL.can(mod.perm);
    let html;
    try {
      html = allowed ? await mod.render(ctx) : ZL.noAccess(mod.title || route, mod.perm);
    } catch (e) {
      html = ZL.header(mod.title || route, "") + `<section class="card" style="padding:18px 22px">${ZL.errorBox(e)}
        <p class="zl-p" style="margin-top:12px"><button type="button" class="zl-btn" id="zl-retry">Try again</button></p></section>`;
    }
    if (seq !== ZL._mountSeq || state.route !== route) return; // navigated away meanwhile
    page.innerHTML = html;
    const navId = mod.nav || route;
    document.querySelectorAll("[data-route]").forEach((b) => {
      if (b.dataset.route === navId) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    wire(); // table filters shared with the demo pages
    const retry = document.getElementById("zl-retry");
    if (retry) retry.addEventListener("click", () => ZL.mount(route));
    if (mod.after && allowed) {
      try { mod.after(page, ctx); } catch (e) { console.error(e); ZL.toast(ZL.errorText(e), "bad"); }
    }
  };

  ZL.refresh = () => ZL.mount(state.route);

  // ── session ────────────────────────────────────────────────────────────
  ZL.expireSession = () => {
    try { localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); } catch (_) { /* ignore */ }
    location.replace("login.html?expired=1");
  };

  ZL.signOut = async () => {
    try {
      if (ZL.company) await ZL.sb.rpc("log_event", { p_company: ZL.company.company_id, p_action: "auth.logout" });
    } catch (_) { /* best effort */ }
    try { await ZL.sb.auth.signOut(); } catch (_) { /* ignore */ }
    try {
      localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(PARAMS_KEY); sessionStorage.removeItem("zl.loggedin");
    } catch (_) { /* ignore */ }
    location.replace("login.html?signedout=1");
  };

  /**
   * "Keep me signed in" decides where the auth session lives: localStorage
   * survives the browser closing, sessionStorage ends with the tab.
   * login.html and app.html agree by checking where zycount.session is.
   */
  ZL.authStorage = () => {
    try {
      if (!localStorage.getItem(SESSION_KEY) && sessionStorage.getItem(SESSION_KEY)) return window.sessionStorage;
    } catch (_) { /* ignore */ }
    return window.localStorage;
  };

  ZL.client = (storage) => {
    if (!ZL.sb) {
      ZL.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storage: storage || ZL.authStorage() },
      });
    }
    return ZL.sb;
  };

  // ── navigation, per kind of books ──────────────────────────────────────
  const EXTRA_ICONS = {};
  EXTRA_ICONS.swap = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden><path d="M7 7h13l-4-4M17 17H4l4 4"/></svg>`;
  EXTRA_ICONS.gear = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`;

  EXTRA_ICONS.bank = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden><path d="M3 10h18M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18M12 3l9 5H3z"/></svg>`;
  EXTRA_ICONS.doc = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>`;
  EXTRA_ICONS.key = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/></svg>`;

  EXTRA_ICONS.camera = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/></svg>`;
  EXTRA_ICONS.hash = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/></svg>`;

  /** Replaces the demo navigation with the live one for these books. */
  ZL.buildNav = () => {
    Object.assign(ICONS, EXTRA_ICONS); // app.html's icon set is defined after this file loads
    const P = ZL.isPersonal();
    const groups = [
      { label: "", items: [["dashboard", "Dashboard", "dash"], ["capture", "Inbox", "camera"], ["transactions", P ? "Money in & out" : "Transactions", "swap"]] },
      { label: "Sales", items: [["sales", "Sales documents", "invoice"], ["customers", "Customers", "users"], ["araging", "Receivables aging", "clock"], ["items", "Items & services", "box"]] },
      { label: "Purchases", items: [["purchases", "Purchase documents", "truck"], ["suppliers", "Suppliers", "building"], ["apaging", "Payables aging", "clock"]] },
      { label: "Reports", items: [["pl", P ? "Income & spending" : "Profit & loss", "chart"], ["bs", P ? "Net worth" : "Balance sheet", "sheet"], ["tb", "Trial balance", "scale"]] },
      { label: "Accounting", items: [["coa", P ? "Accounts & categories" : "Chart of accounts", "book"], ["journals", "Journals", "list"], ["gl", "General ledger", "ledger"], ["cashbook", "Cash book", "wallet"], ["bankrec", P ? "Match bank statement" : "Bank reconciliation", "bank"], ["periods", "Fiscal periods", "calendar"]] },
      { label: P ? "Settings" : "Company", items: [["users", P ? "Sharing" : "Users & roles", "users"], ["audit", "Audit trail", "shield"], ["templates", P ? "Receipt template" : "Voucher template", "doc"], ["numbering", "Numbering", "hash"], ["taxcodes", "Tax codes (SST)", "scale"], ["settings", "Settings", "gear"]] },
      { label: "Zycount", items: [["admin", "Admin console", "key"]] },
    ];
    NAV.length = 0;
    groups.forEach((g) => {
      const items = g.items.filter(([id]) => { const m = ZL.modules[id]; return m && !(m.business && P) && (m.platform ? ZL.platformAdmin : !m.perm || ZL.can(m.perm)); });
      if (items.length) NAV.push({ label: g.label, items });
    });
  };

  const opened = new Set();
  ZL.noteAdminOpen = (c) => {
    if (!c || !c.admin_access || opened.has(c.company_id)) return;
    opened.add(c.company_id);
    ZL.rpc("log_event", { p_company: c.company_id, p_action: "admin.open" }).catch(() => {});
  };

  ZL.switchCompany = (companyId) => {
    const c = ZL.companies.find((x) => x.company_id === companyId);
    if (!c) return;
    ZL.company = c;
    ZL.noteAdminOpen(c);
    ZL.invalidate();
    try { localStorage.setItem(COMPANY_KEY, companyId); sessionStorage.removeItem(PARAMS_KEY); } catch (_) { /* ignore */ }
    ZL.params = {};
    ZL.paramsRoute = null;
    ZL.applyChrome();
    ZL.buildNav();
    renderNav();
    const keep = ZL.modules[state.route] && !ZL.modules[state.route].detail && ZL.can(ZL.modules[state.route].perm || "company.view");
    go(keep ? state.route : "dashboard");
    ZL.toast(`Switched to ${c.name}.`);
  };

  ZL.createCompany = async (kind) => {
    const first = !ZL.company;
    const fields = [
      { name: "kind", label: "Type of books", type: "select", value: kind || "BUSINESS",
        options: [{ value: "BUSINESS", label: "Business — a company or sole proprietorship" }, { value: "PERSONAL", label: "Personal — my own money" }] },
      { name: "name", label: "Name", required: true, placeholder: "e.g. Syarikat Contoh Sdn Bhd, or Aisyah — Personal" },
      { name: "reg", label: "Registration no. (business)", placeholder: "Optional" },
      { name: "tax", label: "SST registration no. (business)", placeholder: "Optional" },
    ];
    const id = await ZL.form({
      title: "New set of books",
      intro: "Business books come with the Malaysian SME chart of accounts and SST accounts; personal books with everyday categories. Both get twelve monthly periods for this year.",
      confirmLabel: "Create",
      fields,
      submit: (v) => ZL.rpc("create_company", {
        p_name: v.name, p_registration_no: v.kind === "BUSINESS" ? v.reg || null : null,
        p_tax_no: v.kind === "BUSINESS" ? v.tax || null : null, p_kind: v.kind,
      }),
    });
    if (!id || typeof id !== "string") return;
    if (first) { // first books: start the workspace from scratch
      try { localStorage.setItem(COMPANY_KEY, id); } catch (_) { /* ignore */ }
      location.reload();
      return;
    }
    ZL.companies = await ZL.rpc("my_companies");
    ZL.switchCompany(id);
  };

  /** Updates the rail, topbar and user menu for the current user and books. */
  ZL.applyChrome = () => {
    const c = ZL.company;
    const name = (ZL.user && ZL.user.name) || "User";
    const initials = (s) => s.split(/\s+/).filter((p) => /\w/.test(p)).slice(0, 2).map((p) => p[0].toUpperCase()).join("");

    const railTitle = document.querySelector(".rail-top small");
    if (railTitle) railTitle.textContent = c ? (c.kind === "PERSONAL" ? "Personal books" : "Business books") : "";
    const railFoot = document.querySelector(".rail-foot");
    if (railFoot) railFoot.textContent = c && c.kind === "PERSONAL"
      ? "Budgets and bank import come next."
      : "Invoices, bills, bank feeds and payroll come next.";

    const co = document.querySelector(".topbar .co");
    if (co && c) {
      co.classList.add("zl-co");
      co.setAttribute("role", "button");
      co.setAttribute("tabindex", "0");
      co.setAttribute("aria-haspopup", "menu");
      co.setAttribute("title", "Switch books");
      co.innerHTML = `<span class="avatar">${ZL.esc(initials(c.name) || "Z")}</span><span class="zl-co-name">${ZL.esc(c.name)}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden><path d="m6 9 6 6 6-6"/></svg>`;
      if (!co.dataset.zlWired) {
        co.dataset.zlWired = "1";
        const openMenu = (ev) => { ev.stopPropagation(); ZL.companyMenu(co); };
        co.addEventListener("click", openMenu);
        co.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openMenu(ev); } });
      }
    }
    const fy = document.querySelector(".topbar > .field .hint");
    if (fy) {
      const d = new Date();
      fy.textContent = d.toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    }

    const btn = document.getElementById("me-btn");
    if (btn) { btn.textContent = initials(name) || "U"; btn.title = name; }
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    set("me-name", name);
    set("me-email", (ZL.user && ZL.user.email) || "");
    set("me-role", c ? c.role : "");
    set("me-co", c ? c.name : "No books yet");
    const menu = document.getElementById("me-menu");
    if (menu && c && !document.getElementById("me-settings")) {
      const item = document.createElement("button");
      item.type = "button";
      item.id = "me-settings";
      item.setAttribute("role", "menuitem");
      item.textContent = "Profile & password";
      item.addEventListener("click", () => { menu.hidden = true; go("settings"); });
      menu.insertBefore(item, menu.querySelector('a[href="index.html"]'));
    }

    window.ZY_USER = Object.assign({}, window.ZY_USER || {}, {
      name, email: ZL.user && ZL.user.email, role: c ? c.role : "", company: c ? c.name : "", mode: "live",
    });
  };

  ZL.companyMenu = (anchor) => {
    const existing = document.getElementById("zl-co-menu");
    if (existing) { existing.remove(); return; }
    const menu = document.createElement("div");
    menu.id = "zl-co-menu";
    menu.className = "zl-menu";
    menu.setAttribute("role", "menu");
    const item = (c) => `<button type="button" role="menuitemradio" aria-checked="${ZL.company && c.company_id === ZL.company.company_id}" data-co="${c.company_id}" data-co-name="${ZL.esc(c.name.toLowerCase())}">
        <span><b>${ZL.esc(c.name)}</b><small>${c.kind === "PERSONAL" ? "Personal" : "Business"} · ${c.admin_access ? "Client — admin access" : ZL.esc(c.role)}</small></span>
        ${ZL.company && c.company_id === ZL.company.company_id ? TICK : ""}</button>`;
    const own = ZL.companies.filter((c) => !c.admin_access), clients = ZL.companies.filter((c) => c.admin_access);
    menu.innerHTML = `<div class="zl-menu-h">Your books</div>` + own.map(item).join("") +
      (clients.length ? `<div class="zl-menu-h">Client books (${clients.length})</div>` +
        (clients.length > 6 ? `<div style="padding:4px 10px 6px"><input class="zl-input" id="zl-co-find" placeholder="Find a client" style="padding:6px 8px;font-size:13px"></div>` : "") +
        `<div class="zl-menu-scroll">${clients.map(item).join("")}</div>` : "") +
      `<button type="button" role="menuitem" data-co-new class="zl-menu-new">+ New set of books</button>`;
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6 + window.scrollY}px`;
    menu.style.left = `${Math.max(8, r.left + window.scrollX)}px`;
    document.body.appendChild(menu);
    const close = () => { menu.remove(); document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); };
    const onDoc = (ev) => { if (!menu.contains(ev.target)) close(); };
    const onKey = (ev) => { if (ev.key === "Escape") close(); };
    setTimeout(() => { document.addEventListener("click", onDoc); document.addEventListener("keydown", onKey); }, 0);
    const find = menu.querySelector("#zl-co-find");
    if (find) {
      find.addEventListener("input", () => {
        const q = find.value.trim().toLowerCase();
        menu.querySelectorAll(".zl-menu-scroll [data-co]").forEach((b) => { b.hidden = !!q && !b.dataset.coName.includes(q); });
      });
      setTimeout(() => find.focus(), 0);
    }
    menu.querySelectorAll("[data-co]").forEach((b) => b.addEventListener("click", () => {
      close();
      if (!ZL.company || b.dataset.co !== ZL.company.company_id) ZL.switchCompany(b.dataset.co);
    }));
    menu.querySelector("[data-co-new]").addEventListener("click", () => { close(); ZL.createCompany(); });
    const first = menu.querySelector("button");
    if (first) first.focus();
  };

  /** First-run screen for a user with no books yet. */
  ZL.onboarding = () => {
    document.getElementById("nav").innerHTML = "";
    document.getElementById("page").innerHTML = `
      <div class="phead"><div><h1>Welcome to Zycount</h1><p class="sub">Choose what you want to keep books for.</p></div></div>
      <div class="zl-choice">
        <button type="button" class="card zl-choice-card" data-kind="BUSINESS">
          <b>Business</b><span>A company or sole proprietorship. Malaysian chart of accounts, SST, profit and loss, balance sheet.</span></button>
        <button type="button" class="card zl-choice-card" data-kind="PERSONAL">
          <b>Personal</b><span>Your own money. Accounts, spending categories, income and spending, net worth.</span></button>
      </div>`;
    document.querySelectorAll("[data-kind]").forEach((b) => b.addEventListener("click", () => ZL.createCompany(b.dataset.kind)));
  };

  // ── styles: live components and the workspace theme ─────────────────────
  const CSS = `
  /* tokens — calmer greys, one accent */
  html.zl-live{
    --paper:#F6F7F9; --card:#FFFFFF; --sunk:#F2F4F7; --line:#E4E7EC; --line-2:#EEF0F3;
    --ink:#101828; --ink-2:#475467; --ink-3:#667085;
    --brand:#3A3FD0; --brand-soft:#EEF0FF;
    --good:#067647; --good-soft:#E9F8EF; --warn:#B54708; --warn-soft:#FFF6E6; --bad:#B42318; --bad-soft:#FEF0EE;
    --c1:#3A3FD0; --c2:#F79009; --c4:#12B76A; --c5:#0BA5EC;
    --r:12px;
  }
  @media (prefers-color-scheme:dark){
    html.zl-live:not([data-theme]){
      --paper:#0B0F17; --card:#121824; --sunk:#182030; --line:#253044; --line-2:#1C2434;
      --ink:#EEF2F8; --ink-2:#B4BFCE; --ink-3:#8793A6;
      --brand:#8C91F4; --brand-soft:#1D2146;
      --good:#4ACB8E; --good-soft:#0F2A1F; --warn:#EDAA4E; --warn-soft:#2C2214; --bad:#F27D8E; --bad-soft:#2F151A;
      --c1:#8C91F4; --c2:#F5A742; --c4:#4ACB8E; --c5:#46B8F0;
    }
  }
  html.zl-live[data-theme="dark"]{
    --paper:#0B0F17; --card:#121824; --sunk:#182030; --line:#253044; --line-2:#1C2434;
    --ink:#EEF2F8; --ink-2:#B4BFCE; --ink-3:#8793A6;
    --brand:#8C91F4; --brand-soft:#1D2146;
    --good:#4ACB8E; --good-soft:#0F2A1F; --warn:#EDAA4E; --warn-soft:#2C2214; --bad:#F27D8E; --bad-soft:#2F151A;
    --c1:#8C91F4; --c2:#F5A742; --c4:#4ACB8E; --c5:#46B8F0;
  }
  html.zl-live[data-theme="dim"]{
    --paper:#1C2230; --card:#262D3D; --sunk:#2C3445; --line:#3A4357; --line-2:#313A4C;
    --ink:#E4E8F0; --ink-2:#B9C1CF; --ink-3:#939DB0;
    --brand:#6D72E6; --brand-soft:#33375A;
    --good:#5CC497; --good-soft:#233D33; --warn:#E0A957; --warn-soft:#3B3223; --bad:#F08496; --bad-soft:#40242B;
    --c1:#8F95F2; --c2:#F0B055; --c4:#5CC497; --c5:#5BBDEB;
  }
  html.zl-live body{background:var(--paper);font-size:14px}
  html.zl-live .mono{font-family:inherit;font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
  html.zl-live .num{font-variant-numeric:tabular-nums}

  /* sidebar */
  html.zl-live .app{grid-template-columns:244px minmax(0,1fr)}
  html.zl-live .rail{background:var(--card);border-right:1px solid var(--line)}
  html.zl-live .rail-top{padding:20px 20px 16px;gap:10px}
  html.zl-live .rail-top b{color:var(--ink);font-size:16px}
  html.zl-live .rail-top small{color:var(--ink-3);text-transform:none;letter-spacing:0;font-size:12px;margin-top:1px}
  html.zl-live .mark{width:32px;height:32px;border-radius:9px;font-size:15px}
  html.zl-live .nav{padding:4px 12px 16px}
  html.zl-live .navgrp{margin-bottom:18px}
  html.zl-live .navgrp>span{color:var(--ink-3);text-transform:none;letter-spacing:0;font-size:12px;font-weight:500;padding:0 10px 6px}
  html.zl-live .navgrp>span:empty{display:none}
  html.zl-live .navitem{color:var(--ink-2);font-size:14px;padding:8px 10px;gap:11px;border-radius:8px;margin-bottom:1px}
  html.zl-live .navitem:hover{background:var(--sunk);color:var(--ink)}
  html.zl-live .navitem[aria-current="page"]{background:var(--brand-soft);color:var(--brand);font-weight:600}
  html.zl-live .navitem[aria-current="page"]::before{display:none}
  html.zl-live .navitem svg{width:18px;height:18px;opacity:1}
  html.zl-live .rail-foot{border-top:1px solid var(--line);color:var(--ink-3);font-size:12px;padding:14px 20px;line-height:1.45}

  /* top bar */
  html.zl-live .topbar{padding:10px 32px;min-height:62px;gap:12px;border-bottom:1px solid var(--line);background:var(--card)}
  html.zl-live .topbar .search{display:none}
  html.zl-live .co{border:0;padding:6px 10px 6px 6px;font-size:14px;font-weight:600;border-radius:9px;gap:10px}
  html.zl-live .co .avatar{width:30px;height:30px;border-radius:8px;font-size:12px}
  html.zl-live .topbar>.field{border:0;background:none;padding:0;margin-right:auto}
  html.zl-live .topbar>.field .hint{font-size:13px}
  html.zl-live .me{width:34px;height:34px;background:var(--brand);color:#fff;font-size:12px}

  /* page */
  html.zl-live .page{padding:32px 36px 72px;gap:22px;max-width:1280px;width:100%;margin:0 auto}
  html.zl-live .crumbs{display:none}
  html.zl-live .phead{align-items:flex-end;gap:16px 24px}
  html.zl-live .phead h1{font-size:26px;font-weight:600;letter-spacing:-.02em}
  html.zl-live .phead .sub{font-size:14px;color:var(--ink-3);margin-top:5px}
  html.zl-live .meta{gap:28px;align-items:flex-end}
  html.zl-live .meta div{font-size:12.5px;color:var(--ink-3)}
  html.zl-live .meta b{font-size:15px;font-weight:600;margin-top:3px}

  /* filters */
  html.zl-live .toolbar{border:0;background:none;padding:0;gap:10px}
  html.zl-live .tsep{display:none}
  html.zl-live .field{border-radius:9px;padding:0 12px;min-height:38px;font-size:13.5px;background:var(--card);gap:8px}
  html.zl-live .field .hint{font-size:13px}
  html.zl-live .field.in{max-width:320px}
  html.zl-live .seg{border-radius:9px;min-height:38px}
  html.zl-live .seg button{padding:0 14px;font-size:13.5px}
  html.zl-live .seg button[aria-pressed="true"]{background:var(--brand-soft);color:var(--brand);font-weight:600}
  html.zl-live .seg[aria-label="Row density"]{display:none}
  html.zl-live .count{font-size:13px}

  /* surfaces */
  html.zl-live .card,html.zl-live .stmt{border-radius:12px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
  html.zl-live .card>header{padding:18px 20px 12px;border-bottom:0}
  html.zl-live .card>header h3{font-size:15px}
  html.zl-live .card>header p{font-size:13px;margin-top:2px}
  html.zl-live .card>header .right{font-size:13px}

  /* tables */
  html.zl-live table{font-size:14px}
  html.zl-live thead th{font-size:12.5px;font-weight:500;text-transform:none;letter-spacing:0;color:var(--ink-3);
    padding:10px 16px;background:var(--sunk);border-bottom:1px solid var(--line)}
  html.zl-live tbody td{padding:12px 16px;height:auto;border-bottom:1px solid var(--line-2)}
  html.zl-live tfoot td{padding:12px 16px;border-top:1px solid var(--line)}
  html.zl-live tbody tr.click:hover td{background:var(--paper)}
  html.zl-live .code{font-size:13px;color:var(--ink-3)}
  html.zl-live .chip{border:0;border-radius:999px;padding:2px 10px;font-size:12px;background:var(--sunk);color:var(--ink-2);font-weight:500}
  html.zl-live .chip.ok{background:var(--good-soft);color:var(--good)}
  html.zl-live .chip.warn{background:var(--warn-soft);color:var(--warn)}
  html.zl-live .chip.bad{background:var(--bad-soft);color:var(--bad)}

  /* figures */
  html.zl-live .kpi-head,html.zl-live .kpi-sub{background:none;border:0;gap:16px;border-radius:0;overflow:visible}
  html.zl-live .kpi-sub{margin-top:16px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
  html.zl-live .kpi-head>div,html.zl-live .kpi-sub>div{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
  html.zl-live .klabel{text-transform:none;letter-spacing:0;font-size:13px;color:var(--ink-3)}
  html.zl-live .kval{font-size:clamp(20px,2vw,28px);margin-top:8px;white-space:nowrap}
  html.zl-live .kpi-head.zl-kpis{grid-template-columns:repeat(4,minmax(0,1fr))}
  @media (max-width:1180px){html.zl-live .kpi-head.zl-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
  html.zl-live .kpi-sub .kval{font-size:18px;margin-top:6px}
  html.zl-live .delta{font-size:12.5px;margin-top:8px}
  html.zl-live .grid2{gap:20px}
  html.zl-live .health{background:var(--line-2)}
  html.zl-live .health>div{padding:16px 20px}
  html.zl-live .health .hh{font-size:13px;color:var(--ink-2)}
  html.zl-live .health .hv{font-size:20px;margin-top:6px}
  html.zl-live .health p{font-size:12.5px}
  html.zl-live .chartbox{padding:4px 20px 14px}
  html.zl-live .legend{font-size:12.5px}
  html.zl-live .hbars{padding:4px 20px 18px;gap:12px}
  html.zl-live .hbar{font-size:13px}

  /* statements */
  html.zl-live .letterhead{padding:28px 32px 22px}
  html.zl-live .letterhead h2{font-size:19px}
  html.zl-live .letterhead .org{font-size:13.5px}
  html.zl-live .letterhead .when{font-size:13px}
  html.zl-live .stmt td{padding:7px 32px}
  html.zl-live .stmt th{padding:10px 32px}
  html.zl-live .stmt tr.grp td{text-transform:none;letter-spacing:0;font-size:14px;color:var(--ink);padding-top:22px}
  html.zl-live .stmt tr.ind td:first-child,html.zl-live .stmt tr.sub td:first-child{padding-left:48px}
  html.zl-live .stmt tr.ind td:first-child{color:var(--ink-2)}
  html.zl-live .proofrow{padding:14px 20px;font-size:13px;background:var(--sunk);border-radius:0 0 12px 12px}
  html.zl-live .stmt .proofrow{padding:14px 32px}
  html.zl-live .hint{font-size:13px}

  @media (max-width:900px){
    html.zl-live .app{grid-template-columns:minmax(0,1fr)}
    html.zl-live .rail{border-right:0;border-bottom:1px solid var(--line)}
    html.zl-live .navgrp{margin:0}
    html.zl-live .navgrp>span{display:none}
    html.zl-live .page{padding:20px 16px 56px}
    html.zl-live .topbar{padding:10px 16px}
    html.zl-live .kpi-head{grid-template-columns:minmax(0,1fr)}
    html.zl-live .kpi-sub{grid-template-columns:repeat(2,minmax(0,1fr))}
    html.zl-live .letterhead,html.zl-live .stmt td,html.zl-live .stmt th,html.zl-live .stmt .proofrow{padding-left:16px;padding-right:16px}
    html.zl-live .stmt tr.ind td:first-child,html.zl-live .stmt tr.sub td:first-child{padding-left:28px}
  }
  @media (max-width:640px){
    html.zl-live .kpi-head.zl-kpis{gap:10px}
    html.zl-live .kpi-head>div{padding:14px}
    html.zl-live .kval{font-size:18px}
    html.zl-live .klabel{font-size:12px}
    html.zl-live .delta{font-size:11.5px;margin-top:6px}
    html.zl-live .topbar>.field{display:none}
    html.zl-live .phead h1{font-size:22px}
    html.zl-live .co{flex:1;min-width:0}
    html.zl-live .zl-co-name{max-width:none}
  }

  /* components */
  .zl-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--line);background:var(--card);color:var(--ink);
    border-radius:9px;padding:0 14px;min-height:38px;font:inherit;font-size:13.5px;font-weight:500;cursor:pointer;white-space:nowrap;line-height:1.2}
  .zl-btn:hover{background:var(--sunk)}
  .zl-btn.primary{background:var(--brand);border-color:var(--brand);color:#fff}
  .zl-btn.primary:hover{filter:brightness(1.08);background:var(--brand)}
  .zl-btn.danger{background:var(--card);border-color:var(--line);color:var(--bad)}
  .zl-btn.danger:hover{background:var(--bad-soft)}
  .zl-modal footer .zl-btn.danger{background:var(--bad);border-color:var(--bad);color:#fff}
  .zl-btn.ghost{border-color:transparent;background:transparent;color:var(--ink-2)}
  .zl-btn.ghost:hover{background:var(--sunk);color:var(--ink)}
  .zl-btn[disabled]{opacity:.55;cursor:not-allowed}
  .zl-btn.sm{padding:0 10px;min-height:30px;font-size:12.5px;border-radius:8px}
  .zl-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .zl-input{width:100%;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:9px;padding:9px 11px;font:inherit;font-size:14px;outline:none}
  .zl-input:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
  .zl-input.num{text-align:right;font-variant-numeric:tabular-nums}
  textarea.zl-input{resize:vertical}
  .zl-amount{position:relative}
  .zl-amount span{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--ink-3);font-size:13px;pointer-events:none}
  .zl-amount .zl-input{padding-left:40px;text-align:left;font-size:16px;font-weight:600}
  .zl-form{display:grid;gap:14px;grid-template-columns:1fr 1fr}
  .zl-form>*{grid-column:1/-1}
  .zl-form>.half{grid-column:auto}
  .zl-field{display:grid;gap:6px;font-size:13px;color:var(--ink-2)}
  .zl-field>span{font-weight:500}
  .zl-field i{color:var(--bad);font-style:normal}
  .zl-field small{color:var(--ink-3);font-size:12.5px}
  .zl-check{display:flex;gap:10px;align-items:flex-start;font-size:13.5px;color:var(--ink);cursor:pointer}
  .zl-check input{margin-top:3px;width:16px;height:16px;accent-color:var(--brand)}
  .zl-check small{display:block;color:var(--ink-3);font-size:12.5px;margin-top:2px}
  .zl-p{margin:0;color:var(--ink-2);font-size:14px;line-height:1.55}
  .zl-err{border:1px solid color-mix(in srgb,var(--bad) 35%,transparent);background:var(--bad-soft);color:var(--bad);border-radius:9px;padding:10px 12px;font-size:13px;margin-top:14px;line-height:1.45}
  .zl-err b{font-weight:600}
  .zl-scrim{position:fixed;inset:0;background:rgba(16,24,40,.45);z-index:70;display:grid;place-items:center;padding:16px}
  .zl-modal{background:var(--card);border:1px solid var(--line);border-radius:14px;width:min(480px,100%);max-height:calc(100vh - 32px);
    display:flex;flex-direction:column;box-shadow:0 24px 48px -12px rgba(16,24,40,.25)}
  .zl-modal.wide{width:min(760px,100%)}
  .zl-modal header{display:flex;align-items:center;gap:10px;padding:18px 20px 6px}
  .zl-modal header h3{font-size:17px;font-weight:600;margin:0;flex:1}
  .zl-modal-body{padding:10px 20px 18px;overflow-y:auto}
  .zl-modal footer{display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid var(--line)}
  #zl-toasts{position:fixed;right:20px;bottom:20px;z-index:90;display:grid;gap:8px;max-width:min(400px,calc(100vw - 40px))}
  .zl-toast{background:var(--ink);color:var(--card);border-radius:10px;padding:12px 16px;font-size:13.5px;box-shadow:0 12px 32px rgba(0,0,0,.22);
    border-left:4px solid var(--good);transition:opacity .4s,transform .4s}
  .zl-toast.bad{border-left-color:var(--bad)}
  .zl-toast.warn{border-left-color:var(--warn)}
  .zl-toast.out{opacity:0;transform:translateY(6px)}
  .zl-loading{display:flex;align-items:center;gap:10px;color:var(--ink-3);padding:48px 4px;font-size:14px}
  .zl-spin{width:18px;height:18px;border-radius:50%;border:2px solid var(--line);border-top-color:var(--brand);animation:zlspin .8s linear infinite}
  @keyframes zlspin{to{transform:rotate(360deg)}}
  .zl-empty{padding:28px 28px}
  .zl-empty h3{font-size:16px;font-weight:600;margin:0 0 6px}
  .zl-empty p{margin:0;color:var(--ink-2);font-size:14px}
  .zl-co{cursor:pointer}
  .zl-co:hover{background:var(--sunk)}
  .zl-co-name{max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .zl-menu{position:absolute;z-index:80;min-width:280px;background:var(--card);border:1px solid var(--line);border-radius:12px;
    box-shadow:0 16px 40px rgba(16,24,40,.16);padding:6px;display:flex;flex-direction:column}
  .zl-menu-h{padding:8px 10px 6px;font-size:12px;color:var(--ink-3)}
  .zl-menu button{all:unset;box-sizing:border-box;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 10px;border-radius:8px;cursor:pointer;font-size:14px;color:var(--ink)}
  .zl-menu button:hover,.zl-menu button:focus-visible{background:var(--sunk)}
  .zl-menu button b{display:block;font-weight:500}
  .zl-menu button small{display:block;color:var(--ink-3);font-size:12px}
  .zl-menu button svg{color:var(--brand)}
  .zl-menu .zl-menu-new{color:var(--brand);border-top:1px solid var(--line);margin-top:4px;border-radius:0 0 8px 8px;font-weight:500}
  .zl-choice{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));max-width:760px}
  .zl-choice-card{all:unset;box-sizing:border-box;display:grid;gap:6px;padding:22px 24px;cursor:pointer;background:var(--card);border:1px solid var(--line);border-radius:12px}
  .zl-choice-card:hover,.zl-choice-card:focus-visible{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
  .zl-choice-card b{font-size:17px}
  .zl-choice-card span{color:var(--ink-2);font-size:14px;line-height:1.5}
  .zl-ref{color:var(--brand);font-weight:500;font-variant-numeric:tabular-nums}
  button.zl-ref{padding:0;background:none;border:0;cursor:pointer;font:inherit;color:var(--brand)}
  button.zl-ref:hover{text-decoration:underline}
  .zl-row-actions{display:flex;gap:2px;justify-content:flex-end;opacity:0;transition:opacity .12s}
  tr:hover .zl-row-actions,tr:focus-within .zl-row-actions{opacity:1}
  @media (hover:none){.zl-row-actions{opacity:1}}
  .zl-pos{color:var(--good)} .zl-neg{color:var(--ink)}
  @media (max-width:640px){.zl-co-name{max-width:140px}.zl-form{grid-template-columns:1fr}.zl-form>.half{grid-column:1/-1}}
  @media print{
    .rail,.topbar,.toolbar,#zl-toasts,.zl-noprint,.zl-actions{display:none!important}
    html.zl-live .app{display:block} html.zl-live .page{padding:0;max-width:none} body{background:#fff}
    .stmt,.card{border:0!important;box-shadow:none!important}
  }
  `;

  function injectCss() {
    if (document.getElementById("zl-css")) return;
    const s = document.createElement("style");
    s.id = "zl-css";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /** The workspace theme; the demo company uses it too. */
  ZL.theme = () => {
    document.documentElement.classList.add("zl-live");
    injectCss();
  };

  // ── boot ───────────────────────────────────────────────────────────────
  ZL.boot = async () => {
    ZL.theme();
    document.title = "Zycount";
    const page = document.getElementById("page");
    document.getElementById("nav").innerHTML = "";
    // Nothing from the demo company shows while the real books load.
    const co = document.querySelector(".topbar .co");
    if (co) co.innerHTML = "";
    const railTitle = document.querySelector(".rail-top small");
    if (railTitle) railTitle.textContent = "";
    const railFoot = document.querySelector(".rail-foot");
    if (railFoot) railFoot.textContent = "";
    const fy = document.querySelector(".topbar > .field .hint");
    if (fy) fy.textContent = "";
    page.innerHTML = `<div class="zl-loading" aria-busy="true"><span class="zl-spin"></span>Opening your books…</div>`;

    if (!window.supabase || !window.supabase.createClient) {
      page.innerHTML = `<section class="card" style="padding:20px 24px">${ZL.errorBox(new ZLError("NETWORK", "The database client didn't load. Check your connection and reload the page."))}</section>`;
      return;
    }
    ZL.client();

    const { data: sessionData } = await ZL.sb.auth.getSession();
    const session = sessionData && sessionData.session;
    if (!session) { ZL.expireSession(); return; }
    const meta = session.user.user_metadata || {};
    ZL.user = { id: session.user.id, email: session.user.email, name: meta.full_name || session.user.email.split("@")[0] };

    ZL.sb.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") ZL.expireSession();
    });

    // Signing out goes through Supabase so the refresh token is revoked.
    const out = document.getElementById("me-signout");
    if (out) {
      const clone = out.cloneNode(true); // drops the demo handler
      out.replaceWith(clone);
      clone.addEventListener("click", ZL.signOut);
    }

    try {
      [ZL.companies, ZL.platformAdmin] = await Promise.all([ZL.rpc("my_companies"), ZL.rpc("is_platform_admin").catch(() => false)]);
    } catch (e) {
      page.innerHTML = `<section class="card" style="padding:20px 24px">${ZL.errorBox(e)}</section>`;
      return;
    }

    // An invite link opened on the sign-in page is accepted now that we know who you are.
    let invite = null, joined = null, inviteError = null;
    try { invite = localStorage.getItem("zl.invite"); localStorage.removeItem("zl.invite"); } catch (_) { /* ignore */ }
    if (invite) {
      try {
        joined = await ZL.rpc("accept_invite", { p_token: invite });
        ZL.companies = await ZL.rpc("my_companies");
        try { localStorage.setItem(COMPANY_KEY, joined.company_id); } catch (_) { /* ignore */ }
      } catch (e) { inviteError = e; }
    }
    const inviteToast = () => {
      if (joined) ZL.toast(joined.already ? `You already have access to ${joined.name}.` : `You joined ${joined.name}.`);
      if (inviteError) ZL.toast(ZL.errorText(inviteError), "bad");
    };

    // Live modules replace the demo pages; everything else leaves the menu.
    Object.keys(ZL.modules).forEach((route) => {
      PAGES[route] = () => ZL.placeholder(route);
      VALID.add(route);
    });

    if (!ZL.companies.length) {
      ZL.company = null;
      ZL.applyChrome();
      ZL.onboarding();
      inviteToast();
      return;
    }
    let stored = null;
    try { stored = localStorage.getItem(COMPANY_KEY); } catch (_) { /* ignore */ }
    ZL.company = ZL.companies.find((c) => c.company_id === stored) || ZL.companies[0];
    ZL.noteAdminOpen(ZL.company);

    // A reload keeps the page you were on, including routes that only exist live.
    const fromHash = location.hash.replace("#", "");
    if (ZL.modules[fromHash]) state.route = fromHash;
    if (!ZL.modules[state.route]) state.route = "dashboard";
    try {
      const saved = JSON.parse(sessionStorage.getItem(PARAMS_KEY) || "null");
      if (saved && saved.route === state.route) { ZL.params = saved.params || {}; ZL.paramsRoute = state.route; }
    } catch (_) { /* ignore */ }
    const mod = ZL.modules[state.route];
    if (mod.detail && !ZL.params.id && !ZL.params.copyFrom && !ZL.params.isNew) state.route = mod.nav || "dashboard";

    ZL.applyChrome();
    ZL.buildNav();
    renderNav();
    go(state.route);
    inviteToast();

    try {
      if (!sessionStorage.getItem("zl.loggedin")) {
        sessionStorage.setItem("zl.loggedin", "1");
        await ZL.sb.rpc("log_event", { p_company: ZL.company.company_id, p_action: "auth.login" });
      }
    } catch (_) { /* audit of sign-in is best effort */ }
  };
})();
