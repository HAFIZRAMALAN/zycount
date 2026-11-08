/* ═══════════════════════════════════════════════════════════════════════════
 * Zycount live workspace — inventory (Phase 3.2).
 *
 * Stock on hand with weighted-average cost, a stock card per item, warehouses,
 * and the stock documents: adjustment, stock count, opening stock and transfer.
 * The database does all costing and posting (phase3_2_inventory migration):
 * purchases of stock items post to Inventory, sales post cost of goods sold,
 * and the stock value is checked against the inventory account every time.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const ZL = window.ZL;
  const E = ZL.esc;
  const M = ZL.money;
  const cid = () => ZL.company.company_id;
  const bad = (msg) => new ZL.ZLError("VALIDATION", msg);
  const Q = (n) => { const x = Number(n || 0); return x.toLocaleString("en-MY", { maximumFractionDigits: 4 }); };

  const KIND = {
    PURCHASE: "Purchase", PURCHASE_RETURN: "Return to supplier", SALE: "Sale", SALE_RETURN: "Customer return",
    ADJUSTMENT: "Adjustment", COUNT: "Stock count", OPENING: "Opening stock", TRANSFER: "Transfer", VOID: "Voided",
  };
  const DOCKIND = { ADJUSTMENT: "Adjustment", COUNT: "Stock count", OPENING: "Opening stock", TRANSFER: "Transfer" };

  const warehouses = () => ZL.select("warehouses", "*", (q) => q.eq("company_id", cid()).order("is_default", { ascending: false }).order("code"));
  const stockItems = () => ZL.select("items", "id,code,description,uom,buy_price,is_active,inventory_account_id",
    (q) => q.eq("company_id", cid()).eq("track_stock", true).order("code"));

  /** Every set of books gets a default warehouse the first time it is needed. */
  async function ensureWarehouses() {
    let w = await warehouses();
    if (!w.length && ZL.can("company.edit")) {
      await ZL.rpc("save_warehouse", { p_company: cid(), p_id: null, p_data: { code: "MAIN", name: "Main store", is_default: true } });
      w = await warehouses();
    }
    return w;
  }
  ZL.warehouses = warehouses;

  // ── Multi-line stock document (adjustment / count / opening / transfer) ──
  ZL.stockDoc = async (kind, preset = {}) => {
    if (!ZL.can("journal.post")) { ZL.toast("Your role can't post stock documents.", "bad"); return null; }
    const [whs, list, accounts] = await Promise.all([ensureWarehouses(), stockItems(), ZL.accounts()]);
    const items = list.filter((i) => i.is_active);
    if (!items.length) { ZL.toast("No stock items yet. Edit an item and tick “Track stock”.", "bad"); return null; }
    const live = whs.filter((w) => w.is_active);
    const def = (live.find((w) => w.is_default) || live[0] || {}).id;
    const T = kind === "TRANSFER", C = kind === "COUNT", O = kind === "OPENING";
    const offDefault = (accounts.find((a) => a.code === (O ? "3200" : "5500") && a.is_postable && a.is_active) || {}).id || "";
    const offOpts = accounts.filter((a) => a.is_postable && a.is_active && !a.is_control && !a.is_cash)
      .map((a) => `<option value="${a.id}"${a.id === offDefault ? " selected" : ""}>${E(a.code)} · ${E(a.name)}</option>`).join("");
    const whOpts = (sel) => live.map((w) => `<option value="${w.id}"${w.id === sel ? " selected" : ""}>${E(w.name)} (${E(w.code)})</option>`).join("");
    const itemOpts = (sel) => `<option value="">Choose item…</option>` + items.map((i) => `<option value="${i.id}"${i.id === sel ? " selected" : ""}>${E(i.code)} · ${E(i.description)}</option>`).join("");
    let rows = (preset.lines && preset.lines.length) ? preset.lines.map((l) => Object.assign({}, l)) : [{}, {}, {}];
    let onHand = new Map();
    const title = { ADJUSTMENT: "Adjust stock", COUNT: "Stock count", OPENING: "Opening stock", TRANSFER: "Transfer stock" }[kind];
    const intro = {
      ADJUSTMENT: "For damaged, lost, sample or found stock. Enter a minus quantity to take stock out. It posts to the account you choose (normally 5500 Inventory Adjustment).",
      COUNT: "Type what you physically counted. Zycount adjusts each item by the difference and posts it.",
      OPENING: "Stock you already had when you started using Zycount, with what each unit cost.",
      TRANSFER: "Moves stock between your own stores. The value doesn't change, so there's no journal.",
    }[kind];
    const qtyHead = C ? "Counted" : T ? "Qty to move" : O ? "Qty" : "Qty (+ in / − out)";
    const body = `<p class="hint" style="margin:0 0 12px">${E(intro)}</p>
      <div class="zl-form">
        <label class="zl-field half"><span>Date</span><input class="zl-input" type="date" name="date" value="${E(ZL.today())}"></label>
        <label class="zl-field half"><span>${T ? "From" : "Warehouse"}</span><select class="zl-input" name="wh">${whOpts(preset.warehouse_id || def)}</select></label>
        ${T ? `<label class="zl-field half"><span>To</span><select class="zl-input" name="to">${whOpts((live.find((w) => w.id !== (preset.warehouse_id || def)) || {}).id)}</select></label>`
            : `<label class="zl-field half"><span>Other side of the entry</span><select class="zl-input" name="off">${offOpts}</select></label>`}
        <label class="zl-field${T ? " half" : ""}"><span>Description</span><input class="zl-input" name="desc" maxlength="500" placeholder="${T ? "e.g. Restock branch" : C ? "e.g. Month-end count" : "Optional"}"></label>
      </div>
      <div class="zl-lines-wrap" style="margin-top:10px"><table class="zl-lines"><thead><tr>
        <th style="min-width:260px">Item</th><th class="r" style="width:110px">On hand</th><th class="r" style="width:130px">${qtyHead}</th>
        ${T || C ? "" : `<th class="r" style="width:130px">Unit cost${O ? "" : " (if adding)"}</th>`}<th style="width:30px"></th></tr></thead>
        <tbody id="zl-sl"></tbody></table></div>
      <button type="button" class="zl-btn sm ghost" id="zl-sladd" style="margin-top:8px">+ Add line</button>`;
    let result = null;
    const read = (root) => { root.querySelectorAll("[data-sl]").forEach((tr) => { const r = rows[+tr.dataset.sl];
      r.item_id = tr.querySelector("[data-f=item]").value; r.qty = tr.querySelector("[data-f=qty]").value;
      const c = tr.querySelector("[data-f=cost]"); if (c) r.unit_cost = c.value; }); };
    const loadOnHand = async (root) => {
      const wh = root.querySelector('[name="wh"]').value;
      const sb = await ZL.select("stock_balances", "item_id,qty", (q) => q.eq("company_id", cid()).eq("warehouse_id", wh));
      onHand = new Map(sb.map((b) => [b.item_id, Number(b.qty)]));
    };
    const draw = (root) => {
      root.querySelector("#zl-sl").innerHTML = rows.map((r, i) => `<tr data-sl="${i}">
        <td><select class="zl-input" data-f="item" aria-label="Item">${itemOpts(r.item_id)}</select></td>
        <td class="r num nil">${r.item_id ? Q(onHand.get(r.item_id) || 0) : ""}</td>
        <td><input class="zl-input num r" data-f="qty" inputmode="decimal" value="${E(r.qty == null ? "" : r.qty)}" aria-label="${E(qtyHead)}"></td>
        ${T || C ? "" : `<td><input class="zl-input num r" data-f="cost" inputmode="decimal" placeholder="${O ? "0.00" : "average"}" value="${E(r.unit_cost == null ? "" : r.unit_cost)}" aria-label="Unit cost"></td>`}
        <td><button type="button" class="iconbtn" data-sdel aria-label="Remove line">×</button></td></tr>`).join("");
    };
    const m = ZL.modal({ title, wide: true, body,
      actions: [{ label: "Cancel" }, { label: T ? "Transfer" : "Post", primary: true, onClick: async ({ root, close }) => {
        read(root);
        const v = (n) => { const el = root.querySelector(`[name="${n}"]`); return el ? el.value.trim() : ""; };
        const lines = rows.filter((r) => r.item_id || String(r.qty || "").trim()).map((r) => {
          const it = items.find((i) => i.id === r.item_id);
          if (!it) throw bad("Choose an item on every line, or remove the empty line.");
          const q = ZL.parseAmount(r.qty);
          if (Number.isNaN(q) || String(r.qty || "").trim() === "") throw bad(`${it.code}: enter a quantity.`);
          if ((T || O) && q <= 0) throw bad(`${it.code}: the quantity must be above zero.`);
          if (C && q < 0) throw bad(`${it.code}: a count can't be below zero.`);
          const out = { item_id: it.id };
          if (C) out.counted = q; else out.qty = q;
          if (!T && !C && String(r.unit_cost || "").trim() !== "") {
            const c = ZL.parseAmount(r.unit_cost);
            if (Number.isNaN(c) || c < 0) throw bad(`${it.code}: enter a cost like 12.50.`);
            out.unit_cost = c;
          } else if (O) throw bad(`${it.code}: enter what each unit cost.`);
          return out;
        });
        if (!lines.length) throw bad("Add at least one item.");
        const data = { kind, date: v("date"), warehouse_id: v("wh"), description: v("desc") || null, lines };
        if (T) { data.to_warehouse_id = v("to"); result = await ZL.rpc("post_stock_transfer", { p_company: cid(), p_data: data }); }
        else { data.offset_account_id = v("off") || null; result = await ZL.rpc("post_stock_adjustment", { p_company: cid(), p_data: data }); }
        close();
      } }],
      onClose: () => { if (result) { ZL.toast(`${DOCKIND[kind]} ${result.doc_no} posted${result.reference ? ` (${result.reference})` : ""}.`); ZL.refresh(); } },
    });
    const root = m.root;
    await loadOnHand(root);
    draw(root);
    root.querySelector('[name="wh"]').addEventListener("change", async () => { read(root); await loadOnHand(root); draw(root); });
    root.querySelector("#zl-sladd").addEventListener("click", () => { read(root); rows.push({}); draw(root); });
    root.querySelector("#zl-sl").addEventListener("change", (ev) => { if (ev.target.matches("[data-f=item]")) { read(root); draw(root); } });
    root.querySelector("#zl-sl").addEventListener("click", (ev) => { const d = ev.target.closest("[data-sdel]"); if (!d) return; read(root);
      rows.splice(+d.closest("[data-sl]").dataset.sl, 1); if (!rows.length) rows.push({}); draw(root); });
    return m;
  };

  const actionsBar = () => ZL.can("journal.post") ? `<div class="zl-actions" style="display:flex;gap:8px;flex-wrap:wrap">
      <button type="button" class="zl-btn primary" data-sdoc="ADJUSTMENT">Adjust stock</button>
      <button type="button" class="zl-btn" data-sdoc="COUNT">Stock count</button>
      <button type="button" class="zl-btn" data-sdoc="TRANSFER">Transfer</button>
      <button type="button" class="zl-btn ghost" data-sdoc="OPENING">Opening stock</button></div>` : "";
  const wireActions = (root) => root.querySelectorAll("[data-sdoc]").forEach((b) => b.addEventListener("click", () => ZL.stockDoc(b.dataset.sdoc)));

  // ── Stock on hand ─────────────────────────────────────────────────────────
  ZL.register("stock", {
    title: "Stock on hand",
    perm: "journal.view",
    business: true,
    async render(ctx) {
      const p = ctx.params || {};
      const whs = await ensureWarehouses();
      const [rows, check] = await Promise.all([
        ZL.rpc("stock_on_hand", { p_company: cid(), p_warehouse: p.wh || null }),
        ZL.can("report.view") ? ZL.rpc("stock_gl_check", { p_company: cid() }).catch(() => null) : Promise.resolve(null),
      ]);
      ctx.rows = rows;
      const total = rows.reduce((s, r) => s + ZL.cents(r.value), 0) / 100;
      const low = rows.filter((r) => r.is_active && Number(r.qty) <= 0).length;
      const accs = (check && check.accounts) || [];
      const proof = accs.length ? (check.in_balance
        ? `<div class="zl-banner info" style="margin-bottom:14px">✓ Stock value agrees with the inventory account${accs.length > 1 ? "s" : ""} in the ledger (${accs.map((a) => `${E(a.code)} RM ${M(a.gl_balance)}`).join(", ")}).</div>`
        : `<div class="zl-banner" style="margin-bottom:14px">Stock value and the ledger differ: ${accs.filter((a) => Number(a.difference)).map((a) => `${E(a.code)} ${E(a.name)} — stock RM ${M(a.stock_value)}, ledger RM ${M(a.gl_balance)}`).join("; ")}. This usually means a manual journal posted to the inventory account. Correct it with a stock adjustment or reverse the journal.</div>`) : "";
      return ZL.header("Stock on hand", "What you hold, at weighted-average cost. Buying a stock item adds to it; selling posts the cost of goods sold automatically.", actionsBar()) +
        proof +
        `<div class="zl-toolbar" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
          <label class="field"><span class="hint">Warehouse</span> <select class="zl-input" id="zl-swh"><option value="">All warehouses</option>${whs.map((w) => `<option value="${w.id}"${w.id === p.wh ? " selected" : ""}>${E(w.name)}</option>`).join("")}</select></label>
          <span class="hint">${rows.length} stock item${rows.length === 1 ? "" : "s"} · value <b>RM ${M(total)}</b>${low ? ` · <span style="color:var(--bad)">${low} at or below zero</span>` : ""}</span>
          <button type="button" class="zl-btn sm ghost" id="zl-scsv" style="margin-left:auto">Export CSV</button></div>` +
        (rows.length ? `<section class="card"><div class="tablewrap"><table>
          <thead><tr><th>Code</th><th>Description</th><th>Unit</th><th class="r">On hand</th><th class="r">Average cost</th><th class="r">Value (RM)</th></tr></thead>
          <tbody>${rows.map((r) => `<tr class="click" data-card="${r.item_id}"${r.is_active ? "" : ' style="opacity:.6"'}>
            <td class="mono">${E(r.code)}</td><td>${E(r.description)}</td><td class="nil">${E(r.uom)}</td>
            <td class="r num"${Number(r.qty) <= 0 ? ' style="color:var(--bad)"' : ""}>${Q(r.qty)}</td>
            <td class="r num">${M(r.avg_cost)}</td><td class="r num">${M(r.value)}</td></tr>`).join("")}</tbody>
          <tfoot><tr class="grand"><td colspan="5">Total</td><td class="r num">${M(total)}</td></tr></tfoot></table></div></section>`
          : ZL.empty("No stock items yet", "Open Items & services, edit an item and tick “Track stock”. Then buy it on a purchase invoice, or enter opening stock.",
              `<button type="button" class="zl-btn" onclick="go('items')">Go to items</button>`));
    },
    after(root, ctx) {
      wireActions(root);
      const w = root.querySelector("#zl-swh");
      if (w) w.addEventListener("change", () => ZL.open("stock", { wh: w.value || null }));
      root.querySelectorAll("[data-card]").forEach((tr) => tr.addEventListener("click", () => ZL.open("stockcard", { item: tr.dataset.card })));
      const c = root.querySelector("#zl-scsv");
      if (c) c.addEventListener("click", () => ZL.csv(`stock-on-hand-${ZL.today()}.csv`, [["Code", "Description", "Unit", "On hand", "Average cost", "Value"]]
        .concat((ctx.rows || []).map((r) => [r.code, r.description, r.uom, Number(r.qty), Number(r.avg_cost), Number(r.value)]))));
    },
  });

  // ── Stock card: every movement of one item ───────────────────────────────
  ZL.register("stockcard", {
    title: "Stock card",
    perm: "journal.view",
    business: true,
    detail: true,
    nav: "stock",
    async render(ctx) {
      const id = (ctx.params || {}).item;
      if (!id) { ZL.open("stock"); return ""; }
      const [[it], moves, whs] = await Promise.all([
        ZL.select("items", "id,code,description,uom", (q) => q.eq("id", id)),
        ZL.select("stock_moves", "id,date,qty,value,kind,warehouse_id,trade_doc_id,stock_doc_id,seq", (q) => q.eq("item_id", id).order("seq")),
        warehouses(),
      ]);
      if (!it) return ZL.empty("Item not found", "");
      const wn = new Map(whs.map((w) => [w.id, w.name]));
      const tIds = [...new Set(moves.map((m) => m.trade_doc_id).filter(Boolean))], sIds = [...new Set(moves.map((m) => m.stock_doc_id).filter(Boolean))];
      const [tds, sds] = await Promise.all([
        tIds.length ? ZL.select("trade_docs", "id,doc_no,doc_type", (q) => q.in("id", tIds)) : [],
        sIds.length ? ZL.select("stock_docs", "id,doc_no,kind", (q) => q.in("id", sIds)) : [],
      ]);
      const tm = new Map(tds.map((d) => [d.id, d])), sm = new Map(sds.map((d) => [d.id, d]));
      let q = 0, v = 0;
      const lines = moves.map((m) => { q += Number(m.qty); v += ZL.cents(m.value); return Object.assign({}, m, { runQ: q, runV: v / 100 }); }).reverse();
      return `<div class="zl-crumbs"><button type="button" class="zl-ref" data-back>Stock on hand</button> / ${E(it.code)}</div>` +
        ZL.header(`${it.code} · ${it.description}`, `On hand ${Q(q)} ${E(it.uom)} · value RM ${M(v / 100)} · average ${q > 0 ? M(v / 100 / q) : "—"}`, actionsBar()) +
        (lines.length ? `<section class="card"><div class="tablewrap"><table>
          <thead><tr><th>Date</th><th>What</th><th>Document</th><th>Warehouse</th><th class="r">In</th><th class="r">Out</th><th class="r">Value</th><th class="r">Balance</th><th class="r">Stock value</th></tr></thead>
          <tbody>${lines.map((m) => { const td = m.trade_doc_id && tm.get(m.trade_doc_id), sd = m.stock_doc_id && sm.get(m.stock_doc_id);
            const doc = td ? `<button type="button" class="zl-ref" data-doc="${td.id}">${E(td.doc_no || "—")}</button>` : sd ? E(sd.doc_no) : "—";
            return `<tr><td class="nil">${ZL.date(m.date)}</td><td>${E(KIND[m.kind] || m.kind)}</td><td>${doc}</td><td class="nil">${E(wn.get(m.warehouse_id) || "")}</td>
              <td class="r num">${Number(m.qty) > 0 ? Q(m.qty) : ""}</td><td class="r num">${Number(m.qty) < 0 ? Q(-m.qty) : ""}</td>
              <td class="r num">${M(m.value)}</td><td class="r num">${Q(m.runQ)}</td><td class="r num">${M(m.runV)}</td></tr>`; }).join("")}</tbody></table></div></section>`
          : ZL.empty("No movements yet", "Buy this item on a purchase invoice, or post opening stock."));
    },
    after(root) {
      wireActions(root);
      const b = root.querySelector("[data-back]"); if (b) b.addEventListener("click", () => ZL.open("stock"));
      root.querySelectorAll("[data-doc]").forEach((x) => x.addEventListener("click", () => ZL.open("tradedoc", { id: x.dataset.doc })));
    },
  });

  // ── Stock documents ───────────────────────────────────────────────────────
  ZL.register("stockdocs", {
    title: "Stock adjustments",
    perm: "journal.view",
    business: true,
    async render() {
      const [docs, whs] = await Promise.all([
        ZL.select("stock_docs", "*", (q) => q.eq("company_id", cid()).order("created_at", { ascending: false }).limit(200)), warehouses()]);
      const wn = new Map(whs.map((w) => [w.id, w.name]));
      const canVoid = ZL.can("journal.reverse");
      return ZL.header("Stock adjustments", "Adjustments, counts, opening stock and transfers. Void one to undo it exactly.", actionsBar()) +
        (docs.length ? `<section class="card"><div class="tablewrap"><table>
          <thead><tr><th>No.</th><th>Date</th><th>Type</th><th>Warehouse</th><th>Description</th><th>Status</th><th></th></tr></thead>
          <tbody>${docs.map((d) => `<tr${d.status === "VOID" ? ' style="opacity:.6"' : ""}><td class="mono">${E(d.doc_no)}</td><td class="nil">${ZL.date(d.date)}</td>
            <td>${E(DOCKIND[d.kind] || d.kind)}</td><td class="nil">${E(wn.get(d.warehouse_id) || "")}${d.to_warehouse_id ? ` → ${E(wn.get(d.to_warehouse_id) || "")}` : ""}</td>
            <td>${E(d.description || "")}</td><td>${d.status === "VOID" ? `<span class="chip">Void</span>` : `<span class="chip ok">Posted</span>`}</td>
            <td class="r">${d.journal_entry_id ? `<button type="button" class="zl-btn sm ghost" data-open-journal="${d.journal_entry_id}">Journal</button>` : ""}
              ${canVoid && d.status === "POSTED" ? `<button type="button" class="zl-btn sm ghost" data-svoid="${d.id}" data-no="${E(d.doc_no)}">Void</button>` : ""}</td></tr>`).join("")}</tbody></table></div></section>`
          : ZL.empty("No stock documents yet", "Adjust stock for damage or loss, count it at month end, or move it between stores."));
    },
    after(root) {
      wireActions(root);
      root.querySelectorAll("[data-open-journal]").forEach((b) => b.addEventListener("click", () => ZL.open("journal", { id: b.dataset.openJournal })));
      root.querySelectorAll("[data-svoid]").forEach((b) => b.addEventListener("click", async () => {
        const r = await ZL.form({ title: `Void ${b.dataset.no}`, confirmLabel: "Void", danger: true,
          intro: "The stock and the journal are reversed exactly. This can't be undone.",
          fields: [{ name: "date", label: "Void date", type: "date", required: true, value: ZL.today() },
                   { name: "reason", label: "Reason", required: true, placeholder: "e.g. Entered twice" }],
          submit: (v) => ZL.rpc("void_stock_doc", { p_id: b.dataset.svoid, p_date: v.date, p_reason: v.reason }) });
        if (r) { ZL.toast(`${b.dataset.no} voided.`); ZL.refresh(); }
      }));
    },
  });

  // ── Warehouses and the negative-stock setting ─────────────────────────────
  async function editWarehouse(w) {
    const r = await ZL.form({ title: w ? `Edit ${w.name}` : "New warehouse", confirmLabel: w ? "Save" : "Add warehouse",
      fields: [
        { name: "code", label: "Code", required: true, half: true, value: (w && w.code) || "", placeholder: "e.g. KL" },
        { name: "name", label: "Name", required: true, half: true, value: (w && w.name) || "", placeholder: "e.g. Kuala Lumpur store" },
        { name: "is_default", label: "Default — used when a document doesn't name one", type: "checkbox", value: !!(w && w.is_default) },
        ...(w ? [{ name: "is_active", label: "Active", type: "checkbox", value: w.is_active }] : []),
      ],
      submit: (v) => ZL.rpc("save_warehouse", { p_company: cid(), p_id: w ? w.id : null, p_data: Object.assign({}, v, { is_active: w ? v.is_active : true }) }) });
    if (r) { ZL.toast("Warehouse saved."); ZL.refresh(); }
  }
  ZL.register("warehouses", {
    title: "Warehouses",
    perm: "journal.view",
    business: true,
    async render() {
      const [whs, [co], bal] = await Promise.all([ensureWarehouses(),
        ZL.select("companies", "allow_negative_stock", (q) => q.eq("id", cid())),
        ZL.select("stock_balances", "warehouse_id,qty", (q) => q.eq("company_id", cid()))]);
      const units = new Map(); bal.forEach((b) => units.set(b.warehouse_id, (units.get(b.warehouse_id) || 0) + Number(b.qty)));
      const edit = ZL.can("company.edit");
      return ZL.header("Warehouses", "Where you keep stock. Average cost is shared across warehouses; quantities are kept per warehouse.",
          edit ? `<button type="button" class="zl-btn primary" id="zl-wnew">+ New warehouse</button>` : "") +
        `<section class="card"><div class="tablewrap"><table><thead><tr><th>Code</th><th>Name</th><th class="r">Units held</th><th></th><th></th></tr></thead>
          <tbody>${whs.map((w) => `<tr${w.is_active ? "" : ' style="opacity:.6"'}><td class="mono">${E(w.code)}</td><td>${E(w.name)}</td>
            <td class="r num">${Q(units.get(w.id) || 0)}</td><td>${w.is_default ? '<span class="chip ok">Default</span>' : ""}${w.is_active ? "" : ' <span class="chip">Inactive</span>'}</td>
            <td class="r">${edit ? `<button type="button" class="zl-btn sm" data-wedit="${w.id}">Edit</button>` : ""}</td></tr>`).join("")}</tbody></table></div></section>
        <section class="card" style="margin-top:16px;padding:16px">
          <label class="zl-check"><input type="checkbox" id="zl-neg"${co && co.allow_negative_stock ? " checked" : ""}${edit ? "" : " disabled"}>
            <span><b>Allow selling stock you don't have yet</b><br><span class="hint">Off (recommended): an invoice that would take an item below zero is refused, so the cost of sales is always right. Turn on only if you invoice before goods arrive — those sales are costed at the last buying price.</span></span></label>
        </section>`;
    },
    after(root) {
      const n = root.querySelector("#zl-wnew"); if (n) n.addEventListener("click", () => editWarehouse(null));
      root.querySelectorAll("[data-wedit]").forEach((b) => b.addEventListener("click", async () => {
        const [w] = await ZL.select("warehouses", "*", (q) => q.eq("id", b.dataset.wedit)); editWarehouse(w); }));
      const neg = root.querySelector("#zl-neg");
      if (neg) neg.addEventListener("change", async () => {
        try { await ZL.rpc("set_stock_settings", { p_company: cid(), p_allow_negative: neg.checked }); ZL.toast("Saved."); }
        catch (e) { neg.checked = !neg.checked; ZL.toast(e.message, "bad"); }
      });
    },
  });
})();
