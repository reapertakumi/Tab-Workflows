// Command palette (Ctrl+K) in the Session Manager.
// Needs icons.js (svgIcon, resolveIcon) and a page-level send(type, payload).
//
// openPalette({
//   actions: [{ icon, title, sub?, keywords?, run }],   // commands
//   openWorkflow(wf)                                    // how a workflow is opened / switched to
// })

let paletteEl = null;

function closePalette() {
  if (paletteEl) { paletteEl.remove(); paletteEl = null; }
}

async function openPalette(opts = {}) {
  if (paletteEl) { paletteEl.querySelector("input").focus(); return; }
  const { workflows = {}, looseTabs = [], activeWorkflowId = null, openWindows = {} } =
    await chrome.storage.local.get(["workflows", "looseTabs", "activeWorkflowId", "openWindows"]);
  const list = Object.values(workflows).sort((a, b) => a.createdAt - b.createdAt);
  const openIds = new Set(Object.values(openWindows || {}));
  if (activeWorkflowId) openIds.add(activeWorkflowId);

  const fav = url => /^https?:/i.test(url)
    ? `<img src="${chrome.runtime.getURL("/_favicon/?pageUrl=" + encodeURIComponent(url) + "&size=32")}" alt="">`
    : svgIcon("globe2", 15);
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return u; } };
  const done = () => closePalette();

  // ---- everything you can pick ----
  const groups = [];
  groups.push({ name: "Actions", items: (opts.actions || []).map(a => ({ ...a, iconHtml: svgIcon(a.icon || "arrow", 16) })) });
  groups.push({ name: "Workflows", items: list.map(wf => {
    const n = (wf.windows || []).reduce((k, w) => k + w.tabs.length, 0);
    const isOpen = openIds.has(wf.id);
    return {
      iconHtml: svgIcon(resolveIcon(wf.icon), 16), color: wf.color,
      title: wf.name,
      sub: `${n} tab${n === 1 ? "" : "s"}${isOpen ? (wf.id === activeWorkflowId ? " · you’re here" : " · open") : ""}${wf.tags && wf.tags.length ? " · #" + wf.tags.join(" #") : ""}`,
      keywords: "open switch workflow " + (wf.note || ""),
      hint: wf.id === activeWorkflowId ? "" : isOpen ? "Show" : "Open",
      run: () => { closePalette(); opts.openWorkflow ? opts.openWorkflow(wf) : send("openWorkflow", { id: wf.id }); }
    };
  }) });
  const tabItems = [];
  const addTabs = (wf, name) => (wf.windows || []).forEach((w, wi) => w.tabs.forEach((t, ti) => tabItems.push({
    iconHtml: fav(t.url),
    title: t.name || t.title || t.url,
    sub: `${name} · ${host(t.url)}`,
    keywords: t.url,
    run: async () => { await send("focusTab", { id: wf.id, win: wi, idx: ti }); done(); }
  })));
  list.forEach(wf => addTabs(wf, wf.name));
  addTabs({ id: "__loose", windows: [{ tabs: looseTabs }] }, "Unsorted tabs");
  groups.push({ name: "Tabs", items: tabItems, onlyWhenSearching: true });

  // ---- UI ----
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Search tabs and workflows, or type a command…";
  input.setAttribute("aria-label", "Command palette");
  const results = document.createElement("div");
  results.className = "palette-results";
  results.setAttribute("role", "listbox");
  const box = document.createElement("div");
  box.className = "palette";
  box.setAttribute("role", "dialog");
  box.innerHTML = `<div class="palette-input">${svgIcon("search", 17)}</div>`;
  box.querySelector(".palette-input").append(input, Object.assign(document.createElement("kbd"), { textContent: "Esc" }));
  box.append(results);
  const foot = document.createElement("div");
  foot.className = "palette-foot";
  foot.innerHTML = "<span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span>";
  box.append(foot);
  paletteEl = document.createElement("div");
  paletteEl.className = "palette-backdrop";
  paletteEl.append(box);
  paletteEl.addEventListener("mousedown", e => { if (e.target === paletteEl) closePalette(); });
  document.body.append(paletteEl);

  let flat = [];
  let active = 0;

  const score = (it, q, tokens) => {
    const title = (it.title || "").toLowerCase();
    const hay = (title + " " + (it.sub || "") + " " + (it.keywords || "")).toLowerCase();
    if (!tokens.every(t => hay.includes(t))) return -1;
    if (title.startsWith(q)) return 3;
    if (title.includes(q)) return 2;
    return 1;
  };

  function render() {
    const q = input.value.trim().toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    results.innerHTML = "";
    flat = [];
    for (const g of groups) {
      if (g.onlyWhenSearching && !q) continue;
      let items = g.items;
      if (q) {
        items = items.map(it => [it, score(it, q, tokens)]).filter(x => x[1] >= 0)
          .sort((a, b) => b[1] - a[1]).map(x => x[0]);
      }
      const limit = g.name === "Tabs" ? 40 : 30;
      if (!items.length) continue;
      const head = document.createElement("div");
      head.className = "palette-group";
      head.textContent = g.name + (items.length > limit ? ` (${limit} of ${items.length})` : "");
      results.append(head);
      for (const it of items.slice(0, limit)) {
        const i = flat.length;
        flat.push(it);
        const row = document.createElement("div");
        row.className = "palette-item";
        row.setAttribute("role", "option");
        row.innerHTML = `<span class="pi-icon"${it.color ? ` data-color="${it.color}"` : ""}>${it.iconHtml || ""}</span>
          <span class="pi-text"><span class="pi-title"></span><span class="pi-sub"></span></span>
          ${it.hint ? `<span class="pi-hint"></span>` : ""}`;
        row.querySelector(".pi-title").textContent = it.title;
        row.querySelector(".pi-sub").textContent = it.sub || "";
        if (it.hint) row.querySelector(".pi-hint").textContent = it.hint;
        const img = row.querySelector("img");
        if (img) img.addEventListener("error", () => { img.outerHTML = svgIcon("globe2", 15); });
        row.addEventListener("mousemove", () => { if (active !== i) { active = i; mark(); } });
        row.addEventListener("click", () => run(i));
        results.append(row);
      }
    }
    if (!flat.length) {
      const empty = document.createElement("div");
      empty.className = "palette-empty";
      empty.textContent = q ? `Nothing matches “${input.value.trim()}”` : "Nothing here yet";
      results.append(empty);
    } else if (!q && tabItems.length) {
      const more = document.createElement("div");
      more.className = "palette-empty small";
      more.textContent = `Type to search ${tabItems.length} saved tab${tabItems.length === 1 ? "" : "s"}`;
      results.append(more);
    }
    active = Math.min(active, Math.max(0, flat.length - 1));
    mark();
  }

  function mark() {
    const rows = results.querySelectorAll(".palette-item");
    rows.forEach((r, i) => r.classList.toggle("on", i === active));
    const cur = rows[active];
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }

  function run(i) {
    const it = flat[i];
    if (!it) return;
    try { it.run(); } catch (e) { console.error(e); }
    if (paletteEl) closePalette();
  }

  input.addEventListener("input", () => { active = 0; render(); });
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(flat.length - 1, active + 1); mark(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); mark(); }
    else if (e.key === "Enter") { e.preventDefault(); run(active); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePalette(); }
  });

  render();
  setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 0);
}
