/* Zycount live — LHDN MyInvois e-Invoice.
 * Settings (each book connects its own MyInvois ERP client ID and secret; the secret is
 * stored in Supabase Vault and never comes back to the browser), the e-Invoice panel on
 * invoices, cash sales, credit notes and debit notes, the validation QR on the printout,
 * and the TIN check on customers. LHDN is only ever called by the myinvois edge function.
 */
(function () {
  "use strict";
  const ZL = window.ZL;
  if (!ZL) return;
  const E = ZL.esc;
  const cid = () => ZL.company.company_id;

  const KINDS = new Set(["INVOICE", "CASH_SALE", "CREDIT_NOTE", "DEBIT_NOTE"]);
  const PORTAL = { SANDBOX: "https://preprod.myinvois.hasil.gov.my", PRODUCTION: "https://myinvois.hasil.gov.my" };
  const STATES = [["01", "Johor"], ["02", "Kedah"], ["03", "Kelantan"], ["04", "Melaka"], ["05", "Negeri Sembilan"], ["06", "Pahang"],
    ["07", "Pulau Pinang"], ["08", "Perak"], ["09", "Perlis"], ["10", "Selangor"], ["11", "Terengganu"], ["12", "Sabah"], ["13", "Sarawak"],
    ["14", "WP Kuala Lumpur"], ["15", "WP Labuan"], ["16", "WP Putrajaya"]];
  const LABEL = { VALID: ["ok", "Validated by LHDN"], SUBMITTED: ["", "With LHDN — waiting for validation"], INVALID: ["bad", "Rejected by LHDN"],
    CANCELLED: ["", "Cancelled at LHDN"], PENDING: ["", "Sending…"] };

  /** Calls the myinvois edge function; LHDN's own error comes back as a ZLError. */
  async function call(body) {
    const { data, error } = await ZL.sb.functions.invoke("myinvois", { body });
    if (!error && data && !data.error) return data;
    let b = null;
    try { b = error && error.context && typeof error.context.json === "function" ? await error.context.json() : null; } catch (_) { /* not JSON */ }
    const x = (b && b.error) || (data && data.error) || {};
    const err = new ZL.ZLError(x.code || "NETWORK", x.message || "MyInvois didn't answer. Try again in a moment.");
    err.errors = x.errors || [];
    throw err;
  }

  const shareLink = (st) => (st && st.uuid && st.long_id ? `${PORTAL[st.environment] || PORTAL.SANDBOX}/${st.uuid}/share/${st.long_id}` : null);
  const errList = (errors) => (errors && errors.length ? `<ul class="zl-einv-err">${errors.slice(0, 8).map((x) =>
    `<li>${E(x.message || "")}${x.path ? ` <span class="hint mono">${E(x.path)}</span>` : ""}</li>`).join("")}</ul>` : "");

  // ── Printout: the validation QR and LHDN's UUID ──────────────────────────
  async function printBlock(doc) {
    const st = await ZL.rpc("einvoice_doc_status", { p_doc: doc.id });
    const link = shareLink(st);
    if (!link) return "";
    await ZL.lib("qr");
    const qr = window.qrcode(0, "M");
    qr.addData(link);
    qr.make();
    return `<div class="zv-einv" style="display:flex;gap:14px;align-items:center;margin:14px 0;padding:10px 12px;border:1px solid #d9dce5;border-radius:8px;font-size:11px;color:#3a3f4f">
      <div style="width:92px;height:92px;flex:none">${qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true })}</div>
      <div><b style="display:block;font-size:12px;color:#111">Validated e-Invoice (LHDN MyInvois)${st.environment === "SANDBOX" ? " — SANDBOX, not a real e-Invoice" : ""}</b>
        UUID ${E(st.uuid)}<br>Validated ${E(ZL.dateTime(st.last_at))}<br>Scan to verify at LHDN.</div></div>`;
  }

  // ── Panel on the document page ───────────────────────────────────────────
  async function panel(el, doc) {
    if (!el || !KINDS.has(doc.doc_type) || doc.status !== "POSTED" || ZL.isPersonal()) { if (el) el.innerHTML = ""; return; }
    const draw = async (fresh) => {
      let st;
      try { st = fresh || await ZL.rpc("einvoice_doc_status", { p_doc: doc.id }); } catch (e) { el.innerHTML = ""; return; }
      const status = st.status;
      const [tone, label] = LABEL[status] || ["", "Not sent to LHDN"];
      const link = st.link || shareLink(st);
      const age = st.submitted_at ? (Date.now() - new Date(st.submitted_at).getTime()) / 3.6e6 : null;
      const canPost = ZL.can("journal.post"), canRev = ZL.can("journal.reverse");
      const btns = [];
      if ((!status || status === "INVALID" || status === "CANCELLED") && canPost) btns.push(`<button type="button" class="zl-btn sm primary" data-ei="submit">${status ? "Send again" : "Send to LHDN"}</button>`);
      if (status === "SUBMITTED" || status === "VALID") btns.push(`<button type="button" class="zl-btn sm" data-ei="status">Check status</button>`);
      if (status === "VALID" && canRev && age != null && age < 72) btns.push(`<button type="button" class="zl-btn sm ghost danger" data-ei="cancel">Cancel at LHDN</button>`);
      if (link) btns.push(`<a class="zl-btn sm ghost" href="${E(link)}" target="_blank" rel="noopener">Open at LHDN ↗</a>`);
      el.innerHTML = `<section class="card zl-einv" style="margin-top:16px;padding:14px 18px">
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <div style="flex:1;min-width:220px"><div class="hint">e-Invoice · LHDN MyInvois${st.environment === "SANDBOX" ? ' <span class="chip">Sandbox</span>' : ""}</div>
            <b class="${tone === "bad" ? "" : ""}" style="${tone === "bad" ? "color:var(--bad)" : ""}">${E(label)}</b>
            ${st.uuid ? `<div class="hint mono" style="margin-top:2px">UUID ${E(st.uuid)}</div>` : ""}
            ${status === "VALID" && age != null ? `<div class="hint">${age < 72 ? `Can be cancelled at LHDN for ${Math.max(0, Math.floor(72 - age))} more hours; after that, issue a credit note.` : "Past the 72-hour cancellation window — correct it with a credit or debit note."}</div>` : ""}
            ${!status ? `<div class="hint">${doc.doc_type === "CREDIT_NOTE" || doc.doc_type === "DEBIT_NOTE" ? "Send the invoice it corrects first." : "LHDN checks it within seconds and returns a UUID and QR code for the printout."}</div>` : ""}</div>
          <div class="zl-actions">${btns.join("")}</div>
        </div>
        ${status === "INVALID" ? errList(st.errors) : ""}
      </section>`;
      el.querySelectorAll("[data-ei]").forEach((b) => b.addEventListener("click", () => act(b.dataset.ei, b)));
    };
    const act = async (what, b) => {
      if (what === "cancel") {
        const v = await ZL.form({ title: `Cancel ${doc.doc_no} at LHDN?`, danger: true, confirmLabel: "Cancel e-Invoice",
          intro: "LHDN marks the e-Invoice cancelled and tells the buyer. The document stays in your books — void it here too if the sale didn't happen.",
          fields: [{ name: "reason", label: "Reason for LHDN", required: true, placeholder: "e.g. Wrong buyer details" }] });
        if (!v) return;
        b.disabled = true;
        try { await call({ action: "cancel", doc_id: doc.id, reason: v.reason }); ZL.toast(`${doc.doc_no} cancelled at LHDN.`); ZL.refresh(); }
        catch (e) { ZL.toast(ZL.errorText(e), "bad"); b.disabled = false; }
        return;
      }
      b.disabled = true;
      const old = b.textContent;
      b.textContent = what === "submit" ? "Sending to LHDN…" : "Checking…";
      try {
        const r = await call({ action: what, doc_id: doc.id });
        if (r.status === "VALID") ZL.toast(`${doc.doc_no} validated by LHDN.`);
        else if (r.status === "INVALID") ZL.toast(`LHDN rejected ${doc.doc_no} — see why below.`, "bad");
        else ZL.toast(`${doc.doc_no} is with LHDN. Check again in a minute.`, "warn");
        ZL.refresh();
      } catch (e) {
        ZL.toast(ZL.errorText(e), "bad");
        if (e.code === "EINVOICE_NOT_CONNECTED" || /Settings → e-Invoice/.test(e.message || "")) setTimeout(() => ZL.open("einvoice", {}), 400);
        b.disabled = false; b.textContent = old;
        draw();
      }
    };
    await draw();
  }

  // ── Settings ─────────────────────────────────────────────────────────────
  ZL.register("einvoice", {
    title: "e-Invoice",
    perm: "company.view",
    business: true,
    get nav() { return "settings"; },
    async render() {
      const s = await ZL.rpc("einvoice_settings_get", { p_company: cid() });
      const edit = ZL.can("company.edit");
      const dis = edit ? "" : " disabled";
      const f = (name, label, value, opts = {}) => `<label class="zl-field${opts.half ? " half" : ""}"><span>${label}</span>
        <input class="zl-input${opts.mono ? " mono" : ""}" name="${name}" value="${E(value || "")}"${opts.type ? ` type="${opts.type}"` : ""}${opts.ph ? ` placeholder="${E(opts.ph)}"` : ""}${opts.max ? ` maxlength="${opts.max}"` : ""}${opts.ro ? " disabled" : dis} autocomplete="off"></label>`;
      const portal = PORTAL[s.environment] || PORTAL.SANDBOX;
      return ZL.header("e-Invoice (LHDN MyInvois)", "Send invoices, credit notes and debit notes to LHDN straight from Zycount.",
          `<button type="button" class="zl-btn ghost" id="zl-ei-back">← Settings</button>`) + `
        <section class="card" style="padding:16px 20px;margin-bottom:16px">
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            ${s.connected ? `<span class="chip ok">Connected · ${s.environment === "PRODUCTION" ? "Production" : "Sandbox"}</span>` : '<span class="chip warn">Not connected</span>'}
            <span class="hint">${s.connected ? "Invoices show a “Send to LHDN” button once posted." : "Three steps, about five minutes."}</span>
          </div>
          <ol class="hint" style="margin:10px 0 0 18px;line-height:1.7">
            <li>Log in to the <a href="${E(portal)}" target="_blank" rel="noopener">MyInvois portal${s.environment === "SANDBOX" ? " (sandbox)" : ""}</a> as the company → <b>Taxpayer profile</b> → <b>Representatives / ERP</b> → <b>Register ERP</b>.</li>
            <li>Copy the <b>Client ID</b> and <b>Client Secret</b> it shows (the secret is shown once).</li>
            <li>Paste them below with your company details, save, then press <b>Test connection</b>.</li>
          </ol>
          <p class="hint" style="margin-top:8px">Start in the <b>sandbox</b> — nothing sent there is a real e-Invoice. Switch to production when the test invoices validate.</p>
        </section>
        <section class="card"><form class="zl-form" id="zl-ei-form" style="padding:18px 20px" autocomplete="off">
          <label class="zl-field half"><span>Environment</span><select class="zl-input" name="environment"${dis}>
            <option value="SANDBOX"${s.environment !== "PRODUCTION" ? " selected" : ""}>Sandbox (testing)</option>
            <option value="PRODUCTION"${s.environment === "PRODUCTION" ? " selected" : ""}>Production (real e-Invoices)</option></select></label>
          <div class="zl-field half"></div>
          ${f("client_id", "Client ID", s.client_id, { half: true, mono: true, max: 100 })}
          <label class="zl-field half"><span>Client secret</span><input class="zl-input mono" name="client_secret" type="password" autocomplete="new-password"
            placeholder="${s.has_secret ? "Saved — type a new one to replace it" : "Paste the client secret"}" maxlength="200"${dis}></label>
          <h4 style="grid-column:1/-1;margin:8px 0 0;font-size:13px">Your company as LHDN knows it</h4>
          ${f("tin", "TIN (tax identification no.)", s.tin, { half: true, mono: true, ph: "C20880050010", max: 20 })}
          ${f("brn", "Registration no. (BRN)", s.brn, { half: true, ro: true })}
          ${f("sst_no", "SST registration no.", s.sst_no, { half: true, ph: "Leave blank if not registered", max: 35 })}
          ${f("ttx_no", "Tourism tax no.", s.ttx_no, { half: true, ph: "Leave blank if not registered", max: 17 })}
          ${f("msic_code", "MSIC code", s.msic_code, { half: true, mono: true, ph: "e.g. 62010", max: 5 })}
          ${f("activity", "Business activity", s.activity, { half: true, ph: "e.g. Computer programming activities", max: 300 })}
          ${f("address_line", "Address", s.address_line, { max: 300 })}
          ${f("postcode", "Postcode", s.postcode, { half: true, max: 10 })}
          ${f("city", "City", s.city, { half: true, max: 50 })}
          <label class="zl-field half"><span>State</span><select class="zl-input" name="state_code"${dis}><option value="">Choose…</option>
            ${STATES.map(([c, n]) => `<option value="${c}"${s.state_code === c ? " selected" : ""}>${n}</option>`).join("")}</select></label>
          ${f("phone", "Phone (from Settings)", s.phone, { half: true, ro: true })}
          <p class="hint" style="grid-column:1/-1;margin:0">Registration no., phone and email come from <button type="button" class="zl-ref" id="zl-ei-co">Settings → Company</button>. Customers need a TIN and registration / IC no. on their record; sales to the public go out under LHDN's general-public TIN.</p>
          ${edit ? `<div class="zl-actions" style="grid-column:1/-1"><button type="submit" class="zl-btn primary">Save</button>
            <button type="button" class="zl-btn" id="zl-ei-test"${s.connected ? "" : " disabled"}>Test connection</button></div>` : ""}
        </form></section>`;
    },
    after(root) {
      const back = () => ZL.open("settings", {});
      root.querySelector("#zl-ei-back").addEventListener("click", back);
      const co = root.querySelector("#zl-ei-co");
      if (co) co.addEventListener("click", back);
      const form = root.querySelector("#zl-ei-form");
      const err = (e) => { form.querySelectorAll(".zl-err").forEach((x) => x.remove()); if (e) form.insertAdjacentHTML("beforeend", ZL.errorBox(e)); };
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        if (!ZL.can("company.edit")) return;
        const v = (n) => { const x = form.querySelector(`[name="${n}"]`); return x ? x.value.trim() : ""; };
        err();
        const btn = form.querySelector('[type="submit"]');
        btn.disabled = true;
        try {
          await ZL.rpc("save_einvoice_settings", { p_company: cid(), p_data: { environment: v("environment"), client_id: v("client_id"), tin: v("tin"),
            sst_no: v("sst_no"), ttx_no: v("ttx_no"), msic_code: v("msic_code"), activity: v("activity"), address_line: v("address_line"),
            postcode: v("postcode"), city: v("city"), state_code: v("state_code") }, p_client_secret: v("client_secret") || null });
          form.querySelector('[name="client_secret"]').value = "";
          ZL.toast("e-Invoice settings saved.");
          ZL.refresh();
        } catch (e) { err(e); btn.disabled = false; }
      });
      const test = root.querySelector("#zl-ei-test");
      if (test) test.addEventListener("click", async () => {
        test.disabled = true; err();
        try { const r = await call({ action: "test", company_id: cid() }); ZL.toast(`Connected to MyInvois ${r.environment === "PRODUCTION" ? "production" : "sandbox"}.`); }
        catch (e) { err(e); }
        test.disabled = false;
      });
    },
  });

  /** Asks LHDN whether a customer's TIN matches their registration / IC number. */
  async function checkTin(contactId) {
    try {
      const r = await call({ action: "validate_tin", contact_id: contactId });
      ZL.toast(r.valid ? `TIN ${r.tin} is valid at LHDN.` : `LHDN doesn't match TIN ${r.tin} with that registration / IC no. Check both.`, r.valid ? "" : "bad");
      return r.valid;
    } catch (e) { ZL.toast(ZL.errorText(e), "bad"); return null; }
  }

  ZL.einvoice = { call, panel, printBlock, checkTin, KINDS };

  const css = document.createElement("style");
  css.textContent = `.zl-einv-err{margin:10px 0 0 18px;color:var(--bad);font-size:13px;line-height:1.6}`;
  document.head.appendChild(css);
})();
