/* Zycount theme: System, Light, Dark or Dim, shared by the site, sign-in and workspace.
 *
 * Load it in <head> without defer so the saved theme is applied before first paint.
 * The choice is stored in localStorage "zy.theme"; no value means follow the system.
 * Pages style each theme with :root[data-theme="light|dark|dim"], and keep their
 * prefers-color-scheme rules under :root:not([data-theme]).
 */
(function () {
  "use strict";
  var KEY = "zy.theme";
  var THEMES = [
    { id: "system", label: "System", icon: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>' },
    { id: "light", label: "Light", icon: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>' },
    { id: "dark", label: "Dark", icon: '<path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/>' },
    { id: "dim", label: "Dim", icon: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 010 16z" fill="currentColor"/>' }
  ];

  function read() {
    try { var v = localStorage.getItem(KEY); return v === "light" || v === "dark" || v === "dim" ? v : "system"; } catch (e) { return "system"; }
  }
  function apply(id) {
    var root = document.documentElement;
    if (id === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", id);
  }
  function save(id) {
    try { if (id === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, id); } catch (e) { /* storage unavailable */ }
  }
  function svg(inner) {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + "</svg>";
  }
  function find(id) { for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i]; return THEMES[0]; }

  apply(read());

  var CSS =
    ".zt-wrap{position:relative;display:inline-flex}" +
    ".zt-menu{position:absolute;right:0;top:calc(100% + 8px);z-index:60;min-width:168px;padding:6px;border-radius:12px;" +
    "background:var(--card,#fff);color:var(--ink,#111);border:1px solid var(--line,var(--rule,#e2e6ee));" +
    "box-shadow:0 12px 32px -12px rgba(0,0,0,.35)}" +
    ".zt-menu[hidden]{display:none}" +
    ".zt-menu button{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:14px}" +
    ".zt-menu button:hover,.zt-menu button:focus-visible{background:var(--sunk,#eef0f5)}" +
    ".zt-menu button[aria-checked=\"true\"]{font-weight:600;color:var(--brand,var(--blue,#2156E8))}" +
    ".zt-menu button[aria-checked=\"true\"]::after{content:\"\\2713\";margin-left:auto}" +
    ".zt-menu .zt-h{padding:6px 10px 4px;font-size:12px;color:var(--ink-3,#77839a)}";

  /**
   * Turns a button into the theme picker. The button keeps its own styling;
   * its icon is replaced with the current theme's.
   */
  function mount(btn) {
    if (!btn || btn.__zt) return;
    btn.__zt = true;
    if (!document.getElementById("zt-css")) {
      var st = document.createElement("style"); st.id = "zt-css"; st.textContent = CSS; document.head.appendChild(st);
    }
    var wrap = document.createElement("span");
    wrap.className = "zt-wrap";
    btn.parentNode.insertBefore(wrap, btn);
    wrap.appendChild(btn);
    var menu = document.createElement("div");
    menu.className = "zt-menu";
    menu.setAttribute("role", "menu");
    menu.id = btn.id ? btn.id + "-menu" : "zt-menu";
    menu.hidden = true;
    menu.innerHTML = '<div class="zt-h">Theme</div>' + THEMES.map(function (t) {
      return '<button type="button" role="menuitemradio" data-zt="' + t.id + '">' + svg(t.icon) + t.label + "</button>";
    }).join("");
    wrap.appendChild(menu);
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-controls", menu.id);
    btn.setAttribute("aria-expanded", "false");
    var items = Array.prototype.slice.call(menu.querySelectorAll("[data-zt]"));

    function sync() {
      var cur = read();
      btn.innerHTML = svg(find(cur).icon);
      btn.setAttribute("aria-label", "Theme: " + find(cur).label);
      btn.title = "Theme: " + find(cur).label;
      items.forEach(function (b) { b.setAttribute("aria-checked", String(b.getAttribute("data-zt") === cur)); });
    }
    function open(focus) {
      menu.hidden = false; btn.setAttribute("aria-expanded", "true");
      if (focus) (menu.querySelector('[aria-checked="true"]') || items[0]).focus();
    }
    function close(refocus) {
      if (menu.hidden) return;
      menu.hidden = true; btn.setAttribute("aria-expanded", "false");
      if (refocus) btn.focus();
    }

    btn.addEventListener("click", function (e) { e.stopPropagation(); if (menu.hidden) open(e.detail === 0); else close(); });
    items.forEach(function (b, i) {
      b.addEventListener("click", function () { var id = b.getAttribute("data-zt"); save(id); apply(id); sync(); close(true); });
      b.addEventListener("keydown", function (e) {
        var n = items.length;
        if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % n].focus(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + n) % n].focus(); }
        else if (e.key === "Home") { e.preventDefault(); items[0].focus(); }
        else if (e.key === "End") { e.preventDefault(); items[n - 1].focus(); }
        else if (e.key === "Tab") close();
      });
    });
    document.addEventListener("click", function (e) { if (!wrap.contains(e.target)) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !menu.hidden) close(true); });
    window.addEventListener("storage", function (e) { if (e.key === KEY) { apply(read()); sync(); } });
    sync();
  }

  window.ZYTheme = { mount: mount, get: read };
})();
