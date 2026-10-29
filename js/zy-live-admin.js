/* ═══════════════════════════════════════════════════════════════════════════
 * Zycount live workspace — administration: audit trail, members and roles,
 * settings (books profile, your profile, password, your other books).
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const ZL = window.ZL;
  const E = ZL.esc;
  const cid = () => ZL.company.company_id;
  const btn = (id, label, cls = "") => `<button type="button" class="zl-btn ${cls}" id="${id}">${label}</button>`;

  const style = document.createElement("style");
  style.textContent = `
  .zl-set{display:grid;grid-template-columns:minmax(0,260px) minmax(0,1fr);gap:24px;padding:24px;border-bottom:1px solid var(--line-2)}
  .zl-set:last-child{border-bottom:0}
  .zl-set h3{font-size:15px;margin:0 0 4px}
  .zl-set p{margin:0;color:var(--ink-3);font-size:13px;line-height:1.5}
  .zl-set .zl-form{max-width:560px}
  .zl-av{width:34px;height:34px;border-radius:50%;background:var(--brand-soft);color:var(--brand);display:inline-grid;place-items:center;font-size:12px;font-weight:600;flex:none}
  .zl-person{display:flex;align-items:center;gap:12px}
  .zl-person b{display:block;font-weight:500}
  .zl-person small{display:block;color:var(--ink-3);font-size:12.5px}
  .zl-roles{display:grid;gap:0}
  .zl-roles details{border-top:1px solid var(--line-2);padding:12px 20px}
  .zl-roles summary{cursor:pointer;display:flex;justify-content:space-between;gap:12px;font-size:14px;list-style:none}
  .zl-roles summary::-webkit-details-marker{display:none}
  .zl-roles summary span{color:var(--ink-3);font-size:13px}
  .zl-roles .perms{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
  select.zl-role{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:6px 8px;font:inherit;font-size:13px}
  @media (max-width:760px){.zl-set{grid-template-columns:minmax(0,1fr);gap:12px;padding:18px}}
  `;
  document.head.appendChild(style);

  const initials = (s) => String(s || "").split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("");
  const ACTION_LABEL = {
    "auth.login": "Signed in", "auth.logout": "Signed out", "company.create": "Books created", "company.edit": "Settings changed",
    "account.create": "Account created", "account.edit": "Account edited", "account.archive": "Account archived", "account.delete": "Account deleted",
    "journal.create": "Draft created", "journal.edit": "Draft edited", "journal.delete": "Draft deleted", "journal.post": "Journal posted", "journal.reverse": "Journal reversed",
    "period.generate": "Periods generated", "period.close": "Period closed", "period.reopen": "Period reopened",
    "user.create": "Member added", "user.edit": "Role changed", "user.delete": "Member removed",
    "user.invite": "Invite created", "user.invite_cancel": "Invite cancelled", "user.join": "Joined by invite",
    "admin.join": "Zycount admin joined", "admin.open": "Zycount admin opened", "bank.import": "Statement uploaded", "bank.delete": "Statement deleted", "bank.record": "Statement recorded",
    "numbering.create": "Numbering added", "numbering.edit": "Numbering changed", "numbering.delete": "Numbering removed",
    "trade.save": "Document drafted", "trade.post": "Document posted", "trade.void": "Document voided", "trade.delete": "Draft deleted",
    "trade.allocate": "Knocked off", "trade.unallocate": "Knock-off removed", "contact.save": "Contact saved", "contact.delete": "Contact removed",
    "item.save": "Item saved", "item.delete": "Item removed", "tax.save": "Tax code saved",
  };
  const tone = (a) => (/reverse|delete|reopen|archive|void|unallocate/.test(a) ? "warn" : /post|close/.test(a) ? "ok" : "");

  /** Makes a one-time invite link for a set of books and shows it ready to share. */
  ZL.invite = async (companyId, companyName, role) => {
        const roles = ["Accountant", "FinanceManager", "Auditor", "ReadOnly", "Admin", "SuperAdmin"];
        const token = await ZL.form({
          title: ZL.T("Invite someone", "Share your books"),
          intro: "Zycount makes a private link. Send it to the person yourself — by WhatsApp or email. It works once and expires in 7 days.",
          confirmLabel: "Create link",
          fields: [
            { name: "role", label: "Their role", type: "select", value: role || "Accountant", options: roles.map((r) => ({ value: r, label: ROLE_NAME[r] })) },
            { name: "note", label: "Who is it for?", placeholder: "Optional — e.g. Siti, our accountant" },
          ],
          submit: (v) => ZL.rpc("create_invite", { p_company: companyId, p_role: v.role, p_note: v.note || null }),
        });
        if (typeof token !== "string") return;
        const link = new URL(`login.html#invite=${token}`, location.href).href;
        const text = `Join ${companyName} on Zycount: ${link}`;
        ZL.modal({
          title: "Invite link ready",
          body: `<p class="zl-p" style="margin-bottom:12px">Send this link to the person. Anyone who opens it can join once, so share it only with them.</p>
            <input class="zl-input" id="zl-invlink" readonly value="${E(link)}" style="font-size:13px">
            <p style="margin-top:12px"><a class="zl-btn" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">Share on WhatsApp</a></p>`,
          actions: [
            { label: "Done" },
            { label: "Copy link", primary: true, onClick: async ({ close, root: m }) => {
              try { await navigator.clipboard.writeText(link); } catch (_) { const i = m.querySelector("#zl-invlink"); i.select(); document.execCommand("copy"); }
              ZL.toast("Link copied."); close();
            } },
          ],
          onClose: () => ZL.refresh(),
        });
  };

  // ══ Audit trail ═══════════════════════════════════════════════════════════
  ZL.register("audit", {
    title: "Audit trail",
    perm: "audit.view",
    async render(ctx) {
      const p = ctx.params;
      const size = p.limit || 100, cat = p.cat || "", term = String(p.q || "").replace(/[,()*%\\:"']/g, " ").trim().slice(0, 80);
      const { rows, count } = await ZL.page("audit_log", "id,action,entity_type,entity_id,summary,user_email,created_at", (q) => {
        q = q.eq("company_id", cid());
        if (cat) q = q.like("action", `${cat}.%`);
        if (term) q = q.or(`summary.ilike.*${term}*,user_email.ilike.*${term}*,action.ilike.*${term}*`);
        return q.order("created_at", { ascending: false }).order("id", { ascending: false });
      }, 0, size);
      const cats = [["", "Everything"], ["journal", "Journals"], ["account", "Accounts"], ["period", "Periods"], ["user", "Members"], ["company", "Settings"], ["auth", "Sign-ins"]];
      this._rows = rows;
      return ZL.header("Audit trail", `${count} event${count === 1 ? "" : "s"} · written by the database, never edited or deleted`,
          ZL.can("report.export") && rows.length ? btn("zl-acsv", "Export CSV", "ghost") : "") + `
        <div class="toolbar">
          <label class="field in"><input id="zl-aq" type="search" value="${E(p.q || "")}" placeholder="Search who or what" aria-label="Search the audit trail"></label>
          <label class="field"><select id="zl-acat" aria-label="Filter">${cats.map(([v, l]) => `<option value="${v}"${cat === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
          <span class="count"><b>${rows.length}</b> of ${count}</span>
        </div>
        ${rows.length ? `<section class="card"><div class="tablewrap"><table>
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
          <tbody>${rows.map((r) => `<tr${r.entity_type === "JournalEntry" && r.action !== "journal.delete" ? ` class="click" data-open-journal="${E(r.entity_id)}"` : ""}>
            <td class="nil" style="white-space:nowrap">${ZL.dateTime(r.created_at)}</td>
            <td style="white-space:nowrap">${E(r.user_email || "System")}</td>
            <td><span class="chip ${tone(r.action)}">${E(ACTION_LABEL[r.action] || r.action)}</span></td>
            <td>${E(r.summary || "")}</td></tr>`).join("")}</tbody>
        </table></div>
        ${count > rows.length ? `<div class="proofrow"><span>Showing the latest ${rows.length} of ${count}.</span><span class="figs">${btn("zl-amore", "Load 100 more", "sm")}</span></div>` : ""}
        </section>` : ZL.empty("Nothing matches", "Try another search or filter.")}`;
    },
    after(root, ctx) {
      const p = ctx.params;
      const q = root.querySelector("#zl-aq");
      q.addEventListener("input", ZL.debounce(() => ZL.open("audit", Object.assign({}, p, { q: q.value, focus: "q" })), 400));
      if (p.focus === "q") { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      root.querySelector("#zl-acat").addEventListener("change", (ev) => ZL.open("audit", Object.assign({}, p, { cat: ev.target.value, focus: null })));
      const more = root.querySelector("#zl-amore");
      if (more) more.addEventListener("click", () => ZL.open("audit", Object.assign({}, p, { limit: (p.limit || 100) + 100, focus: null })));
      const csv = root.querySelector("#zl-acsv");
      if (csv) csv.addEventListener("click", () => ZL.csv(`audit-trail-${ZL.today()}.csv`,
        [["When", "Who", "Action", "Details", "Entity", "Entity id"]].concat(ZL.modules.audit._rows.map((r) =>
          [r.created_at, r.user_email || "", r.action, r.summary || "", r.entity_type || "", r.entity_id || ""]))));
      ZL.wireJournalLinks(root);
    },
  });

  // ══ Members and roles ═════════════════════════════════════════════════════
  const ROLE_ORDER = ["SuperAdmin", "Admin", "FinanceManager", "Accountant", "Auditor", "ReadOnly", "Sales", "Purchaser", "HR", "Employee"];
  const ROLE_NAME = { SuperAdmin: "Owner", Admin: "Admin", FinanceManager: "Finance manager", Accountant: "Accountant", Auditor: "Auditor",
    ReadOnly: "Read only", Sales: "Sales", Purchaser: "Purchaser", HR: "HR", Employee: "Employee" };

  ZL.register("users", {
    title: "Users & roles",
    perm: "user.view",
    async render(ctx) {
      const P = ZL.isPersonal();
      const [members, roles, invites] = await Promise.all([
        ZL.select("company_members", "user_id,role,created_at", (q) => q.eq("company_id", cid()).order("created_at")),
        ZL.select("roles", "name,description,permissions"),
        ZL.select("company_invites", "id,role,note,created_at,expires_at,accepted_at,revoked_at", (q) => q.eq("company_id", cid()).order("created_at", { ascending: false }).limit(20)),
      ]);
      const now = new Date().toISOString();
      const inviteState = (i) => i.accepted_at ? ["Used", "ok"] : i.revoked_at ? ["Cancelled", ""] : i.expires_at <= now ? ["Expired", ""] : ["Open", "warn"];
      const profiles = members.length ? await ZL.select("profiles", "id,full_name,email", (q) => q.in("id", members.map((m) => m.user_id))) : [];
      const prof = new Map(profiles.map((x) => [x.id, x]));
      roles.sort((a, b) => ROLE_ORDER.indexOf(a.name) - ROLE_ORDER.indexOf(b.name));
      const canEdit = ZL.can("user.edit"), canDel = ZL.can("user.delete"), canAdd = ZL.can("user.create");
      const roleSelect = (m) => `<select class="zl-role" data-role-of="${m.user_id}" aria-label="Role">${roles.map((r) =>
        `<option value="${r.name}"${r.name === m.role ? " selected" : ""}>${ROLE_NAME[r.name] || r.name}</option>`).join("")}</select>`;
      return ZL.header(P ? "Sharing" : "Users & roles",
          P ? "People you trust with your books — a partner, or an accountant at tax time." : "Who can open these books, and what each role may do.",
          canAdd ? btn("zl-uadd", P ? "+ Share" : "+ Invite someone", "primary") : "") + `
        <section class="card"><div class="tablewrap"><table>
          <thead><tr><th>Person</th><th>Role</th><th>Added</th><th></th></tr></thead>
          <tbody>${members.map((m) => {
            const x = prof.get(m.user_id) || {};
            const me = m.user_id === ZL.user.id;
            return `<tr>
              <td><div class="zl-person"><span class="zl-av">${E(initials(x.full_name || x.email))}</span><span><b>${E(x.full_name || "—")}${me ? ' <span class="chip">You</span>' : ""}</b><small>${E(x.email || "")}</small></span></div></td>
              <td>${canEdit ? roleSelect(m) : `<span class="chip">${E(ROLE_NAME[m.role] || m.role)}</span>`}</td>
              <td class="nil" style="white-space:nowrap">${ZL.date(m.created_at)}</td>
              <td class="r">${canDel ? `<button type="button" class="zl-btn sm ghost" data-remove-member="${m.user_id}" data-name="${E(x.full_name || x.email || "")}" style="color:var(--bad)">${me ? "Leave" : "Remove"}</button>` : ""}</td></tr>`;
          }).join("")}</tbody>
        </table></div></section>
        ${invites.length ? `<section class="card">
          <header><div><h3>Invite links</h3><p>Each link works once and expires after 7 days.</p></div></header>
          <div class="tablewrap"><table><tbody>${invites.map((i) => { const [label, tone] = inviteState(i); return `<tr>
            <td><b style="font-weight:500">${E(ROLE_NAME[i.role] || i.role)}</b>${i.note ? ` <span class="hint">· ${E(i.note)}</span>` : ""}</td>
            <td class="nil" style="white-space:nowrap">Created ${ZL.date(i.created_at)}</td>
            <td><span class="chip ${tone}">${label}${label === "Open" ? " until " + ZL.date(i.expires_at) : ""}</span></td>
            <td class="r">${label === "Open" && canAdd ? `<button type="button" class="zl-btn sm ghost" data-revoke="${i.id}">Cancel</button>` : ""}</td></tr>`; }).join("")}</tbody></table></div>
        </section>` : ""}
        <section class="card">
          <header><div><h3>What each role can do</h3><p>Permissions are checked by the database on every action, not just hidden in the screen.</p></div></header>
          <div class="zl-roles">${roles.map((r) => `<details><summary><b>${ROLE_NAME[r.name] || r.name}</b><span>${E(r.description)} · ${r.permissions.length} permission${r.permissions.length === 1 ? "" : "s"}</span></summary>
            <div class="perms">${r.permissions.map((x) => `<span class="chip">${E(x)}</span>`).join("")}</div></details>`).join("")}</div>
        </section>`;
    },
    after(root) {
      const add = root.querySelector("#zl-uadd");
      if (add) add.addEventListener("click", () => ZL.invite(cid(), ZL.company.name, "Accountant"));
      root.querySelectorAll("[data-revoke]").forEach((b) => b.addEventListener("click", async () => {
        if (!(await ZL.confirm({ title: "Cancel this invite?", message: "The link stops working straight away.", confirmLabel: "Cancel invite", danger: true }))) return;
        try {
          await ZL.rpc("revoke_invite", { p_id: b.dataset.revoke });
          ZL.toast("Invite cancelled.");
          ZL.refresh();
        } catch (e) { ZL.toast(ZL.errorText(e), "bad"); }
      }));
      root.querySelectorAll("[data-role-of]").forEach((sel) => {
        const was = sel.value;
        sel.addEventListener("change", async () => {
          const me = sel.dataset.roleOf === ZL.user.id;
          if (me && !(await ZL.confirm({ title: "Change your own role?", message: "You may lose access to parts of these books straight away.", confirmLabel: "Change my role" }))) { sel.value = was; return; }
          try {
            await ZL.rpc("update_member_role", { p_company: cid(), p_user: sel.dataset.roleOf, p_role: sel.value });
            ZL.toast("Role updated.");
            if (me) { location.reload(); return; }
            ZL.refresh();
          } catch (e) { sel.value = was; ZL.toast(ZL.errorText(e), "bad"); }
        });
      });
      root.querySelectorAll("[data-remove-member]").forEach((b) => b.addEventListener("click", async () => {
        const me = b.dataset.removeMember === ZL.user.id;
        if (!(await ZL.confirm({ title: me ? "Leave these books?" : `Remove ${b.dataset.name}?`, message: me ? "You'll lose access until someone adds you again." : "They'll lose access to these books straight away. Their past entries stay in the ledger and the audit trail.", confirmLabel: me ? "Leave" : "Remove", danger: true }))) return;
        try {
          await ZL.rpc("remove_member", { p_company: cid(), p_user: b.dataset.removeMember });
          ZL.toast(me ? "You left these books." : "Removed.");
          if (me) { try { localStorage.removeItem("zl.company"); } catch (_) { /* ignore */ } location.reload(); return; }
          ZL.refresh();
        } catch (e) { ZL.toast(ZL.errorText(e), "bad"); }
      }));
    },
  });

  // ══ Settings ══════════════════════════════════════════════════════════════
  ZL.register("settings", {
    title: "Settings",
    perm: "company.view",
    async render() {
      const P = ZL.isPersonal();
      const info = await ZL.companyInfo(true);
      const canEdit = ZL.can("company.edit");
      const f = (name, label, value, opts = {}) => `<label class="zl-field${opts.half ? " half" : ""}"><span>${label}</span>
        ${opts.area ? `<textarea class="zl-input" name="${name}" rows="3"${canEdit ? "" : " disabled"}>${E(value || "")}</textarea>`
          : `<input class="zl-input" name="${name}" value="${E(value || "")}"${opts.type ? ` type="${opts.type}"` : ""}${canEdit ? "" : " disabled"}${opts.ph ? ` placeholder="${E(opts.ph)}"` : ""}>`}</label>`;
      return ZL.header("Settings", ZL.company.name) + `
        <section class="card">
          <div class="zl-set">
            <div><h3>${P ? "These books" : "Company"}</h3><p>${P ? "The name shown on your reports." : "Printed on every statement's letterhead."}${canEdit ? "" : " Your role can't change these."}</p></div>
            <form class="zl-form" id="zl-coform" autocomplete="off">
              ${f("name", P ? "Name" : "Company name", info.name)}
              ${P ? "" : f("reg", "Registration no.", info.registration_no, { half: true, ph: "202601012345 (1234567-X)" }) + f("tax", "SST registration no.", info.tax_registration_no, { half: true })}
              ${P ? "" : f("email", "Email", info.email, { half: true, type: "email" }) + f("phone", "Phone", info.phone, { half: true })}
              ${P ? "" : f("address", "Address", info.address, { area: true })}
              <div class="zl-field half"><span>Currency</span><input class="zl-input" value="${E(info.base_currency)} — Ringgit Malaysia" disabled></div>
              <div class="zl-field half"><span>Financial year starts</span><input class="zl-input" value="1 January" disabled></div>
              ${canEdit ? `<div><button type="submit" class="zl-btn primary">Save changes</button></div>` : ""}
            </form>
          </div>
          ${P ? "" : `<div class="zl-set">
            <div><h3>e-Invoice (LHDN)</h3><p>Connect MyInvois to send invoices, credit notes and debit notes to LHDN and print the validation QR.</p></div>
            <div><button type="button" class="zl-btn" id="zl-to-einv">Set up e-Invoice</button></div>
          </div>`}
          <div class="zl-set">
            <div><h3>Your profile</h3><p>Your name appears on the journals you create and in the audit trail.</p></div>
            <form class="zl-form" id="zl-meform" autocomplete="off">
              <label class="zl-field"><span>Full name</span><input class="zl-input" name="full_name" value="${E(ZL.user.name)}" maxlength="100"></label>
              <label class="zl-field"><span>Email</span><input class="zl-input" value="${E(ZL.user.email)}" disabled></label>
              <div><button type="submit" class="zl-btn">Save name</button></div>
            </form>
          </div>
          <div class="zl-set">
            <div><h3>Password</h3><p>At least 8 characters, with a letter and a number.</p></div>
            <form class="zl-form" id="zl-pwform" autocomplete="off">
              <label class="zl-field half"><span>New password</span><input class="zl-input" name="pw" type="password" autocomplete="new-password"></label>
              <label class="zl-field half"><span>Type it again</span><input class="zl-input" name="pw2" type="password" autocomplete="new-password"></label>
              <div class="zl-actions"><button type="submit" class="zl-btn">Change password</button>
                <button type="button" class="zl-btn ghost" id="zl-signout-all">Sign out on all devices</button></div>
            </form>
          </div>
          <div class="zl-set">
            <div><h3>Your books</h3><p>Keep business and personal money apart — switch between them from the top bar.</p></div>
            <div>
              <div class="zl-roles" style="border:1px solid var(--line);border-radius:10px;overflow:hidden">${ZL.companies.map((c) => `
                <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid var(--line-2)">
                  <span><b style="font-weight:500">${E(c.name)}</b><small style="display:block;color:var(--ink-3);font-size:12.5px">${c.kind === "PERSONAL" ? "Personal" : "Business"} · ${E(ROLE_NAME[c.role] || c.role)}</small></span>
                  ${c.company_id === ZL.company.company_id ? '<span class="chip ok">Open now</span>' : `<button type="button" class="zl-btn sm" data-switch="${c.company_id}">Open</button>`}
                </div>`).join("")}</div>
              <p style="margin-top:12px"><button type="button" class="zl-btn" id="zl-newbooks">+ New set of books</button></p>
            </div>
          </div>
        </section>`;
    },
    after(root) {
      const errAfter = (form, e) => {
        form.querySelectorAll(".zl-err").forEach((x) => x.remove());
        if (e) form.insertAdjacentHTML("beforeend", ZL.errorBox(e));
      };
      const busy = (form, on) => form.querySelectorAll("button").forEach((b) => { b.disabled = on; });
      const einv = root.querySelector("#zl-to-einv");
      if (einv) einv.addEventListener("click", () => ZL.open("einvoice", {}));
      const co = root.querySelector("#zl-coform");
      co.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        if (!ZL.can("company.edit")) return;
        const v = (n) => { const el = co.querySelector(`[name="${n}"]`); return el ? el.value.trim() : null; };
        const info = await ZL.companyInfo();
        busy(co, true); errAfter(co);
        try {
          await ZL.rpc("update_company", {
            p_company: cid(), p_name: v("name"), p_registration_no: v("reg") ?? info.registration_no, p_tax_no: v("tax") ?? info.tax_registration_no,
            p_email: v("email") ?? info.email, p_phone: v("phone") ?? info.phone, p_address: v("address") ?? info.address,
          });
          ZL.companies = await ZL.rpc("my_companies");
          ZL.company = ZL.companies.find((c) => c.company_id === cid()) || ZL.company;
          ZL.invalidate();
          ZL.applyChrome();
          ZL.toast("Saved.");
          ZL.refresh();
        } catch (e) { errAfter(co, e); busy(co, false); }
      });
      const me = root.querySelector("#zl-meform");
      me.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const name = me.querySelector('[name="full_name"]').value.trim();
        errAfter(me);
        if (name.length < 2) { errAfter(me, new ZL.ZLError("VALIDATION", "Enter your name.")); return; }
        busy(me, true);
        try {
          const { error } = await ZL.sb.from("profiles").update({ full_name: name }).eq("id", ZL.user.id);
          if (error) throw error;
          const { error: e2 } = await ZL.sb.auth.updateUser({ data: { full_name: name } });
          if (e2) throw e2;
          ZL.user.name = name;
          ZL.applyChrome();
          ZL.toast("Name saved.");
        } catch (e) { errAfter(me, e); }
        busy(me, false);
      });
      const pw = root.querySelector("#zl-pwform");
      pw.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const a = pw.querySelector('[name="pw"]').value, b = pw.querySelector('[name="pw2"]').value;
        errAfter(pw);
        if (a.length < 8 || a.length > 72 || !/[A-Za-z]/.test(a) || !/\d/.test(a)) { errAfter(pw, new ZL.ZLError("VALIDATION", "Use 8–72 characters, including a letter and a number.")); return; }
        if (a !== b) { errAfter(pw, new ZL.ZLError("VALIDATION", "The two passwords don't match.")); return; }
        busy(pw, true);
        try {
          const { error } = await ZL.sb.auth.updateUser({ password: a });
          if (error) throw error;
          pw.reset();
          ZL.toast("Password changed.");
        } catch (e) {
          const msg = String(e.message || "");
          errAfter(pw, /different from the old|same/i.test(msg) ? new ZL.ZLError("VALIDATION", "Choose a password you haven't used here before.")
            : /reauth|recent/i.test(msg) ? new ZL.ZLError("AUTH_REQUIRED", "For safety, sign out and back in, then change your password.") : e);
        }
        busy(pw, false);
      });
      root.querySelector("#zl-signout-all").addEventListener("click", async () => {
        if (!(await ZL.confirm({ title: "Sign out everywhere?", message: "Every browser and device signed in to your account will be signed out, including this one.", confirmLabel: "Sign out everywhere" }))) return;
        try { await ZL.sb.auth.signOut({ scope: "global" }); } catch (_) { /* ignore */ }
        ZL.signOut();
      });
      root.querySelectorAll("[data-switch]").forEach((b) => b.addEventListener("click", () => ZL.switchCompany(b.dataset.switch)));
      root.querySelector("#zl-newbooks").addEventListener("click", () => ZL.createCompany());
    },
  });

  // ══ Admin console (Zycount platform administrators only) ══════════════════
  ZL.register("admin", {
    title: "Admin console",
    platform: true,
    async render(ctx) {
      if (!ZL.platformAdmin) return ZL.noAccess("Admin console", "platform administrator");
      const p = ctx.params;
      const tab = p.tab || "books";
      const [ov, books, users] = await Promise.all([ZL.rpc("admin_overview"), ZL.rpc("admin_companies"), ZL.rpc("admin_users")]);
      const term = String(p.q || "").trim().toLowerCase();
      const hit = (...xs) => !term || xs.some((x) => String(x || "").toLowerCase().includes(term));
      const b = books.filter((c) => hit(c.name, c.owner_email, c.kind));
      const u = users.filter((x) => hit(x.email, x.full_name));
      const kpi = (label, v, sub) => `<div class="kpi"><div class="klbl">${label}</div><div class="kval num">${Number(v || 0).toLocaleString("en-MY")}</div><div class="hint">${sub}</div></div>`;
      const seg = [["books", `Books (${books.length})`], ["users", `Users (${users.length})`]].map(([v, l]) =>
        `<button type="button" data-atab="${v}" aria-pressed="${tab === v}">${l}</button>`).join("");
      return ZL.header("Admin console", "Every user and set of books on Zycount. You have owner rights in all of them.",
          `<button type="button" class="zl-btn primary" id="zl-anew">+ New client books</button>`) + `
        <div class="kpi-head zl-kpis">
          ${kpi("Users", ov.users, `${ov.signups_30d} joined in 30 days`)}
          ${kpi("Business books", ov.business, "Companies")}
          ${kpi("Personal books", ov.personal, "Households")}
          ${kpi("Posted entries", ov.posted, `${ov.posted_30d} in 30 days`)}
        </div>
        <div class="toolbar">
          <div class="seg" role="group" aria-label="Show">${seg}</div>
          <label class="field in"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>
            <input id="zl-aq" type="search" value="${E(p.q || "")}" placeholder="${tab === "books" ? "Name or owner email" : "Email or name"}" aria-label="Search"></label>
        </div>
        <section class="card"><div class="tablewrap"><table>
        ${tab === "books" ? `<thead><tr><th>Books</th><th>Type</th><th>Owner</th><th class="r">People</th><th class="r">Posted</th><th>Last entry</th><th>Created</th><th></th></tr></thead>
          <tbody>${b.map((c) => `<tr>
            <td style="font-weight:500">${E(c.name)}</td>
            <td><span class="chip">${c.kind === "PERSONAL" ? "Personal" : "Business"}</span></td>
            <td class="nil">${E(c.owner_email || "—")}</td>
            <td class="r num">${c.members}</td><td class="r num">${c.posted}</td>
            <td class="nil">${c.last_entry ? ZL.date(c.last_entry) : "—"}</td>
            <td class="nil" style="white-space:nowrap">${ZL.date(c.created_at)}</td>
            <td class="r" style="white-space:nowrap"><button type="button" class="zl-btn sm ghost" data-ainvite="${c.id}" data-name="${E(c.name)}">Invite</button>
              <button type="button" class="zl-btn sm" data-aopen="${c.id}">Open</button></td></tr>`).join("")
            || `<tr><td colspan="8" class="nil">Nothing matches.</td></tr>`}</tbody>`
        : `<thead><tr><th>Person</th><th>Signed up</th><th>Last sign-in</th><th class="r">Books</th><th></th></tr></thead>
          <tbody>${u.map((x) => `<tr>
            <td><div style="font-weight:500">${E(x.full_name || x.email)}</div>${x.full_name ? `<div class="hint">${E(x.email)}</div>` : ""}</td>
            <td class="nil" style="white-space:nowrap">${ZL.date(x.created_at)}</td>
            <td class="nil" style="white-space:nowrap">${x.last_sign_in_at ? ZL.dateTime(x.last_sign_in_at) : "Never"}</td>
            <td class="r num">${x.books}</td>
            <td>${x.is_admin ? '<span class="chip ok">Platform admin</span>' : ""}</td></tr>`).join("")
            || `<tr><td colspan="5" class="nil">Nothing matches.</td></tr>`}</tbody>`}
        </table></div>
        <div class="proofrow"><span>Set up a client: <b>New client books</b>, then <b>Invite</b> to send the owner a one-time link. Opening a client's books is written to their audit trail.</span></div></section>`;
    },
    after(root, ctx) {
      const p = ctx.params;
      root.querySelectorAll("[data-atab]").forEach((b) => b.addEventListener("click", () => ZL.open("admin", Object.assign({}, p, { tab: b.dataset.atab }))));
      const q = root.querySelector("#zl-aq");
      if (q) {
        q.addEventListener("input", ZL.debounce(() => ZL.open("admin", Object.assign({}, p, { q: q.value, focus: "q" })), 300));
        if (p.focus === "q") { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      }
      root.querySelectorAll("[data-aopen]").forEach((b) => b.addEventListener("click", async () => {
        const id = b.dataset.aopen;
        if (!ZL.companies.some((c) => c.company_id === id)) ZL.companies = await ZL.rpc("my_companies");
        ZL.switchCompany(id);
        go("dashboard");
      }));
      root.querySelectorAll("[data-ainvite]").forEach((b) => b.addEventListener("click", () => ZL.invite(b.dataset.ainvite, b.dataset.name, "SuperAdmin")));
      const add = root.querySelector("#zl-anew");
      if (add) add.addEventListener("click", () => ZL.createCompany());
    },
  });
})();
