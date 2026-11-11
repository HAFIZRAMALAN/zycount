/* ═══════════════════════════════════════════════════════════════════════════
 * Zycount live workspace — maker-checker approvals.
 *
 * When a company turns approvals on, money going out (purchase invoices, cash
 * purchases, supplier debit notes and payments, PV vouchers) and manual
 * journals above its threshold are held when the maker posts them. Someone
 * else with posting rights approves (it posts, keeping the maker's number or
 * one the checker types) or rejects with a reason. The rules live in the
 * database (maker_checker migration); this file is the queue and the banners.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const ZL = window.ZL;
  const E = ZL.esc;
  const M = ZL.money;
  const cid = () => ZL.company.company_id;
  const me = () => (ZL.user && ZL.user.id) || "";

  const LABEL = { BILL: "Purchase invoice", CASH_PURCHASE: "Cash purchase", SUPPLIER_DN: "Supplier debit note", PAYMENT: "Payment",
    PV: "Payment voucher", JV: "Journal" };

  ZL.pendingMsg = () => "Sent for approval — someone else who can post approves it under Approvals.";

  /** The banner on a held or rejected document or journal, with what this person may do. */
  ZL.approvalBanner = (kind, x) => {
    if (!x || !x.approval_status || x.status !== "DRAFT") return "";
    if (x.approval_status === "REJECTED") {
      return `<div class="zl-banner" style="margin-bottom:14px"><b>Rejected</b> — ${E(x.approval_note || "")}. Fix it and post again to send it back for approval.</div>`;
    }
    if (x.approval_status !== "PENDING") return "";
    const mine = x.submitted_by === me();
    const b = (act, label, cls = "") => `<button type="button" class="zl-btn sm ${cls}" data-apr="${act}" data-kind="${kind}" data-id="${x.id}">${label}</button>`;
    const btns = [];
    if (ZL.can("journal.post") && !mine) btns.push(b("approve", "Approve &amp; post", "primary"), b("reject", "Reject"));
    if (ZL.can("journal.create")) btns.push(b("withdraw", "Withdraw to edit", "ghost"));
    return `<div class="zl-banner info" data-apr-banner style="margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span style="flex:1;min-width:220px"><b>Waiting for approval</b> since ${E(ZL.dateTime ? ZL.dateTime(x.submitted_at) : x.submitted_at)}.
        ${mine ? "You sent it — someone else who can post has to approve it." : "Check it, then approve or reject."}
        ${x.draft_doc_no || x.draft_reference ? ` Number on posting: <b>${E(x.draft_doc_no || x.draft_reference)}</b>.` : ""}</span>${btns.join("")}</div>`;
  };

  async function act(action, kind, id, row) {
    if (action === "approve") {
      const cur = row ? row.number || "" : "";
      const r = await ZL.form({ title: "Approve and post", confirmLabel: "Approve & post",
        intro: `It posts now${row ? ` — ${E(LABEL[row.doc_type] || row.doc_type)}, RM ${M(row.amount)}` : ""}. Keep the number the maker chose, or type the one your company uses.`,
        fields: [{ name: "number", label: "Number (blank = the maker's choice, or the next in the series)", value: cur, placeholder: "e.g. PV-2026-0042" }],
        submit: (v) => ZL.rpc("approve_submission", { p_kind: kind, p_id: id, p_series: null, p_number: v.number || null }) });
      if (r) { ZL.toast(`Approved and posted${r.doc_no ? ` as ${r.doc_no}` : ""}${r.reference ? ` (${r.reference})` : ""}.`); ZL.refresh(); }
      return r;
    }
    if (action === "reject") {
      const r = await ZL.form({ title: "Reject", confirmLabel: "Reject", danger: true,
        intro: "It goes back to the maker as a draft, with your reason.",
        fields: [{ name: "reason", label: "Reason", required: true, placeholder: "e.g. Wrong account — use 6110" }],
        submit: (v) => ZL.rpc("reject_submission", { p_kind: kind, p_id: id, p_reason: v.reason }) });
      if (r) { ZL.toast("Rejected and sent back."); ZL.refresh(); }
      return r;
    }
    if (action === "withdraw") {
      if (!await ZL.confirm({ title: "Withdraw from approval?", message: "It becomes an ordinary draft you can edit. Posting it again sends it back for approval.", confirmLabel: "Withdraw" })) return null;
      const r = await ZL.rpc("withdraw_submission", { p_kind: kind, p_id: id });
      ZL.toast("Withdrawn — you can edit it now.");
      ZL.refresh();
      return r;
    }
    return null;
  }

  ZL.wireApproval = (root, rows) => root.querySelectorAll("[data-apr]").forEach((b) => b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    act(b.dataset.apr, b.dataset.kind, b.dataset.id, (rows || []).find((r) => r.id === b.dataset.id));
  }));

  // ── The queue, and the settings ───────────────────────────────────────────
  ZL.register("approvals", {
    title: "Approvals",
    perm: "journal.view",
    business: true,
    async render(ctx) {
      const [rows, [co]] = await Promise.all([ZL.rpc("approval_queue", { p_company: cid() }),
        ZL.select("companies", "approval_enabled,approval_threshold", (q) => q.eq("id", cid()))]);
      ctx.rows = rows;
      const pending = rows.filter((r) => r.approval_status === "PENDING"), rejected = rows.filter((r) => r.approval_status === "REJECTED");
      const on = co && co.approval_enabled;
      const settings = ZL.can("company.edit") ? `<section class="card" style="margin-bottom:16px"><div class="zl-sec-h"><h3>Maker-checker</h3>
          <span class="hint">Money going out and manual journals above the amount need a second person to approve before they post.</span></div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:end">
          <label class="zl-check"><input type="checkbox" id="zl-apon"${on ? " checked" : ""}><span>Approvals on</span></label>
          <label class="zl-field"><span>Above (RM)</span><div class="zl-amount"><span>RM</span><input class="zl-input num" id="zl-apth" inputmode="decimal" value="${E(M(co ? co.approval_threshold : 5000))}"></div></label>
          <button type="button" class="zl-btn" id="zl-apsave">Save</button></div>
        <p class="hint" style="margin:8px 0 0">Covers purchase invoices, cash purchases, supplier debit notes, supplier payments, payment vouchers (PV) and manual journals.
          Sales are not held. Recording from a bank statement is not held — the money has already moved.</p></section>`
        : `<div class="zl-banner${on ? " info" : ""}" style="margin-bottom:14px">${on ? `Approvals are on, above RM ${M(co.approval_threshold)}.` : "Approvals are off for these books."}</div>`;
      const row = (r) => `<tr class="click" data-open="${r.kind}:${r.id}">
          <td>${E(LABEL[r.doc_type] || r.doc_type)}</td><td class="mono">${E(r.number || "")}</td><td>${E(r.party || "")}</td>
          <td>${E(ZL.date(r.date))}</td><td class="r num">${M(r.amount)}</td>
          <td>${E(r.submitted_name || "")}${r.mine ? ' <span class="hint">(you)</span>' : ""}</td>
          <td>${r.approval_status === "PENDING"
            ? `${ZL.can("journal.post") && !r.mine ? `<button type="button" class="zl-btn sm primary" data-apr="approve" data-kind="${r.kind}" data-id="${r.id}">Approve</button>
               <button type="button" class="zl-btn sm" data-apr="reject" data-kind="${r.kind}" data-id="${r.id}">Reject</button>` : ""}
               ${r.mine ? `<button type="button" class="zl-btn sm ghost" data-apr="withdraw" data-kind="${r.kind}" data-id="${r.id}">Withdraw</button>` : ""}`
            : `<span class="hint">Rejected: ${E(r.note || "")}</span>`}</td></tr>`;
      const table = (list) => `<section class="card"><div class="tablewrap"><table>
          <thead><tr><th>Type</th><th>Number</th><th>Party / description</th><th>Date</th><th class="r">Amount (RM)</th><th>Sent by</th><th></th></tr></thead>
          <tbody>${list.map(row).join("")}</tbody></table></div></section>`;
      return ZL.header("Approvals", "What is waiting for a second person, and what was sent back.") + settings +
        (pending.length ? `<h3 style="margin:8px 0">Waiting (${pending.length})</h3>${table(pending)}` : ZL.empty("Nothing waiting", on ? "Held documents and journals show here." : "Turn approvals on to hold money going out for a second person.")) +
        (rejected.length ? `<h3 style="margin:18px 0 8px">Sent back (${rejected.length})</h3>${table(rejected)}` : "");
    },
    after(root, ctx) {
      ZL.wireApproval(root, ctx.rows);
      root.querySelectorAll("[data-open]").forEach((tr) => tr.addEventListener("click", () => {
        const [k, id] = tr.dataset.open.split(":");
        ZL.open(k === "DOC" ? "tradedoc" : "journal", { id });
      }));
      const save = root.querySelector("#zl-apsave");
      if (save) save.addEventListener("click", async () => {
        const th = ZL.parseAmount(root.querySelector("#zl-apth").value);
        if (Number.isNaN(th) || th < 0) { ZL.toast("Enter an amount like 5,000.00.", "bad"); return; }
        try {
          const r = await ZL.rpc("set_approval_settings", { p_company: cid(), p_enabled: root.querySelector("#zl-apon").checked, p_threshold: th });
          ZL.toast(r.enabled ? `Approvals on, above RM ${M(r.threshold)}.` : "Approvals off.");
          ZL.refresh();
        } catch (e) { ZL.toast(ZL.errorText ? ZL.errorText(e) : e.message, "bad"); }
      });
    },
  });
})();
