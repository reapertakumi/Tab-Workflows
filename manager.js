// Session Manager page: board of workflows with drag & drop + settings tab.
const $ = id => document.getElementById(id);
const ICON_NAMES = Object.keys(ICON_PATHS);

let state = { workflows: {}, activeWorkflowId: null, looseTabs: [], openWindows: {} };
const LOOSE = "__loose";
const looseWorkflow = () => ({ id: LOOSE, name: "Unsorted tabs", icon: "list", autosave: false, createdAt: 0,
  windows: [{ tabs: state.looseTabs, activeIndex: 0 }] });
let settings = { ...DEFAULT_SETTINGS };
let query = "";
let dragging = null;          // { from: {id, win, idx}, row }
let pendingRender = false;
let firstRender = true;
const collapsed = new Set(readLocal("tm-collapsed", []));

// ---------- small helpers ----------
function readLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
}

function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "html") n.innerHTML = v;
    else if (k === "on") for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
    else if (k in n && !k.startsWith("data-")) n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null && c !== false) n.append(c);
  return n;
}

function send(type, payload = {}) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type, payload }, res => resolve(res || { ok: false }));
  });
}

let toastTimer;
function toast(msg, action) {
  const t = $("toast");
  t.replaceChildren(el("span", { textContent: msg }));
  if (action) t.append(el("button", { className: "toast-action", textContent: action.label,
    on: { click: () => { t.classList.remove("show"); action.run(); } } }));
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), action ? 5000 : 2200);
}

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const countTabs = wf => (wf.windows || []).reduce((n, w) => n + w.tabs.length, 0);

function hostOf(url) {
  try { const u = new URL(url); return u.hostname.replace(/^www\./, "") || u.protocol.replace(":", ""); }
  catch (_) { return url; }
}

function timeAgo(ts) {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  return new Date(ts).toLocaleDateString();
}

function favicon(url, stored) {
  let src = null;
  if (/^https?:/i.test(url)) src = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
  else if (stored && /^(https?:|data:)/.test(stored)) src = stored;
  const fallback = () => el("span", { className: "fav", html: svgIcon("globe2", 11) });
  if (!src) return fallback();
  const img = el("img", { src, alt: "", loading: "lazy" });
  img.addEventListener("error", () => img.replaceWith(fallback()));
  return img;
}

function highlight(text, q) {
  const frag = document.createDocumentFragment();
  if (!q) { frag.append(text); return frag; }
  const lower = text.toLowerCase();
  let i = 0, j;
  while ((j = lower.indexOf(q, i)) !== -1) {
    frag.append(text.slice(i, j), el("mark", { textContent: text.slice(j, j + q.length) }));
    i = j + q.length;
  }
  frag.append(text.slice(i));
  return frag;
}

const isActive = wf => openWorkflowIds(state).has(wf.id);       // open in a browser window
const isFocused = wf => wf.id === state.activeWorkflowId;         // the one you're in
const isLive = wf => isActive(wf) && wf.autosave !== false && settings.autosaveEnabled;
const sortedWorkflows = () => Object.values(state.workflows).sort((a, b) => a.createdAt - b.createdAt);

function download(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function exportPayload(list) {
  return {
    app: "tab-workflows", version: 1, exportedAt: new Date().toISOString(),
    workflows: list.map(w => ({ name: w.name, icon: resolveIcon(w.icon), autosave: w.autosave !== false, windows: w.windows || [] }))
  };
}
const slug = s => (s || "workflow").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workflow";

function exportOne(wf) {
  download(`${slug(wf.name)}.json`, exportPayload([wf]));
  toast(`Exported “${wf.name}”`);
}
function exportAll() {
  const list = sortedWorkflows();
  if (!list.length) return toast("No workflows to export");
  download(`tab-workflows-${new Date().toISOString().slice(0, 10)}.json`, exportPayload(list));
  toast(`Exported ${plural(list.length, "workflow")}`);
}

async function importFile(file) {
  const text = await file.text();
  let wfs = [];
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data.workflows)) wfs = data.workflows;
    else if (Array.isArray(data)) wfs = data;
    else if (data && data.windows) wfs = [data];
  } catch (_) {
    const urls = text.split(/\s+/).filter(u => /^https?:\/\//i.test(u));
    if (urls.length) {
      wfs = [{ name: file.name.replace(/\.[^.]+$/, "") || "Imported links", icon: "folder",
               windows: [{ tabs: urls.map(u => ({ url: u, title: hostOf(u) })) }] }];
    }
  }
  if (!wfs.length) return toast("Nothing to import in that file");
  const res = await send("importWorkflows", { workflows: wfs });
  toast(res.ok ? `Imported ${plural(res.result, "workflow")}` : "Import failed");
}

// ---------- menu ----------
function closeMenu() { $("menu").classList.add("hidden"); }
function fillMenu(items) {
  const m = $("menu");
  m.innerHTML = "";
  for (const it of items) {
    if (!it) continue;
    if (it === "sep") { if (m.lastChild && m.lastChild.tagName !== "HR") m.append(el("hr")); continue; }
    if (it.heading) { m.append(el("div", { className: "menu-head", textContent: it.heading })); continue; }
    m.append(el("button", {
      className: it.danger ? "danger" : "", role: "menuitem",
      html: svgIcon(it.icon, 15) + `<span></span>` + (it.hint ? `<kbd></kbd>` : ""),
      on: { click: () => { closeMenu(); it.action(); } }
    }));
    m.lastChild.querySelector("span").textContent = it.label;
    if (it.hint) m.lastChild.querySelector("kbd").textContent = it.hint;
  }
  if (m.lastChild && m.lastChild.tagName === "HR") m.lastChild.remove();
  m.classList.remove("hidden");
  return m;
}
function openMenu(anchor, items) {
  const m = fillMenu(items);
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  let left = Math.min(r.right - w, window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  m.style.left = Math.max(8, left) + "px";
  m.style.top = top + "px";
}
// Right-click menus: open at the pointer, flipped to stay on screen.
function openMenuAt(x, y, items) {
  const m = fillMenu(items);
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(8, x + w > window.innerWidth - 8 ? x - w : x) + "px";
  m.style.top = Math.max(8, y + h > window.innerHeight - 8 ? y - h : y) + "px";
}
window.addEventListener("blur", closeMenu);
document.addEventListener("scroll", closeMenu, true);
document.addEventListener("mousedown", e => { if (!$("menu").contains(e.target)) closeMenu(); });

// ---------- modal dialogs ----------
function closeModal() { $("modal").classList.add("hidden"); $("modal").innerHTML = ""; }

function workflowDialog({ title, text, name = "", icon = "folder", submit = "Save" }) {
  return new Promise(resolve => {
    const data = { name, icon: resolveIcon(icon) };
    const m = $("modal");
    const pick = el("button", { className: "picker-btn", type: "button", title: "Icon" });
    const input = el("input", { type: "text", value: name, placeholder: "Workflow name", maxLength: 40 });
    const grid = el("div", { className: "icon-grid" });
    const paint = () => {
      pick.innerHTML = svgIcon(data.icon, 18);
      grid.innerHTML = "";
      for (const n of ICON_NAMES) {
        grid.append(el("button", { type: "button", title: n, className: n === data.icon ? "sel" : "", html: svgIcon(n, 17),
          on: { click: () => { data.icon = n; paint(); input.focus(); } } }));
      }
    };
    paint();
    pick.addEventListener("click", () => grid.classList.toggle("hidden"));
    const done = v => { closeModal(); resolve(v); };
    const ok = () => { const n = input.value.trim(); if (!n) return input.focus(); done({ name: n, icon: data.icon }); };
    input.addEventListener("keydown", e => { if (e.key === "Enter") ok(); });
    m.innerHTML = "";
    m.append(el("div", { className: "dialog", role: "dialog", "aria-modal": "true" }, [
      el("h2", { textContent: title }),
      text ? el("p", { textContent: text }) : null,
      el("div", { className: "field" }, [pick, input]),
      grid,
      el("div", { className: "buttons" }, [
        el("button", { className: "btn ghost", textContent: "Cancel", on: { click: () => done(null) } }),
        el("button", { className: "btn primary", textContent: submit, on: { click: ok } })
      ])
    ]));
    m.classList.remove("hidden");
    m.onmousedown = e => { if (e.target === m) done(null); };
    m._cancel = () => done(null);
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

function confirmDialog(title, text, okLabel = "OK", danger = false) {
  return new Promise(resolve => {
    const m = $("modal");
    const done = v => { closeModal(); resolve(v); };
    const okBtn = el("button", { className: "btn primary" + (danger ? " danger-fill" : ""), textContent: okLabel, on: { click: () => done(true) } });
    if (danger) okBtn.style.cssText = "background: var(--danger); border-color: var(--danger); color: #fff";
    m.innerHTML = "";
    m.append(el("div", { className: "dialog", role: "alertdialog", "aria-modal": "true" }, [
      el("h2", { textContent: title }),
      el("p", { textContent: text }),
      el("div", { className: "buttons" }, [
        el("button", { className: "btn ghost", textContent: "Cancel", on: { click: () => done(false) } }),
        okBtn
      ])
    ]));
    m.classList.remove("hidden");
    m.onmousedown = e => { if (e.target === m) done(false); };
    m._cancel = () => done(false);
    setTimeout(() => okBtn.focus(), 0);
  });
}

// ---------- workflow actions ----------
async function newWorkflow() {
  const r = await workflowDialog({ title: "New workflow", text: "Creates an empty workflow. Drag tabs into it or add links. Your open tabs stay as they are.", submit: "Create" });
  if (!r) return;
  await send("createEmptyWorkflow", r);
  toast(`Created “${r.name}”`);
}

async function editWorkflow(wf) {
  const r = await workflowDialog({ title: "Edit workflow", name: wf.name, icon: wf.icon, submit: "Save" });
  if (r) await send("editWorkflow", { id: wf.id, ...r });
}

async function openWorkflow(wf) {
  if (isActive(wf)) { send("openWorkflow", { id: wf.id }); return; }
  const { currentSession = null } = await chrome.storage.local.get("currentSession");
  const notice = switchNotice({ ...state, currentSession }, settings, wf);
  if (settings.confirmSwitch || notice.risky) {
    if (notice.saveId) {
      const save = await confirmDialog(`Save before opening “${wf.name}”?`, notice.text + " Save them first?", "Save & open");
      if (save) await send("saveIntoWorkflow", { id: notice.saveId });
      else if (!(await confirmDialog(`Open “${wf.name}” without saving?`, "Unsaved changes in the current workflow will be lost.", "Open anyway", true))) return;
    } else if (!(await confirmDialog(`Open “${wf.name}”?`, notice.text, notice.risky ? "Open anyway" : "Open", notice.risky))) return;
  }
  let pinned;
  if (settings.keepPinnedTabs && pinnedTabsIn(wf).length) {
    pinned = settings.pinnedOnOpen;
    if (pinned === "ask") { pinned = await pinnedChoiceDialog(wf); if (!pinned) return; }
  }
  toast(`Opening “${wf.name}”…`);
  const res = await send("openWorkflow", { id: wf.id, pinned });
  if (!res.ok) toast("Couldn’t open: " + res.error);
}

// "Keep pinned tabs open" is on, and this workflow still has pinned tabs saved in it (from before).
function pinnedChoiceDialog(wf) {
  const pins = pinnedTabsIn(wf);
  return new Promise(resolve => {
    const m = $("modal");
    const remember = el("input", { type: "checkbox" });
    const done = v => {
      closeModal();
      if (v && remember.checked) setSetting("pinnedOnOpen", v);
      resolve(v);
    };
    const option = (how, icon, name, meta) => el("button", { className: "target", on: { click: () => done(how) } }, [
      el("span", { className: "tile", html: svgIcon(icon, 17) }),
      el("span", { className: "target-text" }, [el("span", { className: "target-name", textContent: name }), el("span", { className: "target-meta", textContent: meta })])
    ]);
    const list = el("div", { className: "target-list" }, [
      option("pin", "pin", "Pin them", "They open pinned and stay open like your other pinned tabs – no longer part of this workflow"),
      option("unpin", "list", "Open as normal tabs", "They become normal tabs of this workflow and close when you switch away"),
      option("remove", "trash", "Remove them", "Take them out of this workflow and open the rest")
    ]);
    const names = pins.slice(0, 3).map(t => t.name || t.title || t.url).join(", ") + (pins.length > 3 ? ` and ${pins.length - 3} more` : "");
    m.innerHTML = "";
    m.append(el("div", { className: "dialog", role: "dialog", "aria-modal": "true" }, [
      el("h2", { textContent: `“${wf.name}” has ${plural(pins.length, "pinned tab")}` }),
      el("p", { textContent: `Pinned tabs now stay open across workflows instead of being saved in one. What should happen to ${names}?` }),
      list,
      el("label", { className: "remember" }, [remember, el("span", { textContent: "Do this every time (change it in Settings → Switching)" })]),
      el("div", { className: "buttons" }, [el("button", { className: "btn ghost", textContent: "Cancel", on: { click: () => done(null) } })])
    ]));
    m.classList.remove("hidden");
    m.onmousedown = e => { if (e.target === m) done(null); };
    m._cancel = () => done(null);
    setTimeout(() => { const f = list.querySelector("button"); f && f.focus(); }, 0);
  });
}

async function deleteWorkflow(wf) {
  if (settings.confirmDelete && !(await confirmDialog(`Delete “${wf.name}”?`, `Its ${plural(countTabs(wf), "saved tab")} will be removed. Your open tabs are not affected.`, "Delete", true))) return;
  await send("deleteWorkflow", { id: wf.id });
  toast(`Deleted “${wf.name}” – it’s in History & trash`, undoAction);
}

async function copyLinks(wf) {
  const urls = (wf.windows || []).flatMap(w => w.tabs.map(t => t.url));
  try { await navigator.clipboard.writeText(urls.join("\n")); toast(`Copied ${plural(urls.length, "link")}`); }
  catch (_) { toast("Couldn’t access the clipboard"); }
}

function cardMenu(anchor, wf) {
  const live = isLive(wf);
  openMenu(anchor, [
    { icon: "edit", label: "Rename / change icon", action: () => editWorkflow(wf) },
    { icon: "tag", label: "Note, colour & tags…", action: () => detailsDialog(wf) },
    { icon: "copy", label: "Copy all links", action: () => copyLinks(wf) },
    { icon: "divider", label: "Add divider tab…", action: () => addDividerFlow(wf, Math.max(0, (wf.windows || []).length - 1), undefined, false) },
    { icon: "history", label: "Backup copies…", action: () => copiesDialog(wf) },
    { icon: "sort", label: "Sort by title", action: () => send("sortWorkflow", { id: wf.id, by: "title" }) },
    { icon: "globe2", label: "Sort by website", action: () => send("sortWorkflow", { id: wf.id, by: "site" }) },
    { icon: "dedupe", label: "Remove duplicates", action: async () => {
        const r = await send("dedupeWorkflow", { id: wf.id });
        toast(r.result ? `Removed ${plural(r.result, "duplicate")}` : "No duplicates found", r.result ? undoAction : null);
      } },
    { icon: "save", label: wf.autosave !== false ? "Turn autosave off" : "Turn autosave on",
      action: () => send("setAutosave", { id: wf.id, value: wf.autosave === false }) },
    { icon: "download", label: "Download workflow", action: () => exportOne(wf) },
    "sep",
    { icon: "close", label: live ? "Close all tabs" : "Remove all tabs", danger: true, action: async () => {
        if (!countTabs(wf)) return;
        const ok = await confirmDialog(live ? `Close all tabs in “${wf.name}”?` : `Remove all tabs from “${wf.name}”?`,
          live ? "This workflow is open right now, so its tabs will be closed in the browser too." : "The workflow itself stays, just empty.",
          live ? "Close all" : "Remove all", true);
        if (ok) { await send("clearWorkflow", { id: wf.id }); toast("Tabs moved to History & trash", undoAction); }
      } },
    { icon: "trash", label: "Delete workflow", danger: true, action: () => deleteWorkflow(wf) }
  ]);
}


// ---------- tab dialogs (+ New Tab, edit name/link) ----------
function tabDialog({ title, text, name = "", url = "", target, submit }) {
  return new Promise(resolve => {
    const m = $("modal");
    const nameIn = el("input", { type: "text", value: name, placeholder: "Name (optional – defaults to the website)", maxLength: 120 });
    const urlIn = el("input", { type: "text", value: url, placeholder: "https://example.com", spellcheck: false });
    let select = null;
    if (target !== undefined) {
      select = el("select", { className: "field-select" });
      select.append(el("option", { value: LOOSE, textContent: "No workflow (Unsorted tabs)" }));
      for (const wf of sortedWorkflows()) select.append(el("option", { value: wf.id, textContent: wf.name, selected: wf.id === target }));
    }
    const err = el("div", { className: "field-error" });
    const done = v => { closeModal(); resolve(v); };
    const ok = () => {
      const u = urlIn.value.trim();
      if (!u) { err.textContent = "Enter a link."; return urlIn.focus(); }
      done({ name: nameIn.value.trim(), url: u, target: select ? select.value : undefined });
    };
    [nameIn, urlIn].forEach(i => i.addEventListener("keydown", e => { if (e.key === "Enter") ok(); }));
    const label = (txt, ctl) => el("label", { className: "field-col" }, [el("span", { textContent: txt }), ctl]);
    m.innerHTML = "";
    m.append(el("div", { className: "dialog", role: "dialog", "aria-modal": "true" }, [
      el("h2", { textContent: title }),
      text ? el("p", { textContent: text }) : null,
      label("Name", nameIn),
      label("Link", urlIn),
      select ? label("Workflow", select) : null,
      err,
      el("div", { className: "buttons" }, [
        el("button", { className: "btn ghost", textContent: "Cancel", on: { click: () => done(null) } }),
        el("button", { className: "btn primary", textContent: submit, on: { click: ok } })
      ])
    ]));
    m.classList.remove("hidden");
    m.onmousedown = e => { if (e.target === m) done(null); };
    m._cancel = () => done(null);
    setTimeout(() => (url ? nameIn : urlIn).focus(), 0);
  });
}

async function newTabDialog(target = LOOSE) {
  const r = await tabDialog({ title: "New tab", target, submit: "Add tab",
    text: "Add a link to a workflow, or keep it in Unsorted tabs and drag it into a workflow later." });
  if (!r) return;
  const dst = r.target === LOOSE ? looseWorkflow() : state.workflows[r.target];
  await send("addTab", { id: r.target, win: Math.max(0, ((dst && dst.windows) || []).length - 1), url: r.url, name: r.name });
  toast(r.target === LOOSE ? "Added to Unsorted tabs" : `Added to “${dst ? dst.name : "workflow"}”`);
}

async function editTabDialog(wf, wi, ti, t) {
  const live = isLive(wf);
  const r = await tabDialog({ title: "Edit tab", name: t.name || t.title || "", url: t.url, submit: "Save",
    text: live ? "This workflow is open – changing the link also changes the real tab." : null });
  if (!r) return;
  await send("editTab", { id: wf.id, win: wi, idx: ti, name: r.name, url: r.url });
}

// ---------- drag & drop ----------
const dropLine = el("li", { className: "drop-line" });

function clearDropUi() {
  dropLine.remove();
  document.querySelectorAll(".card.drop-target").forEach(c => c.classList.remove("drop-target"));
}

function rowBefore(ul, y, x) {
  const rows = [...ul.querySelectorAll(".tab-row")].filter(r => !r.classList.contains("hide") && r !== dragging.row
    && !(dragging.multi && r.classList.contains("picked")));
  const grid = settings.density === "icons";
  for (const r of rows) {
    const b = r.getBoundingClientRect();
    if (!grid) { if (y < b.top + b.height / 2) return r; continue; }
    if (y < b.top) return r;                                   // pointer is on an earlier line
    if (y <= b.bottom && x < b.left + b.width / 2) return r;   // same line, left half of this icon
  }
  return null;
}

function targetFor(ul, before, copy) {
  const id = ul.dataset.id, win = +ul.dataset.win;
  const total = ul.querySelectorAll(".tab-row").length;
  const same = dragging.from.id === id && dragging.from.win === win && !copy;
  let idx;
  if (before) { idx = +before.dataset.idx; if (same && dragging.from.idx < idx) idx--; }
  else idx = same ? total - 1 : total;
  return { id, win, idx };
}

function doDrop(to, copy) {
  const from = dragging.from;
  if (!copy && from.id === to.id && from.win === to.win && from.idx === to.idx) return;
  const dst = state.workflows[to.id];
  send("moveTab", { from, to, copy });
  if (from.id !== to.id || copy) toast(`${copy ? "Copied" : "Moved"} to “${dst ? dst.name : "workflow"}”`, undoAction);
}

function attachListDrop(ul) {
  ul.addEventListener("dragover", e => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
    const before = rowBefore(ul, e.clientY, e.clientX);
    if (!ul.classList.contains("empty-list")) {
      let ref = before;
      while (ref && ref.previousElementSibling && ref.previousElementSibling.classList.contains("label-row")) ref = ref.previousElementSibling;
      if (ref) { if (dropLine.nextSibling !== ref) ul.insertBefore(dropLine, ref); }
      else if (ul.lastChild !== dropLine) ul.append(dropLine);
    }
    const card = ul.closest(".card");
    document.querySelectorAll(".card.drop-target").forEach(c => c !== card && c.classList.remove("drop-target"));
    card.classList.add("drop-target");
  });
  ul.addEventListener("drop", e => {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
    const before = rowBefore(ul, e.clientY, e.clientX);
    if (dragging.multi) {
      clearDropUi();
      multiDrop(ul.dataset.id, +ul.dataset.win, before ? +before.dataset.idx : null, e.ctrlKey);
      return;
    }
    const to = targetFor(ul, before, e.ctrlKey);
    clearDropUi();
    doDrop(to, e.ctrlKey);
  });
}

function attachCardDrop(card, head, wf) {
  // Dropping on the header (handy when collapsed) appends to the last window.
  head.addEventListener("dragover", e => {
    if (!dragging) return;
    e.preventDefault();
    dropLine.remove();
    card.classList.add("drop-target");
  });
  head.addEventListener("drop", e => {
    if (!dragging) return;
    e.preventDefault();
    const wins = wf.windows || [];
    const win = Math.max(0, wins.length - 1);
    if (dragging.multi) { clearDropUi(); multiDrop(wf.id, win, null, e.ctrlKey); return; }
    const total = wins[win] ? wins[win].tabs.length : 0;
    const same = dragging.from.id === wf.id && dragging.from.win === win && !e.ctrlKey;
    clearDropUi();
    doDrop({ id: wf.id, win, idx: same ? total - 1 : total }, e.ctrlKey);
  });
  card.addEventListener("dragleave", e => {
    if (!card.contains(e.relatedTarget)) { card.classList.remove("drop-target"); if (card.contains(dropLine)) dropLine.remove(); }
  });
}

// ---------- selecting several tabs ----------
// Hover a tab and tick the box that replaces its icon; once one tab is ticked, every tab shows a box.
// Tabs can be ticked in several workflows at once.
// selection: workflowId -> { keys: Set("win:idx"), last: "win:idx" | null }
const selection = new Map();
const selFor = id => selection.get(id);
const keyOf = (wi, ti) => `${wi}:${ti}`;
const allKeys = wf => (wf.windows || []).flatMap((w, wi) => w.tabs.map((_, ti) => keyOf(wi, ti)));
const wfById = id => id === LOOSE ? looseWorkflow() : state.workflows[id];
const selCount = () => [...selection.values()].reduce((n, s) => n + s.keys.size, 0);
const isPicked = (id, wi, ti) => !!selFor(id) && selFor(id).keys.has(keyOf(wi, ti));

function clearSelection() {
  if (!selection.size) return;
  selection.clear();
  renderBoard();
}

function toggleTabSelected(wf, wi, ti, shift) {
  let sel = selFor(wf.id);
  if (!sel) { sel = { keys: new Set(), last: null }; selection.set(wf.id, sel); }
  const k = keyOf(wi, ti);
  if (shift && sel.last && sel.last.split(":")[0] === String(wi)) {
    // Shift-click: tick everything between the last clicked tab and this one (same window).
    const from = +sel.last.split(":")[1];
    const [a, b] = from < ti ? [from, ti] : [ti, from];
    for (let i = a; i <= b; i++) sel.keys.add(keyOf(wi, i));
  } else if (sel.keys.has(k)) sel.keys.delete(k);
  else sel.keys.add(k);
  sel.last = k;
  if (!sel.keys.size) selection.delete(wf.id);
  renderBoard();
}

// Every workflow that has ticked tabs gets all of its tabs ticked.
function selectAllInSelected() {
  for (const [id, sel] of selection) { const wf = wfById(id); if (wf) allKeys(wf).forEach(k => sel.keys.add(k)); }
  renderBoard();
}

// Drop ticked tabs that no longer exist (moved, closed, synced away).
function pruneSelection() {
  for (const [id, sel] of selection) {
    const wf = wfById(id);
    if (!wf) { selection.delete(id); continue; }
    const valid = new Set(allKeys(wf));
    sel.keys.forEach(k => { if (!valid.has(k)) sel.keys.delete(k); });
    if (!sel.keys.size) selection.delete(id);
  }
}

const itemsOf = keys => [...keys].map(k => { const [win, idx] = k.split(":").map(Number); return { win, idx }; })
  .sort((a, b) => a.win - b.win || a.idx - b.idx);
function selectedGroups() {
  return [...selection].map(([id, sel]) => ({ wf: wfById(id), items: itemsOf(sel.keys) })).filter(g => g.wf && g.items.length);
}
const tabAt = (wf, it) => wf.windows && wf.windows[it.win] && wf.windows[it.win].tabs[it.idx];

// The floating bar at the bottom while tabs are ticked.
function renderSelBar() {
  let bar = $("selBar");
  if (!bar) {
    bar = el("div", { id: "selBar", className: "sel-bar", role: "toolbar", "aria-label": "Selected tabs" });
    $("boardView").append(bar);
  }
  const n = selCount();
  document.body.classList.toggle("selecting", n > 0);
  bar.classList.toggle("show", n > 0);
  bar.inert = n === 0;
  if (!n) return;                     // keep the old content while it slides away
  const groups = selectedGroups();
  const total = groups.reduce((s, g) => s + countTabs(g.wf), 0);
  const where = groups.length === 1 ? `in “${groups[0].wf.name}”` : `in ${plural(groups.length, "workflow")}`;
  const btn = (icon, label, title, fn, cls = "") => {
    const b = el("button", { className: "sb-btn " + cls, title, html: (icon ? svgIcon(icon, 15) : "") + "<span></span>", on: { click: fn } });
    b.querySelector("span").textContent = label;
    return b;
  };
  const all = n >= total;
  bar.replaceChildren(
    el("span", { className: "sb-count", textContent: `${n} selected`, title: `${plural(n, "tab")} selected ${where}` }),
    btn("folder", "Move to…", `Move ${plural(n, "tab")} to another workflow`, () => bulkAction("move")),
    btn("copy", "Copy to…", `Copy ${plural(n, "tab")} to another workflow`, () => bulkAction("copy")),
    btn("external", "Open", `Open ${plural(n, "tab")} in the browser`, () => bulkAction("open")),
    btn("link", "Copy links", "Copy the links to the clipboard", () => bulkAction("links")),
    btn("trash", "Trash", `Remove ${plural(n, "tab")} (you can undo it, or restore them from the trash)`, () => bulkAction("remove"), "danger"),
    // Select all ↔ Deselect all
    all ? btn(null, "Deselect all", "Deselect every tab", clearSelection)
        : btn(null, "Select all", `Select every tab ${where}`, selectAllInSelected),
    el("button", { className: "sb-close", title: "Close (Esc)", "aria-label": "Close selection", html: svgIcon("close", 16), on: { click: clearSelection } })
  );
}

// "Where to?" – pick a workflow, Unsorted tabs, or a new workflow.
function chooseTarget({ title, text, excludeId }) {
  return new Promise(resolve => {
    const m = $("modal");
    const done = v => { closeModal(); resolve(v); };
    const option = (id, icon, name, meta, cls = "") => el("button", { className: "target " + cls, on: { click: () => done(id) } }, [
      el("span", { className: "tile", html: svgIcon(icon, 17) }),
      el("span", { className: "target-text" }, [el("span", { className: "target-name", textContent: name }), meta ? el("span", { className: "target-meta", textContent: meta }) : null])
    ]);
    const list = el("div", { className: "target-list" });
    for (const wf of sortedWorkflows()) {
      if (wf.id === excludeId) continue;
      list.append(option(wf.id, resolveIcon(wf.icon), wf.name,
        plural(countTabs(wf), "tab") + (isLive(wf) ? " · open – tabs open in the browser too" : "")));
    }
    if (excludeId !== LOOSE) list.append(option(LOOSE, "list", "Unsorted tabs", "Not in any workflow", "loose"));
    list.append(option("__new__", "plus", "New workflow…", "Create one and put the tabs there", "new"));
    m.innerHTML = "";
    m.append(el("div", { className: "dialog", role: "dialog", "aria-modal": "true" }, [
      el("h2", { textContent: title }),
      text ? el("p", { textContent: text }) : null,
      list,
      el("div", { className: "buttons" }, [el("button", { className: "btn ghost", textContent: "Cancel", on: { click: () => done(null) } })])
    ]));
    m.classList.remove("hidden");
    m.onmousedown = e => { if (e.target === m) done(null); };
    m._cancel = () => done(null);
    setTimeout(() => { const f = list.querySelector("button"); f && f.focus(); }, 0);
  });
}

// kind: move | copy | remove | open | links. groups: [{ wf, items: [{ win, idx }] }] – the ticked tabs by default.
async function bulkAction(kind, groups = selectedGroups()) {
  const n = groups.reduce((s, g) => s + g.items.length, 0);
  if (!n) return;
  const single = groups.length === 1 ? groups[0].wf : null;
  const live = groups.some(g => isLive(g.wf));
  const fromSelection = groups.some(g => g.items.some(it => isPicked(g.wf.id, it.win, it.idx)));

  if (kind === "links") {
    const urls = groups.flatMap(g => g.items.map(it => tabAt(g.wf, it)).filter(Boolean).map(t => t.url));
    try { await navigator.clipboard.writeText(urls.join("\n")); toast(`Copied ${plural(urls.length, "link")}`); }
    catch (_) { toast("Couldn’t access the clipboard"); }
    return;
  }
  if (kind === "open") {
    if (n > 15 && !await confirmDialog(`Open ${n} tabs?`, "Each one opens as a tab in your browser.", "Open")) return;
    for (const g of groups) for (const it of g.items) await send("focusTab", { id: g.wf.id, win: it.win, idx: it.idx });
    return;
  }
  if (kind === "remove") {
    const from = single ? `from “${single.name}”` : `from ${plural(groups.length, "workflow")}`;
    const ok = !settings.confirmDelete || await confirmDialog(`Remove ${plural(n, "tab")} ${from}?`,
      live ? "Open workflows close these tabs in the browser too. You can undo this or restore them from the trash."
        : "You can undo this or restore them from the trash in History.", "Remove", true);
    if (!ok) return;
    for (const g of groups) await send("removeTabs", { id: g.wf.id, items: g.items });
    toast(`Removed ${plural(n, "tab")}`, undoAction);
  } else {
    let toId = await chooseTarget({
      title: `${kind === "copy" ? "Copy" : "Move"} ${plural(n, "tab")} to…`,
      text: kind === "move" && live ? "Tabs moved out of an open workflow are closed in its window." : null,
      excludeId: single ? single.id : null
    });
    if (!toId) return;
    if (toId === "__new__") {
      const r = await workflowDialog({ title: "New workflow", text: `The ${plural(n, "tab")} will go into it.`, submit: "Create" });
      if (!r) return;
      const res = await send("createEmptyWorkflow", r);
      if (!res.ok) return toast("Couldn’t create the workflow");
      toId = res.result;
    }
    let done = 0;
    for (const g of groups) {
      if (g.wf.id === toId && kind === "move") continue;
      await send("moveTabs", { fromId: g.wf.id, items: g.items, toId, copy: kind === "copy" });
      done += g.items.length;
    }
    const dst = toId === LOOSE ? "Unsorted tabs" : (state.workflows[toId] ? state.workflows[toId].name : "the new workflow");
    toast(`${kind === "copy" ? "Copied" : "Moved"} ${plural(done, "tab")} to “${dst}”`, undoAction);
  }
  if (fromSelection) { selection.clear(); renderBoard(); }
}

// Dropping the ticked tabs (dragged together) into window `win` of workflow `toId`, before position `at`
// (null = at the end). The tabs from the target workflow itself go first, then the others line up behind them.
async function multiDrop(toId, win, at, copy) {
  const groups = selectedGroups().sort((a, b) => (b.wf.id === toId) - (a.wf.id === toId));
  const n = groups.reduce((s, g) => s + g.items.length, 0);
  let toWin = win, pos = at;
  for (const g of groups) {
    await send("moveTabs", { fromId: g.wf.id, items: g.items, toId, copy, win: toWin, at: pos });
    if (g.wf.id === toId && !copy) {
      // Where the moved block ends, in the window as it is now, so the next group lands right behind it.
      const wins = g.wf.windows || [];
      const picked = new Set(g.items.map(it => keyOf(it.win, it.idx)));
      const tw = wins[toWin] ? wins[toWin].tabs : [];
      const end = pos == null ? tw.length : pos;
      const stay = tw.filter((_, ti) => ti < end && !picked.has(keyOf(toWin, ti))).length;
      toWin -= wins.filter((w, wi) => wi < toWin && w.tabs.every((_, ti) => picked.has(keyOf(wi, ti)))).length;
      pos = pos == null ? null : stay + g.items.length;
    } else if (pos != null) pos += g.items.length;
  }
  const dst = wfById(toId);
  const same = groups.length === 1 && groups[0].wf.id === toId && !copy;
  toast(same ? `Moved ${plural(n, "tab")}` : `${copy ? "Copied" : "Moved"} ${plural(n, "tab")} to “${dst ? dst.name : "workflow"}”`, undoAction);
  selection.clear();
  renderBoard();
}

// A little stack of cards under the pointer while several tabs are dragged.
function dragGhost(n) {
  const rows = selectedGroups().flatMap(g => g.items.map(it => tabAt(g.wf, it))).filter(Boolean).slice(0, 3);
  const ghost = el("div", { className: "drag-ghost" }, [
    ...rows.map((t, i) => el("div", { className: "dg-row", style: `--k:${i}` }, [
      favicon(t.url, t.favIconUrl),
      el("span", { textContent: isDividerTab(t) ? (dividerOf(t.url).text || "Divider") : (t.name || t.title || t.url) })
    ])),
    el("span", { className: "dg-count", textContent: n })
  ]);
  document.body.append(ghost);
  setTimeout(() => ghost.remove(), 0);
  return ghost;
}

// ---------- right-click menu on a tab ----------
function tabMenu(e, wf, wi, ti, t) {
  e.preventDefault();
  const n = selCount();
  if (isPicked(wf.id, wi, ti) && n > 1) {
    return openMenuAt(e.clientX, e.clientY, [
      { heading: `${plural(n, "tab")} selected` },
      { icon: "external", label: `Open ${n} tabs`, action: () => bulkAction("open") },
      { icon: "arrow", label: "Move to…", action: () => bulkAction("move") },
      { icon: "copy", label: "Copy to…", action: () => bulkAction("copy") },
      { icon: "link", label: "Copy links", action: () => bulkAction("links") },
      "sep",
      { icon: "checks", label: "Select all", action: selectAllInSelected },
      { icon: "close", label: "Deselect all", hint: "Esc", action: clearSelection },
      "sep",
      { icon: "trash", label: `Delete ${n} tabs`, danger: true, action: () => bulkAction("remove") }
    ]);
  }
  const live = isLive(wf);
  const one = [{ wf, items: [{ win: wi, idx: ti }] }];
  const dv = isDividerTab(t) ? dividerOf(t.url) : null;
  const picked = isPicked(wf.id, wi, ti);
  openMenuAt(e.clientX, e.clientY, [
    { icon: "external", label: live ? "Go to tab" : "Open in a new tab", action: () => send("focusTab", { id: wf.id, win: wi, idx: ti }) },
    dv ? { icon: "edit", label: "Edit divider", action: async () => {
          const r = await dividerDialog({ title: "Edit divider tab", text: dv.text, color: dv.color, kind: "tab" });
          if (r) send("editDivider", { id: wf.id, win: wi, idx: ti, text: r.text, color: r.color, kind: "tab" });
        } }
       : { icon: "edit", label: "Edit name and link", action: () => editTabDialog(wf, wi, ti, t) },
    dv ? null : { icon: "link", label: "Copy link", action: () => bulkAction("links", one) },
    "sep",
    { icon: "arrow", label: "Move to…", action: () => bulkAction("move", one) },
    { icon: "copy", label: "Copy to…", action: () => bulkAction("copy", one) },
    { icon: "dedupe", label: "Duplicate", action: async () => {
        await send("moveTab", { from: { id: wf.id, win: wi, idx: ti }, to: { id: wf.id, win: wi, idx: ti + 1 }, copy: true });
        toast("Duplicated the tab", undoAction);
      } },
    dv ? null : { icon: "divider", label: "Add a divider above", action: () => addDividerFlow(wf, wi, ti, !t.section) },
    "sep",
    { icon: "pin", label: t.pinned ? "Unpin tab" : "Pin tab", action: async () => {
        await send("setTabPinned", { id: wf.id, win: wi, idx: ti, pinned: !t.pinned });
        toast(t.pinned ? "Unpinned the tab"
          : settings.keepPinnedTabs ? "Pinned – it now stays open in every workflow" : "Pinned the tab", undoAction);
      } },
    { icon: picked ? "close" : "check", label: picked ? "Deselect" : "Select", hint: "Ctrl+click", action: () => toggleTabSelected(wf, wi, ti, false) },
    n ? { icon: "close", label: "Deselect all", hint: "Esc", action: clearSelection } : null,
    "sep",
    { icon: "trash", label: live ? "Close tab" : (wf.id === LOOSE ? "Delete tab" : "Remove from workflow"), danger: true,
      action: async () => { await send("removeTab", { id: wf.id, win: wi, idx: ti }); toast(dv ? "Removed a divider" : "Removed a tab", undoAction); } }
  ]);
}

// ---------- tips (? button, bottom-left) ----------
const TAB_TIPS = [
  "Drag a tab to another workflow to move it – hold Ctrl while dropping to copy it",
  "Double-click a tab to open it; hover it for edit, open and remove",
  "Hover a tab’s icon and tick it to select it – then move, copy, open or delete several at once from the bar at the bottom",
  "Drag one of the selected tabs to move them all together; right-click a tab for more",
  "Press / to search all tabs and workflows",
  "Press Ctrl+K for the command palette: find any tab, switch workflows, run commands",
  "Press Ctrl+Z to undo; History has every recent change and the trash"
];
const HELP = {
  board: { title: "Board", tips: [
    "Drag a workflow’s left or right edge to change the column width – double-click the edge to reset",
    "Ctrl + scroll to zoom in and out",
    ...TAB_TIPS ] },
  list: { title: "List", tips: [
    "Ctrl + scroll to zoom in and out",
    ...TAB_TIPS ] },
  canvas: { title: "Canvas", tips: [
    "Drag a workflow by its header to place it anywhere",
    "Workflows it lands on move out of the way",
    "Drag any edge or corner to resize – workflows next to it move out of the way; double-click an edge to reset",
    "Drag the empty background or scroll to move around",
    "Ctrl + scroll to zoom; bottom-right: zoom, Fit all and Tidy up",
    ...TAB_TIPS ] }
};

function renderHelp() {
  let wrap = $("helpWrap");
  if (!wrap) {
    const btn = el("button", { id: "helpBtn", className: "help-btn", title: "Tips", "aria-label": "Tips", "aria-expanded": "false",
      html: svgIcon("help", 17), on: { click: e => { e.stopPropagation(); toggleHelp(); } } });
    wrap = el("div", { id: "helpWrap", className: "help-wrap" }, [el("div", { id: "helpPop", className: "help-pop hidden", role: "dialog" }), btn]);
    $("boardView").append(wrap);
    document.addEventListener("mousedown", e => { if (!wrap.contains(e.target)) toggleHelp(false); });
  }
  const h = HELP[settings.display] || HELP.board;
  $("helpPop").replaceChildren(
    el("div", { className: "help-title" }, [el("span", { textContent: "Tips" }), el("span", { className: "help-mode", textContent: h.title })]),
    el("ul", {}, h.tips.map(t => el("li", { textContent: t })))
  );
}

function toggleHelp(force) {
  const pop = $("helpPop");
  if (!pop) return;
  const open = force !== undefined ? force : pop.classList.contains("hidden");
  pop.classList.toggle("hidden", !open);
  $("helpBtn").classList.toggle("on", open);
  $("helpBtn").setAttribute("aria-expanded", String(open));
}

// ---------- rendering: board ----------
function renderRow(wf, wi, ti, t, hidden, q) {
  const live = isLive(wf);
  const label = t.name || t.title || t.url;
  const picked = isPicked(wf.id, wi, ti);
  const dv = isDividerTab(t) ? dividerOf(t.url) : null;
  // The site icon turns into a checkbox on hover (and for every tab once any tab is ticked).
  const check = el("input", { type: "checkbox", className: "row-check", checked: picked, tabIndex: -1,
    title: picked ? "Deselect" : "Select (Shift+click: select a range)", "aria-label": (picked ? "Deselect " : "Select ") + (dv ? "divider" : label),
    on: { click: e => { e.stopPropagation(); e.preventDefault(); toggleTabSelected(wf, wi, ti, e.shiftKey); },
          dblclick: e => e.stopPropagation() } });
  const row = el("li", { className: "tab-row" + (dv ? " divider-row" : "") + (hidden ? " hide" : "") + (picked ? " picked" : ""), draggable: true,
      title: dv ? "Divider tab – sleeps when you’re not on it" : label === t.url ? t.url : `${label}\n${t.url}`, "data-idx": ti,
      "data-gcolor": dv ? dv.color : null }, dv ? [
    el("span", { className: "fav-slot div-slot" }, [check]),
    el("span", { className: "div-line" }),
    el("span", { className: "div-text" }, [highlight(dv.text || "Divider", q)]),
    el("span", { className: "div-line" }),
    el("div", { className: "row-actions" }, [
      el("button", { title: "Change text and colour", html: svgIcon("edit", 13),
        on: { click: async e => {
          e.stopPropagation();
          const r = await dividerDialog({ title: "Edit divider tab", text: dv.text, color: dv.color, kind: "tab" });
          if (r) send("editDivider", { id: wf.id, win: wi, idx: ti, text: r.text, color: r.color, kind: "tab" });
        } } }),
      el("button", { className: "rm", title: live ? "Close this divider" : "Remove divider", html: svgIcon("close", 13),
        on: { click: async e => { e.stopPropagation(); await send("removeTab", { id: wf.id, win: wi, idx: ti }); toast("Removed a divider", undoAction); } } })
    ])
  ] : [
    el("span", { className: "tab-num", textContent: ti + 1 }),
    el("span", { className: "fav-slot" }, [favicon(t.url, t.favIconUrl), check]),
    el("div", { className: "tab-text" }, [
      el("span", { className: "tab-title" }, [highlight(label, q)]),
      el("span", { className: "tab-host" }, [highlight(hostOf(t.url), q)]),
      el("span", { className: "tab-url" }, [highlight(t.url, q)])
    ]),
    t.pinned ? el("span", { className: "pin", title: "Pinned", html: svgIcon("pin", 13) }) : null,
    el("div", { className: "row-actions" }, [
      el("button", { title: "Edit name and link", html: svgIcon("edit", 13),
        on: { click: e => { e.stopPropagation(); editTabDialog(wf, wi, ti, t); } } }),
      el("button", { title: "Add a divider above this tab", html: svgIcon("divider", 13),
        on: { click: e => { e.stopPropagation(); addDividerFlow(wf, wi, ti, !t.section); } } }),
      el("button", { title: live ? "Go to this tab" : "Open in a new tab", html: svgIcon("external", 13),
        on: { click: e => { e.stopPropagation(); send("focusTab", { id: wf.id, win: wi, idx: ti }); } } }),
      el("button", { className: "rm", title: live ? "Close this tab" : (wf.id === LOOSE ? "Delete this tab" : "Remove from workflow"), html: svgIcon("close", 13),
        on: { click: async e => { e.stopPropagation(); await send("removeTab", { id: wf.id, win: wi, idx: ti }); toast("Removed a tab", undoAction); } } })
    ])
  ]);
  // While tabs are ticked, clicking a row ticks it too; Ctrl/Cmd+click ticks without selecting first.
  row.addEventListener("click", e => {
    if (e.target.closest(".row-actions")) return;
    if (!selection.size && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    toggleTabSelected(wf, wi, ti, e.shiftKey);
  });
  row.addEventListener("dblclick", () => { if (!selection.size) send("focusTab", { id: wf.id, win: wi, idx: ti }); });
  row.addEventListener("contextmenu", e => tabMenu(e, wf, wi, ti, t));
  row.addEventListener("dragstart", e => {
    // Dragging a ticked tab drags every ticked tab along with it.
    const n = picked ? selCount() : 0;
    const multi = n > 1;
    dragging = { from: { id: wf.id, win: wi, idx: ti }, row, multi };
    e.dataTransfer.effectAllowed = "copyMove";
    const urls = multi ? selectedGroups().flatMap(g => g.items.map(it => tabAt(g.wf, it))).filter(Boolean).map(x => x.url) : [t.url];
    e.dataTransfer.setData("text/uri-list", urls.join("\r\n"));
    e.dataTransfer.setData("text/plain", urls.join("\n"));
    if (multi) e.dataTransfer.setDragImage(dragGhost(n), 18, 18);
    setTimeout(() => (multi ? document.querySelectorAll(".tab-row.picked") : [row]).forEach(r => r.classList.add("dragging")), 0);
  });
  row.addEventListener("dragend", () => {
    document.querySelectorAll(".tab-row.dragging").forEach(r => r.classList.remove("dragging"));
    clearDropUi();
    dragging = null;
    if (pendingRender) { pendingRender = false; renderBoard(); }
  });
  return row;
}

// Collapse / expand: the card's height glides to its new size and the tabs fade, instead of jumping.
function animateCollapse(card, shut) {
  const from = card.offsetHeight;                  // mid-animation this is the animated height
  if (card._fold) { card._fold.cancel(); card._fold = null; }
  card.classList.toggle("collapsed", shut);
  const to = card.offsetHeight;
  if (from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  card.classList.add("folding");                   // keeps the tabs on screen while it closes
  const ease = "cubic-bezier(.2,.8,.2,1)";
  const anim = card.animate([{ height: from + "px" }, { height: to + "px" }], { duration: 280, easing: ease });
  card.querySelectorAll(":scope > .card-body, :scope > .card-foot").forEach(b =>
    b.animate([{ opacity: shut ? 1 : 0, transform: shut ? "none" : "translateY(-6px)" },
               { opacity: shut ? 0 : 1, transform: shut ? "translateY(-6px)" : "none" }],
              { duration: shut ? 180 : 280, easing: ease }));
  card._fold = anim;
  const done = () => { if (card._fold === anim) { card._fold = null; card.classList.remove("folding"); } };
  anim.onfinish = done;
  anim.oncancel = () => card.classList.remove("folding");
}

// "Keep pinned tabs open": the pinned tabs aren't saved in any workflow but stay open in all of them,
// so every workflow shows them at the top (dimmed, not draggable). Right-click for Unpin / Close.
function sharedPinsBlock(q) {
  if (!settings.keepPinnedTabs) return null;
  const pins = (state.pinnedTabs || []).filter(p => !q || ((p.title || "") + " " + p.url).toLowerCase().includes(q));
  if (!pins.length) return null;
  const rows = pins.map(p => {
    const label = p.title || p.url;
    const row = el("li", { className: "tab-row shared-pin", title: `${label}\n${p.url}\nPinned – stays open in every workflow` }, [
      el("span", { className: "fav-slot" }, [favicon(p.url, p.favIconUrl)]),
      el("div", { className: "tab-text" }, [
        el("span", { className: "tab-title" }, [highlight(label, q)]),
        el("span", { className: "tab-host" }, [highlight(hostOf(p.url), q)]),
        el("span", { className: "tab-url" }, [highlight(p.url, q)])
      ]),
      el("span", { className: "pin", html: svgIcon("pin", 13) }),
      el("div", { className: "row-actions" }, [
        el("button", { title: "Unpin – it becomes a normal tab of the workflow you’re in", html: svgIcon("pin", 13),
          on: { click: e => { e.stopPropagation(); send("unpinShared", { url: p.url }); } } }),
        el("button", { title: "Go to this tab", html: svgIcon("external", 13),
          on: { click: e => { e.stopPropagation(); send("focusPinned", { url: p.url }); } } }),
        el("button", { className: "rm", title: "Close this pinned tab", html: svgIcon("close", 13),
          on: { click: e => { e.stopPropagation(); send("closeShared", { url: p.url }); } } })
      ])
    ]);
    row.addEventListener("dblclick", () => send("focusPinned", { url: p.url }));
    row.addEventListener("contextmenu", e => {
      e.preventDefault();
      openMenuAt(e.clientX, e.clientY, [
        { heading: "Pinned in every workflow" },
        { icon: "external", label: "Go to tab", action: () => send("focusPinned", { url: p.url }) },
        { icon: "link", label: "Copy link", action: async () => {
            try { await navigator.clipboard.writeText(p.url); toast("Copied the link"); } catch (_) { toast("Couldn’t access the clipboard"); }
          } },
        "sep",
        { icon: "pin", label: "Unpin tab", action: () => { send("unpinShared", { url: p.url }); toast("Unpinned – it’s now a tab of the workflow you’re in"); } },
        { icon: "close", label: "Close tab", danger: true, action: () => send("closeShared", { url: p.url }) }
      ]);
    });
    return row;
  });
  return el("div", { className: "shared-pins" }, [
    el("div", { className: "win-label", html: svgIcon("pin", 11) + "<span>Pinned · in every workflow</span>" }),
    el("ul", { className: "tab-list" }, rows)
  ]);
}

function renderCard(wf, i) {
  const q = query.trim().toLowerCase();
  const active = isActive(wf), live = isLive(wf);
  const nameMatch = !!q && (wf.name + " " + (wf.note || "") + " " + (wf.tags || []).join(" ")).toLowerCase().includes(q);
  const isCollapsed = collapsed.has(wf.id) && !q;
  const tabsN = countTabs(wf);
  const windows = wf.windows && wf.windows.length ? wf.windows : [{ tabs: [] }];

  const loose = wf.id === LOOSE;
  const card = el("article", {
    className: "card" + (active ? " active" : "") + (isCollapsed ? " collapsed" : "") + (loose ? " loose" : ""),
    style: `--i:${i}`, "data-id": wf.id, "data-color": wf.color || null
  });

  const meta = el("div", { className: "card-meta" }, [
    el("span", { textContent: plural(tabsN, "tab") + (wf.windows && wf.windows.length > 1 ? ` · ${plural(wf.windows.length, "window")}` : "") }),
    el("span", { textContent: "· " + timeAgo(wf.savedAt) }),
    active ? el("span", { className: "chip" + (live ? " live" : ""), textContent: live ? "OPEN · LIVE" : "OPEN",
      title: live ? "Changes here also change your open tabs" : "Autosave is off for this workflow" }) : null,
    wf.autosave === false ? el("span", { className: "chip", textContent: "MANUAL", title: "Autosave off" }) : null
  ]);

  const collapseBtn = el("button", { className: "iconbtn flat collapse", title: isCollapsed ? "Expand" : "Collapse", html: svgIcon("chevron", 16),
    on: { click: () => {
      const shut = !collapsed.has(wf.id);
      shut ? collapsed.add(wf.id) : collapsed.delete(wf.id);
      writeLocal("tm-collapsed", [...collapsed]);
      collapseBtn.title = shut ? "Expand" : "Collapse";
      animateCollapse(card, shut);
    } } });

  const head = loose ? el("div", { className: "card-head" }, [
    el("div", { className: "tile", html: svgIcon("list", 19) }),
    el("div", { className: "card-title" }, [
      el("div", { className: "card-name" }, [highlight(wf.name, q)]),
      el("div", { className: "card-meta", textContent: `${plural(tabsN, "tab")} · not in any workflow` })
    ]),
    el("div", { className: "card-actions" }, [
      el("button", { className: "iconbtn flat", title: "New tab", html: svgIcon("plus", 16), on: { click: () => newTabDialog(LOOSE) } }),
      tabsN ? el("button", { className: "iconbtn flat danger", title: "Delete all unsorted tabs", html: svgIcon("trash", 15),
        on: { click: async () => {
          if (await confirmDialog("Delete all unsorted tabs?", `${plural(tabsN, "tab")} will be removed.`, "Delete", true)) send("clearWorkflow", { id: LOOSE });
        } } }) : null,
      collapseBtn
    ])
  ]) : el("div", { className: "card-head" }, [
    el("div", { className: "tile", html: svgIcon(resolveIcon(wf.icon), 19), title: "Change icon", style: "cursor:pointer",
      on: { click: () => editWorkflow(wf) } }),
    el("div", { className: "card-title" }, [
      el("div", { className: "card-name", title: "Double-click to rename", on: { dblclick: () => editWorkflow(wf) } }, [highlight(wf.name, q)]),
      meta
    ]),
    el("div", { className: "card-actions" }, [
      (() => {
        const showOnly = active && settings.switchMode === "windows" && !isFocused(wf);
        const off = active && !showOnly;
        return el("button", { className: "iconbtn flat",
          title: off ? "Already open" : showOnly ? "Show its window"
            : settings.switchMode === "windows" ? "Open in a new window" : "Open this workflow (closes and saves current tabs)",
          html: svgIcon("switch", 16), disabled: off, style: off ? "opacity:.35;cursor:default" : null,
          on: { click: () => openWorkflow(wf) } });
      })(),
      el("button", { className: "iconbtn flat", title: "More", html: svgIcon("more", 16), on: { click: e => cardMenu(e.currentTarget, wf) } }),
      el("button", { className: "iconbtn flat danger", title: "Delete workflow", html: svgIcon("close", 15), on: { click: () => deleteWorkflow(wf) } }),
      collapseBtn
    ])
  ]);

  let matches = 0;
  const body = el("div", { className: "card-body" });
  if (!loose) { const pins = sharedPinsBlock(q); if (pins) body.append(pins); }
  windows.forEach((w, wi) => {
    if (windows.length > 1) body.append(el("div", { className: "win-label", textContent: `Window ${wi + 1}` }));
    const ul = el("ul", { className: "tab-list" + (w.tabs.length ? "" : " empty-list"), "data-id": wf.id, "data-win": wi });
    if (!w.tabs.length) ul.textContent = loose ? "Drop tabs here to keep them outside any workflow" : "Drop tabs here";
    let lastGroup = null;
    w.tabs.forEach((t, ti) => {
      const m = !q || nameMatch || ((t.name || "") + " " + (t.title || "") + " " + t.url).toLowerCase().includes(q);
      if (m && q) matches++;
      const g = t.group && w.groups && w.groups[t.group];
      if (t.section && !q && !loose) ul.append(labelRow(wf, wi, ti, t.section));
      if (t.group !== lastGroup) {
        lastGroup = t.group;
        if (g && !q) ul.append(groupHeader(g, w.tabs.filter(x => x.group === t.group).length));
      }
      const r = renderRow(wf, wi, ti, t, !m, nameMatch ? "" : q);
      if (g) { r.classList.add("in-group"); r.dataset.gcolor = g.color || "grey"; }
      ul.append(r);
    });
    attachListDrop(ul);
    body.append(ul);
  });

  // add-tab footer
  const foot = el("div", { className: "card-foot" });
  const showAddLink = () => {
    foot.innerHTML = "";
    foot.append(el("button", { className: "add-link", html: svgIcon("plus", 14) + "Add tab", on: { click: showAddInput } }));
  };
  const showAddInput = () => {
    const input = el("input", { type: "text", placeholder: "Paste a link and press Enter" });
    const submit = async () => {
      const url = input.value.trim();
      if (!url) return showAddLink();
      await send("addTab", { id: wf.id, win: Math.max(0, (wf.windows || []).length - 1), url });
      toast(`Added to “${wf.name}”`);
    };
    input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); if (e.key === "Escape") showAddLink(); });
    input.addEventListener("blur", () => { if (!input.value.trim()) showAddLink(); });
    foot.innerHTML = "";
    foot.append(el("div", { className: "add-tab" }, [input,
      el("button", { className: "btn sm primary", textContent: "Add", on: { mousedown: e => e.preventDefault(), click: submit } })]));
    input.focus();
  };
  showAddLink();

  card.append(head, ...(loose ? [] : cardExtras(wf)), body, foot);
  attachCardDrop(card, head, wf);
  enableCardMove(card, head);
  enableCardResize(card);
  if (q && !nameMatch && !matches) card.classList.add("hidden");
  if (tagFilter && (loose || !(wf.tags || []).includes(tagFilter))) card.classList.add("hidden");
  return card;
}

function renderSub() {
  const list = sortedWorkflows();
  const tabs = list.reduce((n, w) => n + countTabs(w), 0);
  $("sub").textContent = `${plural(list.length, "workflow")} · ${plural(tabs, "saved tab")} · autosave ${settings.autosaveEnabled ? "on" : "paused"}`;
}

function renderBoard() {
  const canvasMode = settings.display === "canvas";
  if (canvasMode && !canvasLoaded) { loadCanvas().then(renderBoard); return; }
  if (dragging || movingCard) { pendingRender = true; return; }
  pruneSelection();
  renderSelBar();
  const board = $("board");
  board.innerHTML = "";
  board.removeAttribute("style");
  board.classList.toggle("animate", firstRender);
  firstRender = false;
  const list = sortedWorkflows();
  $("emptyBoard").classList.toggle("hidden", list.length > 0 || state.looseTabs.length > 0);
  const cards = (list.length || state.looseTabs.length) ? [looseWorkflow(), ...list] : [];
  const host = canvasMode ? el("div", { className: "canvas-world" }) : board;
  if (canvasMode) board.append(host);
  cards.forEach((wf, i) => host.append(renderCard(wf, i)));
  if (canvasMode) {
    layoutCanvas([...host.children]);
    board.append(canvasControls());
    applyView();
  } else { applyBoardZoom(); applyBoardWidth(); }
  const q = query.trim();
  const visible = board.querySelectorAll(".card:not(.hidden)").length;
  // The line under the toolbar is only used for search results now; tips live behind the ? button.
  $("hint").textContent = q
    ? (visible ? `Showing matches for “${q}” in ${plural(visible, "workflow")}` : `No tabs match “${q}”`)
    : "";
  $("hint").classList.toggle("hidden", !q);
  renderHelp();
  renderSub();
}

// ---------- rendering: settings ----------
function segText(key, options) {
  const seg = el("div", { className: "seg text" });
  for (const [value, label] of options) {
    seg.append(el("button", { type: "button", textContent: label, className: settings[key] === value ? "on" : "",
      on: { click: () => setSetting(key, value) } }));
  }
  return seg;
}

function switchCtl(key) {
  return el("label", { className: "switch" }, [
    el("input", { type: "checkbox", checked: !!settings[key], on: { change: e => setSetting(key, e.target.checked) } }),
    el("span", { className: "track" })
  ]);
}

function selectCtl(key, options) {
  const s = el("select", { on: { change: e => {
    const v = e.target.value;
    setSetting(key, typeof DEFAULT_SETTINGS[key] === "number" ? Number(v) : v);
  } } });
  for (const [value, label] of options) s.append(el("option", { value: String(value), textContent: label, selected: settings[key] === value }));
  return s;
}

function row(label, desc, control) {
  return el("div", { className: "set-row" }, [
    el("div", { className: "set-text" }, [el("div", { className: "set-label", textContent: label }), desc ? el("div", { className: "set-desc", textContent: desc }) : null]),
    control
  ]);
}

const ACCENTS = [
  ["mono", "linear-gradient(135deg, #141416 50%, #f1f1f3 50%)", "Black & white"],
  ["blue", "#3466f6", "Blue"], ["violet", "#7c5cf0", "Violet"], ["green", "#1f9d61", "Green"],
  ["orange", "#e8742a", "Orange"], ["rose", "#e0457b", "Rose"]
];

// ---------- Settings: side menu + pages ----------
const SETTINGS_PAGES = [
  ["appearance", "Appearance", "brush"],
  ["saving", "Saving", "save"],
  ["switching", "Switching", "switch"],
  ["backups", "Backups", "calendar"],
  ["sync", "Sync", "cloud", "Beta"],
  ["data", "Data", "download"],
  ["about", "About", "help"]
];
let settingsPage = readLocal("tm-settings-page", "appearance");
if (!SETTINGS_PAGES.some(p => p[0] === settingsPage)) settingsPage = "appearance";

function openSettingsPage(id) {
  settingsPage = id;
  writeLocal("tm-settings-page", id);
  if ($("settingsView").classList.contains("hidden")) setView("settings");
  else renderSettings();
}

let settingsRenderId = 0;
let lastSettingsPage = null;
async function renderSettings() {
  const myId = ++settingsRenderId;
  const section = (title, rows) => el("section", { className: "set-section" }, [title ? el("h2", { textContent: title }) : null, ...rows]);
  const page = SETTINGS_PAGES.find(p => p[0] === settingsPage) || SETTINGS_PAGES[0];
  const content = await settingsPageContent(page[0], section);
  if (myId !== settingsRenderId) return;          // a newer render started meanwhile

  const nav = el("nav", { className: "set-nav", "aria-label": "Settings" }, SETTINGS_PAGES.map(([id, label, icon, badge]) =>
    el("button", { className: "set-nav-item" + (id === page[0] ? " on" : ""), html: svgIcon(icon, 16), "aria-current": id === page[0] ? "page" : null,
      on: { click: () => openSettingsPage(id) } }, [el("span", { textContent: label }), badge ? el("span", { className: "beta-badge", textContent: badge }) : null])));
  const target = $("settings");
  const fresh = !target.querySelector(".settings-layout");
  // Opening Settings or switching to another page animates; a redraw of the same page (a setting changed) doesn't.
  const switched = !fresh && lastSettingsPage !== page[0];
  lastSettingsPage = page[0];
  target.replaceChildren(el("div", { className: "settings-layout" }, [
    nav,
    el("div", { className: "set-panel" + (fresh ? "" : switched ? " page-in" : " no-anim") }, [el("h1", { className: "set-page-title" }, [page[1], page[3] ? el("span", { className: "beta-badge big", textContent: page[3] }) : null]), ...content])
  ]));
  moveSlider(nav, "settingsNav");      // the menu is rebuilt: its highlight slides from the page you were on
}

async function settingsPageContent(id, section) {
  if (id === "appearance") {
    const swatches = el("div", { className: "swatches" },
      ACCENTS.map(([v, bg, label]) => el("button", { className: "swatch" + (settings.accent === v ? " on" : ""), title: label,
        style: `background:${bg}`, "aria-label": label, on: { click: () => setSetting("accent", v) } })));
    return [
      section("Theme & colours", [
        row("Theme", "Light, dark, or follow your system setting.", segText("theme", [["system", "System"], ["light", "Light"], ["dark", "Dark"]])),
        row("Accent colour", "Used for buttons, the open workflow and switches.", swatches),
        row("Background", "Background of this page. Patterns move with the canvas.", selectCtl("background", [["plain", "Plain"], ["dots", "Dots"], ["grid", "Grid"], ["graph", "Graph paper"], ["lines", "Ruled lines"],
          ["diagonal", "Diagonal lines"], ["gradient", "Soft gradient (accent)"], ["aurora", "Aurora"], ["sunset", "Sunset"]]))
      ]),
      section("Workflows page", [
        row("Layout", "Board: columns that resize with the window. List: one column. Canvas: drag workflows anywhere on an endless canvas.", segText("display", [["board", "Board"], ["list", "List"], ["canvas", "Canvas"]])),
        row("Tab display", "Compact: one line per tab. Comfortable: title and website. Detailed: title, full link and position. Icons: a grid of site icons (hover for the name).",
          segText("density", [["compact", "Compact"], ["comfortable", "Comfortable"], ["detailed", "Detailed"], ["icons", "Icons"]]))
      ]),
      section("Motion", [
        row("Reduce motion", "Turn off animations, sliding highlights and page transitions here and in the popup. Your system’s “reduce motion” setting is always respected too.", switchCtl("reduceMotion"))
      ])
    ];
  }
  if (id === "saving") {
    return [section("Autosave", [
      row("Autosave", "Save the session (and the open workflow, if its autosave is on) on every tab change.", switchCtl("autosaveEnabled")),
      row("Autosave delay", "How long to wait after the last tab change before saving.",
        selectCtl("autosaveDelay", [[400, "Instant (0.4 s)"], [1000, "1 second"], [3000, "3 seconds"], [10000, "10 seconds"]])),
      row("Autosave new workflows", "New workflows start with autosave turned on.", switchCtl("newWorkflowAutosave")),
      row("Skip empty New Tab pages", "Don’t store blank New Tab pages in sessions and workflows.", switchCtl("skipNewTabs")),
      row("Skip duplicate tabs", "Store a link only once per window. The tab you’re on and pinned tabs are always kept; your open tabs aren’t closed.", switchCtl("skipDuplicateTabs"))
    ])];
  }
  if (id === "switching") {
    return [section("Opening workflows", [
      row("Opening a workflow", "Replace your current tabs in this window, or open each workflow in its own window so several can be open at once.",
        segText("switchMode", [["replace", "Replace current"], ["windows", "New window"]])),
      row("Save memory after switching", "Background tabs finish loading and are then put to sleep until you click them. Tabs are never interrupted while loading, and a tab that’s stuck when you open it is reloaded.", switchCtl("lazyLoad")),
      row("Ask before switching", "Always confirm before closing your tabs to open another workflow. You’re always asked when unsaved tabs would be lost.", switchCtl("confirmSwitch")),
      row("Keep this page open", "Re-open the Session Manager after switching workflows.", switchCtl("keepManagerOpen"))
    ]), section("Pinned tabs", [
      row("Keep pinned tabs open", "Pinned tabs belong to no workflow: switching only closes and opens your normal tabs, and pinned tabs stay where they are. Unpin a tab to make it part of the workflow you’re in.",
        switchCtl("keepPinnedTabs")),
      settings.keepPinnedTabs ? row("Pinned tabs and windows",
        "Stay in their window: pinned tabs stay where they are. Copy into every workflow: each workflow you open in a new window gets your pinned tabs. Copy into every window: every new browser window gets them, also ones you open yourself. On all your browsers: every window, and the same pinned tabs on your other browsers too (needs sync in Settings → Sync). Tabs you pin later are included from then on.",
        selectCtl("pinnedScope", [["window", "Stay in their window"], ["workflow", "Copy into every workflow"], ["every", "Copy into every window"], ["sync", "Every window, on all your browsers"]])) : null,
      settings.keepPinnedTabs ? row("Workflows with pinned tabs saved in them", "Workflows saved before this was on can still have pinned tabs in them. When you open one: ask each time, pin them (they then stay open like your other pinned tabs), open them as normal tabs, or remove them from the workflow.",
        selectCtl("pinnedOnOpen", [["ask", "Ask me"], ["pin", "Pin them"], ["unpin", "Open as normal tabs"], ["remove", "Remove them"]])) : null
    ]), section("Dividers", [
      row("Put divider tabs to sleep", "Divider tabs are put to sleep whenever you’re on another tab, so they use almost no memory. Clicking one wakes it up instantly.", switchCtl("dividerSleep")),
      row("Insert a divider tab", "Adds a divider right after the tab you’re on – also from the divider button in the popup. Click the shortcut to change it on the browser’s shortcuts page.",
        el("button", { type: "button", className: "keycap edit", textContent: await browserShortcut("insert-divider") || "Not set",
          title: "Change this shortcut on the browser’s shortcuts page",
          on: { click: () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }) } }))
    ])];
  }
  if (id === "backups") return [await backupSection(section)];
  if (id === "sync") return syncPage(section);
  if (id === "data") {
    const fileBtn = el("button", { className: "btn sm", html: svgIcon("upload", 14) + "Import", on: { click: () => $("fileInput").click() } });
    const exportBtn = el("button", { className: "btn sm", html: svgIcon("download", 14) + "Export all", on: { click: exportAll } });
    const wipeBtn = el("button", { className: "btn sm danger", html: svgIcon("trash", 14) + "Delete all", on: { click: async () => {
      if (await confirmDialog("Delete all workflows?", "Every saved workflow and the session backup will be removed. Your open tabs stay open.", "Delete everything", true)) {
        await send("clearAllData");
        toast("All workflows deleted", undoAction);
      }
    } } });
    return [
      section("Export & import", [
        row("Export & import", "Export all workflows to a JSON file, or import a JSON export or a text file of links.",
          el("div", { className: "row-btns" }, [fileBtn, exportBtn]))
      ]),
      section("Deleting & undo", [
        row("Ask before deleting", "Confirm before deleting a workflow or removing tabs from one. Either way, Undo and the trash can bring them back.", switchCtl("confirmDelete")),
        row("Keep deleted items", "How long deleted workflows and tabs stay in History & trash (at most 60 items).",
          selectCtl("trashDays", [[7, "7 days"], [30, "30 days"], [90, "90 days"], [0, "Until the trash is full"]])),
        row("Undo steps", "How many recent changes you can undo. More steps use more storage on this device.",
          selectCtl("historyMax", [[10, "10"], [25, "25"], [50, "50"], [100, "100"]]))
      ]),
      section("Reset", [
        row("Reset settings", "Put every setting back to how it was when you installed Tab Workflows. Your workflows stay.",
          el("button", { className: "btn sm", html: svgIcon("undo", 14) + "Reset settings", on: { click: async () => {
            if (!(await confirmDialog("Reset all settings?", "Theme, layout, autosave, switching, backups, sync method and every other setting go back to their defaults. Your workflows, tabs and canvas layout are not touched.", "Reset settings"))) return;
            await chrome.storage.local.set({ settings: {} });
            toast("Settings reset to defaults");
          } } })),
        row("Delete everything", "Remove all workflows and the session backup.", wipeBtn)
      ])
    ];
  }
  // about
  let bytes = 0;
  try { bytes = await chrome.storage.local.getBytesInUse(null); } catch (_) {}
  const version = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "";
  const notice = (await chrome.storage.local.get("updateNotice")).updateNotice;
  const keys = [["Ctrl K", "Command palette"], ["Ctrl Z", "Undo"], ["Alt Shift D", "Insert a divider tab (in any tab)"], ["/", "Search the board"], ["Ctrl + scroll", "Zoom"], ["Esc", "Close / stop selecting"]];
  return [
    section("Tab Workflows", [
      row("Version " + version, `${(bytes / 1024).toFixed(1)} KB stored on this device`,
        notice ? el("button", { className: "btn sm primary", textContent: `Update to ${notice.latest}`, on: { click: () => showUpdateScreen(notice) } }) : el("span")),
      row("Welcome screen", "The short introduction shown after installing.", el("button", { className: "btn sm", textContent: "Show", on: { click: () => showWelcome() } }))
    ]),
    section("Keyboard", [
      el("div", { className: "set-row muted", textContent: "These shortcuts only work in the Session Manager – except Alt Shift D, which works in every tab. Click a shortcut, then press the new keys (Esc cancels)." }),
      ...HOTKEY_ACTIONS.map(([id, what]) => row(what, null, hotkeyCap(id))),
      row("Insert a divider tab (in any tab)", "Set by the browser, so it’s changed on the browser’s shortcuts page.",
        el("div", { className: "row-btns" }, [el("kbd", { className: "keycap", textContent: await browserShortcut("insert-divider") || "Not set" }),
          el("button", { className: "btn sm", textContent: "Change", on: { click: () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }) } })])),
      row("Zoom", null, el("kbd", { className: "keycap", textContent: "Ctrl + scroll" })),
      row("Close / stop selecting", null, el("kbd", { className: "keycap", textContent: "Esc" }))
    ])
  ];
}

// ---------- Sync page ----------
const SYNC_METHODS = [
  ["off", "Off", "close", "Workflows stay in this browser only."],
  ["chrome", "Chrome profile", "cloud", "Chrome only. Follows your Chrome account to other computers (up to about 100 KB)."],
  ["folder", "Shared folder", "folder", "A folder on this PC – or in Dropbox, OneDrive or Google Drive to reach other computers. Syncs while this page is open."],
  ["gist", "GitHub Gist", "code", "Automatic. Kept as a private, encrypted gist on your GitHub account."],
  ["server", "Your own server", "globe", "Automatic. A free Cloudflare Worker that you set up once."],
  ["webdav", "WebDAV", "laptop", "Automatic. Nextcloud, Koofr, ownCloud or another WebDAV storage you already use."]
];
const MULTI_SYNC = ["folder", "gist", "server", "webdav"];

// true when access was given; `askHostAccess.prompted` says whether Chrome had to ask (false: allowed already).
async function askHostAccess(urls) {
  const origins = WebDAV.accessPatterns(urls);   // (webdav.js – works for any address)
  askHostAccess.prompted = false;
  if (!origins.length) return false;
  // Both start right away, while the click still counts (an await before request() could lose Chrome's prompt).
  const had = chrome.permissions.contains({ origins }).catch(() => false);
  const asked = chrome.permissions.request({ origins }).catch(() => false);
  askHostAccess.prompted = !(await had);
  return asked;
}

// `passphrase`: only right after you typed it – lets this sync read a file an older version wrote.
async function runSync(force = false, passphrase = "") {
  if (settings.syncMethod === "folder") return folderSyncNow({ ask: true, force, passphrase });
  if (MULTI_SYNC.includes(settings.syncMethod)) {
    const r = await send("multiSyncNow", { force, passphrase });
    return r.result;
  }
  return null;
}

function syncLabel(min) {
  const m = Number(min) || 0;
  if (m < 1) return `${Math.round(m * 60)} seconds`;
  if (m >= 60) return m === 60 ? "1 hour" : `${m / 60} hours`;
  return m === 1 ? "1 minute" : `${m} minutes`;
}

// Green dot "Connected" when the last sync worked, red dot "Disconnected" when it failed.
// `method` given: a Disconnect button next to it (once this browser has tried to sync).
function connectionRow(st, idleText, method) {
  const state = !st ? "idle" : st.ok ? "on" : "off";
  const label = { on: "Connected", off: "Disconnected", idle: "Not connected yet" }[state];
  const detail = state === "on" ? `Last synced ${timeAgo(st.at)}.`
    : state === "off" ? `${st.error || "The last sync failed."} · ${timeAgo(st.at)}` : idleText;
  const pill = el("span", { className: "conn-pill " + state, role: "status" }, [el("span", { className: "conn-dot" }), label]);
  // Red (the last sync failed): Reconnect tries again right away. Green: Disconnect.
  const action = !(method && st) ? null : state === "off"
    ? el("button", { className: "btn sm primary", textContent: "Reconnect", on: { click: e => reconnectSync(method, e.currentTarget) } })
    : el("button", { className: "btn sm", textContent: "Disconnect", on: { click: () => disconnectSync(method) } });
  return row("Connection", detail, action ? el("div", { className: "row-btns" }, [pill, action]) : pill);
}

async function reconnectSync(method, btn) {
  btn.disabled = true; btn.textContent = "Reconnecting…";
  try {
    if (method === "chrome") {
      const r = await send("syncNow");
      toast(r.ok && r.result && r.result.ok ? "Reconnected – synced to your Chrome profile" : "Still can’t sync – " + ((r.result && r.result.error) || r.error || "try again later"));
    } else {
      const st = await syncOrOfferOverwrite();
      if (st && st.ok) toast("Reconnected");
    }
  } finally { btn.disabled = false; btn.textContent = "Reconnect"; renderSettings(); }
}

// Stop syncing this browser and forget how it connected (login, token, address). Your workflows and the
// passphrase stay; the synced copy elsewhere isn't touched.
const SYNC_LOGIN_FIELDS = {
  webdav: { webdavUrl: null, webdavUser: null, webdavPass: null, webdavConnected: null, webdavReady: null },
  gist: { gistToken: null, gistVerified: null },
  server: { serverUrl: null },
  folder: {},
  chrome: {}
};
// Forget the saved passphrase (its salt and server id; the key made from it is useless without the salt).
async function forgetPassphrase() {
  const { syncConfig = {} } = await chrome.storage.local.get("syncConfig");
  const next = { ...syncConfig };
  for (const k of ["passphrase", "hasPassphrase", "keySalt", "syncId", "passMethod"]) delete next[k];
  passDraft = "";
  await chrome.storage.local.set({ syncConfig: next });
}

async function disconnectSync(method) {
  const name = (SYNC_METHODS.find(m => m[0] === method) || [, "sync"])[1];
  const forget = method === "folder" ? "the chosen folder" : method === "chrome" ? null : "the login saved for it";
  if (!(await confirmDialog(`Disconnect ${name}?`,
    `This browser stops syncing${forget ? ` and forgets ${forget}` : ""}. Your workflows stay here, and the synced copy isn’t deleted – you can connect again any time.`, "Disconnect", true))) return;
  await saveSyncFields(SYNC_LOGIN_FIELDS[method] || {});
  if (method !== "chrome") await forgetPassphrase();   // connecting again means creating a passphrase again
  if (method === "folder") await idbSet("syncFolder", null).catch(() => {});
  for (const k of Object.keys(secretSavedAt)) delete secretSavedAt[k];
  webdavDraft = null; webdavProblem = "";
  await chrome.storage.local.remove(["multiSyncStatus", method === "chrome" ? "syncStatus" : null].filter(Boolean));
  await setSetting("syncMethod", "off");
  toast(`Disconnected from ${name}`);
}

// Is this browser connected to the method's storage (folder chosen, token or address saved)?
async function methodLinked(method, cfg) {
  if (method === "folder") return !!(await idbGet("syncFolder").catch(() => null));
  if (method === "gist") return !!(cfg.gistToken && (cfg.gistVerified || cfg.gistId));   // a token Connect checked (or that already synced)
  if (method === "server") return !!cfg.serverUrl;
  if (method === "webdav") return webdavLinked(cfg);
  return false;
}
const CHANGE_PASS_TEXT = "The synced copy is updated with the old passphrase first, then encrypted again with the new one. Your other browsers then need the new passphrase.";
const hasSyncPassphrase = async () => {
  const { syncConfig = {} } = await chrome.storage.local.get("syncConfig");
  return !!(syncConfig.hasPassphrase || syncConfig.passphrase);
};

// After connecting: sync if there's a passphrase already, else show the passphrase step.
async function afterConnect(what) {
  if (await hasSyncPassphrase()) return syncOrOfferOverwrite();
  toast(`${what} – now choose your passphrase`);
  focusSoon("passphrase");
  renderSettings();
}

// Check a GitHub token before saving it. "" when it works, else what's wrong.
async function testGistToken(token) {
  try {
    const r = await fetch("https://api.github.com/gists?per_page=1", { headers: { Authorization: "token " + token, Accept: "application/vnd.github+json" }, cache: "no-store" });
    if (r.status === 401) return "That GitHub token isn’t valid – create a new one.";
    if (r.status === 403) return "That token may not use gists – tick “gist” when you create it.";
    return r.ok ? "" : `GitHub answered with error ${r.status}.`;
  } catch (_) { return "Couldn’t reach GitHub – check your internet connection."; }
}

function syncToast(st) {
  if (!st) return;
  toast(st.ok ? (st.fromOther ? "Synced – workflows from your other browsers are here" : "Synced") : "Sync problem: " + st.error);
}

// Sync, and if the synced copy there was made with another passphrase (e.g. left from an earlier setup),
// ask right away whether to replace it instead of just failing.
const unreadableCopy = err => /wrong passphrase|another passphrase|different (one|passphrase)/i.test(String(err || ""));
async function syncOrOfferOverwrite(force = false, passphrase = "") {
  let st = await runSync(force, passphrase);
  if (st && !st.ok && unreadableCopy(st.error) &&
      await confirmDialog("There’s already a synced copy",
        "It was made with a different passphrase, so it can’t be read with this one. Replace it with this browser’s workflows, encrypted with the passphrase saved here? Your other browsers then need this passphrase. Cancel if you’d rather type the passphrase you used before.",
        "Replace it", true)) st = await runSync(true);
  syncToast(st);
  return st;
}

async function syncPage(section) {
  const { syncConfig = {}, multiSyncStatus = null, syncStatus = null } =
    await chrome.storage.local.get(["syncConfig", "multiSyncStatus", "syncStatus"]);
  const method = settings.syncMethod || "off";
  const multi = MULTI_SYNC.includes(method);
  const out = [];
  out.push(el("div", { className: "beta-note" }, [el("span", { className: "beta-badge", textContent: "Beta" }),
    el("span", { textContent: "Sync between browsers is new and still being tested. Daily backups and the 3 backup copies per workflow keep you safe if something goes wrong." })]));

  out.push(section("How to sync", [el("div", { className: "method-grid" }, SYNC_METHODS.map(([id, label, icon, desc]) =>
    el("button", { className: "method" + (id === method ? " on" : ""), "aria-pressed": String(id === method),
      on: { click: async () => {
        if (id === method) return;
        // Every connection gets its own passphrase: one saved for another method isn't carried over.
        if (MULTI_SYNC.includes(id) && syncConfig.passMethod !== id) await forgetPassphrase();
        await setSetting("syncMethod", id);
        if (id === "chrome") { const r = await send("syncNow"); toast(r.ok && r.result && r.result.ok ? "Synced to your Chrome profile" : "Chrome profile sync turned on"); }
        else if (MULTI_SYNC.includes(id) && syncConfig.passMethod === id && (syncConfig.hasPassphrase || syncConfig.passphrase) && id !== "folder"
                 && !(id === "webdav" && !syncConfig.webdavConnected && !syncConfig.webdavReady)
                 && !(id === "gist" && !syncConfig.gistTokenEnc) && !(id === "server" && !syncConfig.serverUrlEnc)) syncToast(await runSync());
      } } }, [
      el("span", { className: "tile sm", html: svgIcon(icon, 16) }),
      el("span", { className: "method-text" }, [el("span", { className: "method-name", textContent: label }), el("span", { className: "method-desc", textContent: desc })]),
      el("span", { className: "method-check", html: svgIcon("check", 14) })
    ])))]));

  if (method === "chrome") out.push(await chromeSyncSection(section, syncStatus));

  if (multi) {
    // Set up one step at a time (see "Setting up a connection" below); the rest shows once it's done.
    const hasPass = !!(syncConfig.hasPassphrase || syncConfig.passphrase);
    const cfg = await unlockSyncConfig(await protectSyncConfig(syncConfig));   // decrypted only to fill the fields
    const steps = method === "webdav" ? webdavSteps(cfg)
      : method === "folder" ? await folderSteps()
      : { rows: await methodRows(method, cfg), linked: await methodLinked(method, cfg),
          hint: "Step 1 of 2 · " + (method === "gist" ? "Connect your GitHub account." : "Connect your server.") };
    const setup = !(steps.linked && hasPass);
    const cst = multiSyncStatus && multiSyncStatus.method === method ? multiSyncStatus : null;
    const hint = !setup ? null : steps.linked && method !== "webdav" ? "Step 2 of 2 · Choose your sync passphrase and press Save." : steps.hint;
    out.push(section(SYNC_METHODS.find(m => m[0] === method)[1], [
      setup ? connectionRow(null, "Not connected yet – finish the steps below.") : connectionRow(cst, "Save a passphrase and press Connect.", method),
      hint ? el("div", { className: "set-row muted", textContent: hint }) : null,
      ...steps.rows,
      steps.linked ? passphraseRow(syncConfig, hasPass, steps.linked) : null].filter(Boolean)));
    if (setup) return out;

    out.push(section("Settings", [
      row("Sync settings",
        "Also sync your settings (theme, autosave, switching, sync timing…) with your other browsers that have this on. How each browser syncs, board zoom and column width stay per browser.",
        switchCtl("syncSettings"))
    ]));

    // When to sync (gist / server / webdav run in the background)
    if (method !== "folder") {
      out.push(section("Automatic sync", [
        row("Sync every", "How often this browser checks for changes from your other browsers.",
          selectCtl("syncInterval", [[1, "1 minute"], [2, "2 minutes"], [5, "5 minutes"], [10, "10 minutes"], [15, "15 minutes"], [30, "30 minutes"], [60, "1 hour"]])),
        row("After a change", "How long to wait after you change something before it’s synced.",
          selectCtl("syncDelay", [[0.5, "30 seconds"], [1, "1 minute"], [2, "2 minutes"], [5, "5 minutes"]])),
        row("Apply changes when the browser starts",
          "When this browser opens, check what your other browsers changed while it was closed – tabs removed, added or edited there are closed, opened or updated here. Off: the tabs this browser opens with win.",
          switchCtl("syncApplyOnStartup"))
      ]));
    }

    // Status
    const st = multiSyncStatus && multiSyncStatus.method === method ? multiSyncStatus : null;
    const wrongPass = st && !st.ok && /passphrase/i.test(st.error || "");
    out.push(section("Status", [
      row(st ? (st.ok ? "Synced" : "Couldn’t sync") : "Not synced yet",
        st ? (st.ok ? `${timeAgo(st.at)} · ${plural(st.workflows || 0, "workflow")}${st.uploaded ? " · uploaded changes" : " · nothing new to upload"}`
                      + (st.newSpace ? (method === "server"
                          ? " · This passphrase had nothing synced yet – if your other browsers already sync, check the passphrase is exactly the same."
                          : " · Started a new synced copy here.") : "")
                    : st.error + " · " + timeAgo(st.at))
           : (method === "folder" ? "Choose a folder and save a passphrase to start." : "Save a passphrase and connect to start."),
        el("div", { className: "row-btns" }, [
          el("button", { className: "btn sm", html: svgIcon("upload", 14) + "Sync now", on: { click: async () => syncToast(await runSync()) } }),
          wrongPass ? el("button", { className: "btn sm danger", textContent: "Overwrite synced copy", on: { click: async () => {
            if (!(await confirmDialog("Overwrite the synced copy?", "The synced copy (made with another passphrase) is replaced by this browser’s workflows, encrypted with the passphrase saved here. Other browsers then need this passphrase.", "Overwrite", true))) return;
            syncToast(await runSync(true));
          } } }) : null
        ])),
      el("div", { className: "set-row muted", textContent: method === "folder"
        ? "Syncs when this page opens, every 2 minutes while it’s open, and shortly after a change."
        : `Syncs every ${syncLabel(settings.syncInterval)} and ${syncLabel(settings.syncDelay)} after a change – even when this page is closed.` })
    ]));
    out.push(section("Good to know", [el("ul", { className: "good-to-know" }, [
      method === "folder" ? "Brave: folder access is off by default – turn on brave://flags/#file-system-access-api and restart Brave." : null,
      method === "folder" ? "The folder only syncs while this Session Manager page is open in that browser." : null,
      method === "server" ? "Your server finds your data by the passphrase itself: a typo starts a separate, empty sync instead of showing an error. The status warns you when a passphrase had nothing synced yet." : null,
      "Your passphrase is never stored – only hashes of it and the encryption key made from it, which can’t be exported." + " Your " + (method === "gist" ? "GitHub token and gist id are" : method === "webdav" ? "WebDAV folder address, username and app password are" : method === "server" ? "server address is" : "folder name is") + " encrypted in this browser with a key that can’t be exported – they’re only decrypted while syncing.",
      "Each workflow keeps whichever version was changed most recently. Deleting a workflow deletes it everywhere.",
      method === "folder" ? null : "A workflow that’s open in this browser follows changes made in another browser: its real tabs are closed, opened or moved to match.",
      "Unsorted tabs are combined: a tab removed in one browser can come back from another.",
      method === "folder" ? null : "The first time you connect, Chrome asks to let Tab Workflows reach that address – it’s needed to send and fetch the encrypted file."
    ].filter(Boolean).map(t => el("li", { textContent: t })))]));
  }
  return out;
}

// ---------- Setting up a connection, one step at a time ----------
// WebDAV:        folder address → Next (asks for access to it) · username & app password → Connect · passphrase → Save
// Shared folder: Choose folder (Chrome asks for access right then) · passphrase → Save
// Each step appears once the one before it is done and stays on the page afterwards, filled in, so it can be changed.
// What you type is kept while the page redraws; the address, username and app password are stored once you press
// Next / Connect, and shown again in their fields.
let focusNext = null;   // { key, until }: the field to put the cursor in once it's on the page
// Waits up to 5 s for the field to appear; once it's on the page, redraws in the next 800 ms keep the cursor in it.
function focusSoon(key) { focusNext = { key, until: Date.now() + 5000, settled: false }; }
// Every redraw in the next moment builds this field again: each new copy takes the cursor, so the one that
// stays on the page has it (what you typed meanwhile is kept, see the drafts).
function wantFocus(key, node) {
  if (!focusNext || focusNext.key !== key || Date.now() > focusNext.until) return;
  const tick = () => {
    if (!focusNext || focusNext.key !== key || Date.now() > focusNext.until) return;
    if (node.isConnected) {
      if (!focusNext.settled) { focusNext.settled = true; focusNext.until = Date.now() + 800; }
      if (document.activeElement !== node) node.focus();
    } else requestAnimationFrame(tick);
  };
  tick();
}
const fieldRow = nodes => el("div", { className: "field-row" }, nodes.filter(Boolean));
const onEnterKey = (input, fn) => input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); fn(); } });
function eyeButton(input) {
  return el("button", { type: "button", className: "iconbtn flat", title: "Show / hide", html: svgIcon("eye", 15),
    on: { click: () => { input.type = input.type === "password" ? "text" : "password"; } } });
}
function plainInput(value, placeholder, onInput, type = "text") {
  const f = el("input", { type, className: "field", value: value || "", placeholder, spellcheck: false,
    autocomplete: type === "password" ? "new-password" : "off" });
  f.addEventListener("input", () => onInput(f.value));
  return f;
}

// ---------- passphrase (last step of every method) ----------
// The passphrase itself is never stored: it's turned into the encryption key (see sync-core.js).
let passDraft = "";
function passphraseRow(syncConfig, hasPass, linked) {
  const pass = plainInput(passDraft, hasPass ? "Type to change" : "Create a passphrase (8 or more characters)",
    v => { passDraft = v; }, "password");
  const save = el("button", { className: "btn sm primary", textContent: "Save" });
  save.addEventListener("click", async () => {
    const v = pass.value;
    if (v.length < 8) { toast("Use at least 8 characters"); pass.focus(); return; }
    const changing = hasPass && syncConfig.syncId !== await syncIdFor(v);
    if (changing && !(await confirmDialog("Change the passphrase?", CHANGE_PASS_TEXT, "Change"))) return;
    save.disabled = true;
    try {
      // Changing it: first take in the newest synced changes with the old passphrase…
      if (changing && linked) await runSync().catch(() => null);
      const { syncConfig: cur = {} } = await chrome.storage.local.get("syncConfig");
      const next = { ...cur, ...(await rememberPassphrase(v)), passMethod: settings.syncMethod };   // belongs to this connection
      delete next.passphrase;
      passDraft = "";
      await chrome.storage.local.set({ syncConfig: next });
      toast("Passphrase saved");
      renderSettings();
      // …then write the synced copy again, encrypted with the new one (else it stays unreadable here too).
      await syncOrOfferOverwrite(changing, v);
    } finally { save.disabled = false; }
  });
  onEnterKey(pass, () => save.click());
  wantFocus("passphrase", pass);
  return row("Passphrase", (hasPass ? "" : "Needed to connect: nothing syncs until you create one. ") +
    "Your workflows are encrypted with it before they leave this browser, so the storage can’t read them. Use the same one in every browser. It isn’t stored – only the encryption key made from it, which can’t be exported.",
    fieldRow([pass, eyeButton(pass), save]));
}

// ---------- WebDAV ----------
// Three steps, all done through the WebDAV client in webdav.js (the same code the background syncs with):
//   1 Folder address → Next: asks the browser for access to it (port included). The address is kept as typed.
//   2 Username & app password → Connect: checks them by saving a small test file there (a missing folder is created).
//   3 Passphrase → Save.
// The address and username stay in their fields (also after the page redraws or you come back); they're stored
// encrypted. The app password is different: once saved it never comes back into the page – the field says it's
// saved, the eye only shows what you're typing right now, and Connect uses the saved one when the field is empty.
let webdavDraft = null;     // { url, user, pass } as typed (pass: only what you typed and haven't connected with yet)
let webdavProblem = "";     // why the last Connect failed – shown under the login until the next try
const webdavLinked = cfg => !!(cfg.webdavUrl && cfg.webdavUser && cfg.webdavPass && (cfg.webdavConnected || cfg.webdavReady));

function webdavSteps(cfg) {
  const d = webdavDraft || (webdavDraft = { url: cfg.webdavUrl || "", user: cfg.webdavUser || "", pass: "" });
  const passSaved = !!cfg.webdavPass;
  const urlDone = !!cfg.webdavUrl;
  const linked = webdavLinked(cfg);
  const rows = [];

  // 1 · Folder address → Next
  const url = plainInput(d.url, "http://192.168.1.10:8086/webdav/  or  https://cloud.example.com/remote.php/dav/files/you/", v => { d.url = v; });
  const next = el("button", { className: "btn sm" + (urlDone ? "" : " primary"), textContent: "Next" });
  next.addEventListener("click", async () => {
    const v = url.value.trim();
    if (!/^https?:\/\/[^/]/i.test(v)) { toast("Enter the full folder address, starting with http:// or https://"); url.focus(); return; }
    // First thing after the click, so the browser still counts it as your click and shows its prompt.
    if (!(await askHostAccess([v]))) { toast("Tab Workflows needs your OK to reach that address"); url.focus(); return; }
    d.url = v;
    const access = askHostAccess.prompted ? "Access allowed" : `Access to ${new URL(v).host} was already allowed`;
    if (v !== cfg.webdavUrl) {
      webdavProblem = "";
      focusSoon("webdav-user");
      await saveSyncFields({ webdavUrl: v, webdavConnected: null, webdavReady: null });   // a new address needs Connect again
      toast(access + " – now enter your username and app password");
    } else toast(access);
    renderSettings();
  });
  onEnterKey(url, () => next.click());
  wantFocus("webdav-url", url);
  rows.push(row("Folder address", "The WebDAV address of a folder on your storage (OxiCloud: http://<server>:8086/webdav/ · Nextcloud: Settings → WebDAV). Next asks your OK to reach it. The file " + SYNC_FILE + " is kept in it.",
    fieldRow([url, next])));

  // 2 · Username & app password → Connect
  if (urlDone) {
    const user = plainInput(d.user, "Username", v => { d.user = v; });
    const pass = plainInput(d.pass, passSaved ? "Saved" : "App password", v => { d.pass = v; showEye(); }, "password");
    // The eye only appears while there's something you typed in the field – it can't show the saved password.
    const eye = eyeButton(pass);
    const showEye = () => { eye.classList.toggle("hidden", !pass.value); if (!pass.value) pass.type = "password"; };
    showEye();
    const connect = el("button", { className: "btn sm" + (linked ? "" : " primary"), textContent: "Connect" });
    connect.addEventListener("click", async () => {
      const u = user.value.trim(), typed = pass.value;
      if (!u) { toast("Enter your username"); user.focus(); return; }
      if (!typed && !passSaved) { toast("Enter your app password"); pass.focus(); return; }
      if (!(await askHostAccess([cfg.webdavUrl]))) { toast("Tab Workflows needs your OK to reach your WebDAV storage"); return; }
      // Field empty: use the saved password – read from storage just for this check, never put in the field.
      const p = typed || await savedWebdavPass();
      connect.disabled = true; connect.textContent = "Connecting…";
      const res = await WebDAV.check({ url: cfg.webdavUrl, user: u, pass: p });
      connect.disabled = false; connect.textContent = "Connect";
      d.user = u;
      if (!res.ok) {
        webdavProblem = res.message;
        // Keep the address and username; a password that didn't work isn't stored (what you typed stays in the field).
        await saveSyncFields({ webdavUser: u, webdavConnected: null });
        toast("Couldn’t connect – see the message under the login");
        renderSettings();
        return;
      }
      webdavProblem = "";
      d.pass = "";                              // connected: the field empties and just says it's saved
      const hasPass = await hasSyncPassphrase();
      if (!hasPass) focusSoon("passphrase");
      await saveSyncFields({ webdavUser: u, webdavPass: p, webdavConnected: true });
      renderSettings();
      const made = res.created ? " (the folder didn’t exist, so it was created)" : "";
      if (hasPass) { if (made) toast("Connected" + made); await syncOrOfferOverwrite(); }
      else toast("Connected – now choose your passphrase" + made);
    });
    onEnterKey(user, () => pass.focus());
    onEnterKey(pass, () => connect.click());
    wantFocus("webdav-user", user);
    rows.push(row("Username & app password", "Use an app password if your storage offers one (OxiCloud only takes an app password). Connect checks them by saving a small test file there.",
      fieldRow([user, pass, eye, connect])));
    if (webdavProblem) rows.push(el("div", { className: "set-row webdav-problem", role: "alert", textContent: webdavProblem }));
  }

  const hint = !urlDone ? "Step 1 of 3 · Enter your WebDAV folder address and press Next."
    : !linked ? "Step 2 of 3 · Enter your username and app password and press Connect."
    : "Step 3 of 3 · Choose your sync passphrase and press Save.";
  return { rows, linked, hint };
}

// The saved app password, decrypted only for the moment it's needed (Connect with an empty field).
async function savedWebdavPass() {
  const { syncConfig = {} } = await chrome.storage.local.get("syncConfig");
  return (await unlockSyncConfig(syncConfig)).webdavPass || "";
}

// ---------- Shared folder ----------
// A folder on this computer can only be reached through Chrome's folder picker – there's no address to type.
// Choosing it is step 1: Chrome asks for access to it right then.
async function folderSteps() {
  const handle = await idbGet("syncFolder").catch(() => null);
  const perm = handle ? await handle.queryPermission({ mode: "readwrite" }).catch(() => "denied") : null;
  const allow = handle && perm !== "granted" ? el("button", { className: "btn sm primary", textContent: "Allow access", on: { click: async () => {
    const p = await handle.requestPermission({ mode: "readwrite" }).catch(() => "denied");
    if (p !== "granted") { await fileEditingBlocked(); return; }
    if (await hasSyncPassphrase()) await syncOrOfferOverwrite();
    renderSettings();
  } } }) : null;
  const choose = el("button", { className: "btn sm" + (handle ? "" : " primary"), html: svgIcon("folder", 14) + (handle ? "Change folder" : "Choose folder"),
    on: { click: chooseSyncFolder } });
  const rows = [
    row("Folder", handle ? `“${handle.name}” · ${perm === "granted" ? "access allowed" : "needs your OK again"}`
      : "The same folder in each browser (for other computers: a Dropbox / OneDrive / Google Drive folder). Chrome asks for access as soon as you choose it.",
      el("div", { className: "row-btns" }, [allow, choose].filter(Boolean))),
    el("div", { className: "set-row muted", textContent: "Brave: folder access is off by default – turn on brave://flags/#file-system-access-api, then restart Brave. Brave and Helium: Settings → Privacy → Site settings → File editing must not be “Don’t allow sites to edit files”." })
  ];
  return { rows, linked: !!handle, hint: !handle ? "Step 1 of 2 · Choose the folder to sync through." : "Step 2 of 2 · Choose your sync passphrase and press Save." };
}

const PASS_SAVED_MS = 5000;   // how long a saved token shows "Saved (encrypted)"
// ---------- GitHub token field ----------
// Saved (encrypted) as soon as you leave the field. It then shows "Saved (encrypted)" for 5 s and
// afterwards dots, so it looks filled in.
// The times are kept outside the fields because saving redraws the Sync page.
const SECRET_DOTS = "••••••••••••";
const secretSavedAt = {};

// `alsoOnChange`: fields to set together with a new value (e.g. a new token isn't checked yet).
function secretField(key, isSaved, emptyPlaceholder, alsoOnChange = {}) {
  const f = el("input", { type: "password", className: "field", value: "", spellcheck: false, autocomplete: "new-password" });
  let pending = "", saving = Promise.resolve(), timer;
  const show = () => {
    const at = secretSavedAt[key] || 0;
    const left = at ? PASS_SAVED_MS - (Date.now() - at) : 0;
    f.placeholder = left > 0 ? "Saved (encrypted)" : (isSaved || at) ? SECRET_DOTS : emptyPlaceholder;
    // Each field has its own timer: a redraw that's thrown away must not cancel the shown field's.
    clearTimeout(timer);
    if (left > 0) timer = setTimeout(show, left + 30);
  };
  f.addEventListener("blur", () => {
    const v = f.value.trim();
    if (!v) return;
    pending = v;
    f.value = "";
    secretSavedAt[key] = Date.now();
    saving = saveSyncFields({ ...alsoOnChange, [key]: v });
    show();
  });
  show();
  return { input: f, get: () => f.value.trim() || pending, saved: () => saving };
}

// GitHub Gist and your own server: one field and Connect (the passphrase follows below it).
async function methodRows(method, cfg) {
  const input = (value, placeholder, type = "text") => el("input", { type, className: "field", value: value || "", placeholder, spellcheck: false, autocomplete: "off" });
  const save = patch => saveSyncFields(patch);   // addresses, logins and ids are stored encrypted

  if (method === "gist") {
    const tok = secretField("gistToken", !!cfg.gistToken, "ghp_… or github_pat_…", { gistVerified: null });
    const token = tok.input;
    return [
      row("GitHub token", "A token that may only create and edit gists. Create one (tick just “gist”), copy it here, and use the same token in each browser.",
        el("div", { className: "field-row" }, [token,
          el("button", { className: "btn sm", textContent: "Create token", on: { click: () => window.open("https://github.com/settings/tokens/new?scopes=gist&description=Tab%20Workflows%20sync", "_blank") } }),
          el("button", { className: "btn sm primary", textContent: "Connect", on: { click: async () => {
            if (!(await askHostAccess(["https://api.github.com/", "https://gist.githubusercontent.com/"]))) { toast("Tab Workflows needs access to GitHub to sync"); return; }
            const t = tok.get() || cfg.gistToken || "";
            await tok.saved();                       // leaving the field (to click here) saves it
            if (!t) { toast("Paste your GitHub token first"); return; }
            const problem = await testGistToken(t);
            if (problem) { toast(problem); return; }
            await save({ gistToken: t, gistVerified: true });
            secretSavedAt.gistToken = 1;             // connected: show the dots right away
            await afterConnect("Connected to GitHub");
          } } })])),
      cfg.gistId ? el("div", { className: "set-row muted", textContent: `Using gist ${cfg.gistId} (private, file ${SYNC_FILE}).` }) : null
    ].filter(Boolean);
  }

  if (method === "server") {
    const url = input(cfg.serverUrl, "https://tab-workflows-sync.yourname.workers.dev");
    const help = el("details", { className: "help-steps" }, [
      el("summary", { textContent: "How to set up your server (free, ~10 minutes)" }),
      el("ol", {}, [
        "Log in at dash.cloudflare.com (free plan).",
        "Storage & Databases → KV → Create a namespace called “tabsync”.",
        "Workers & Pages → Create → Create Worker → Deploy → Edit code: paste the server code (button below) → Deploy.",
        "Worker → Settings → Bindings → Add → KV namespace: variable name TABSYNC, namespace tabsync → Deploy.",
        "Copy the Worker’s address, paste it above, save your passphrase, and press Connect – in every browser."
      ].map(t => el("li", { textContent: t }))),
      el("div", { className: "row-btns" }, [
        el("button", { className: "btn sm", html: svgIcon("copy", 14) + "Copy server code", on: { click: async () => {
          try {
            const code = await (await fetch(chrome.runtime.getURL("sync-server/worker.js"))).text();
            await navigator.clipboard.writeText(code);
            toast("Server code copied");
          } catch (_) { toast("Couldn’t copy – the file is sync-server/worker.js in the extension folder"); }
        } } }),
        el("button", { className: "btn sm", html: svgIcon("external", 14) + "Open Cloudflare", on: { click: () => window.open("https://dash.cloudflare.com/", "_blank") } })
      ])
    ]);
    return [
      row("Server address", "The address of your Cloudflare Worker. Only browsers with the same passphrase see the same data.",
        el("div", { className: "field-row" }, [url,
          el("button", { className: "btn sm primary", textContent: "Connect", on: { click: async () => {
            const v = url.value.trim().replace(/\/+$/, "");
            if (!/^https?:\/\//i.test(v)) { toast("Enter the full address, starting with https://"); return; }
            if (!(await askHostAccess([v]))) { toast("Tab Workflows needs access to your server to sync"); return; }
            await save({ serverUrl: v });
            await afterConnect("Server saved");
          } } })])),
      help
    ];
  }
  return [];
}

async function chromeSyncSection(section, syncStatus) {
  const info = (await send("syncInfo")).result;
  return section("Chrome profile", [
    connectionRow(syncStatus, "Turns on a minute after your next change.", "chrome"),
    row("Status", syncStatus && !syncStatus.ok ? syncStatus.error
      : syncStatus ? `Last synced ${timeAgo(syncStatus.at)} · ${(syncStatus.size / 1024).toFixed(1)} KB of about 90 KB`
      : "Syncing shortly.", el("button", { className: "btn sm", html: svgIcon("upload", 14) + "Sync now", on: { click: async () => {
        const r = await send("syncNow");
        toast(r.ok && r.result && r.result.ok ? "Synced" : (r.result && r.result.error) || "Couldn’t sync");
      } } })),
    row("Synced copy", info
      ? `${info.fromOtherDevice ? "From another computer" : "From this computer"} · ${fmtDate(info.at)} · ${plural(info.count || 0, "workflow")}`
      : "Nothing synced yet.",
      el("div", { className: "row-btns" }, [
        info ? el("button", { className: "btn sm", html: svgIcon("download", 14) + "Merge in", title: "Add workflows from the synced copy (newer versions win)", on: { click: async () => {
          const r = await send("syncPull", { mode: "merge" });
          toast(r.ok ? `Merged ${plural(r.result, "workflow")} from sync` : "Couldn’t merge: " + r.error, undoAction);
        } } }) : null,
        info ? el("button", { className: "btn sm danger", textContent: "Replace", title: "Replace your workflows with the synced copy", on: { click: async () => {
          if (!(await confirmDialog("Replace with the synced copy?", "All workflows here will be replaced by the synced ones. You can undo this.", "Replace", true))) return;
          const r = await send("syncPull", { mode: "replace" });
          toast(r.ok ? "Replaced with the synced workflows" : "Couldn’t replace: " + r.error, undoAction);
        } } }) : null
      ]))
  ]);
}

// ---------- Shared-folder sync (runs in this page: folders need a page) ----------
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("tab-workflows", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => { const q = db.transaction("kv").objectStore("kv").get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((res, rej) => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(value, key); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
}

async function chooseSyncFolder() {
  if (!window.showDirectoryPicker) {
    toast("This browser has folder access turned off (Brave: brave://flags/#file-system-access-api)");
    return;
  }
  let handle;
  try { handle = await window.showDirectoryPicker({ id: "tab-workflows-sync", mode: "readwrite" }); }
  catch (e) {
    if (e && e.name === "AbortError") return;   // cancelled
    // Refused before the picker even opens: the browser blocks sites from editing files
    // (Brave and Helium can have "File editing" set to "Don't allow").
    if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) { await fileEditingBlocked(); return; }
    toast("Couldn’t open the folder picker: " + ((e && e.message) || e));
    return;
  }
  // Access right away: the picker usually asked already (then there's no second prompt).
  let perm = await handle.queryPermission({ mode: "readwrite" }).catch(() => "prompt");
  if (perm !== "granted") perm = await handle.requestPermission({ mode: "readwrite" }).catch(() => "denied");
  if (perm !== "granted") { await fileEditingBlocked(); return; }
  await idbSet("syncFolder", handle);
  await saveSyncFields({ folderName: handle.name });
  if (await hasSyncPassphrase()) await syncOrOfferOverwrite();
  else { focusSoon("passphrase"); toast(`Folder “${handle.name}” chosen – now choose your passphrase`); }
  renderSettings();
}

// The browser's "File editing" site setting is "Don't allow sites to edit files": the folder picker is
// refused without opening. Explain it and open that settings page (chrome:// also works in Brave and Helium).
async function fileEditingBlocked() {
  const origin = location.origin;   // chrome-extension://<id>
  const go = await confirmDialog("Your browser blocks folder access",
    "This browser is set to “Don’t allow sites to edit files”, so it refuses the folder picker. " +
    "In the settings page that opens, either choose “Sites can ask to edit files”, or press Add next to " +
    "“Allowed to edit files” and paste " + origin + " (it’s copied for you). Then come back and press Choose folder again.",
    "Open settings");
  if (!go) return;
  try { await navigator.clipboard.writeText(origin); } catch (_) {}
  chrome.tabs.create({ url: "chrome://settings/content/filesystem" });   // the "File editing" page
}

let folderSyncing = false;
async function folderSyncNow({ ask = false, force = false, passphrase = "" } = {}) {
  if (settings.syncMethod !== "folder" || folderSyncing) return null;
  const status = async st => { const s = { at: Date.now(), method: "folder", ...st }; await chrome.storage.local.set({ multiSyncStatus: s }); return s; };
  const handle = await idbGet("syncFolder").catch(() => null);
  if (!handle) return status({ ok: false, error: "Choose a folder first." });
  const syncConfig = await protectSyncConfig((await chrome.storage.local.get("syncConfig")).syncConfig || {});
  if (!syncConfig.hasPassphrase) return status({ ok: false, error: "Set a passphrase first." });
  folderSyncing = true;
  try {
    let perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted" && ask) perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") return await status({ ok: false, error: "The folder needs your OK again – press Allow access." });
    let text = null;
    if (!force) {
      try { text = await (await (await handle.getFileHandle(SYNC_FILE)).getFile()).text(); }
      catch (e) { if (e.name !== "NotFoundError") throw e; }
    }
    const remote = text ? await openSyncStored(text, syncConfig, passphrase) : null;
    const res = await send("syncMergeRemote", { remote: force ? null : remote });
    if (!res.ok) throw new Error(res.error);
    const payload = res.result;
    let uploaded = false;
    if (force || !remote || !sameSyncContent(remote, payload)) {
      const fh = await handle.getFileHandle(SYNC_FILE, { create: true });
      const w = await fh.createWritable();
      await w.write(await sealSyncStored(payload, syncConfig));
      await w.close();
      uploaded = true;
    }
    return await status({ ok: true, uploaded, workflows: Object.keys(payload.workflows || {}).length,
                          fromOther: !!(remote && remote.device && remote.device !== payload.device), newSpace: !force && !text });
  } catch (e) {
    return await status({ ok: false, error: String((e && e.message) || e) });
  } finally {
    folderSyncing = false;
  }
}

let folderSyncTimer = null;
function scheduleFolderSync(delay = 15000) {
  if (settings.syncMethod !== "folder") return;
  clearTimeout(folderSyncTimer);
  folderSyncTimer = setTimeout(() => folderSyncNow(), delay);
}
setInterval(() => folderSyncNow(), 120000);



// ---------- canvas layout (endless canvas, drag workflows anywhere) ----------
const CANVAS_KEY = "canvas";
let canvas = { x: 0, y: 0, zoom: 1, pos: {} };   // pos: { [workflowId]: { x, y, z } }
let canvasLoaded = false;
let movingCard = false;
let zTop = 1;
let canvasSaveTimer;

async function loadCanvas() {
  try {
    const { canvas: c } = await chrome.storage.local.get(CANVAS_KEY);
    if (c) canvas = { x: 0, y: 0, zoom: 1, ...c, pos: { ...(c.pos || {}) } };
  } catch (_) {}
  zTop = Math.max(1, ...Object.values(canvas.pos).map(p => p.z || 1));
  canvasLoaded = true;
}

function saveCanvas() {
  clearTimeout(canvasSaveTimer);
  canvasSaveTimer = setTimeout(() => chrome.storage.local.set({ [CANVAS_KEY]: canvas }), 250);
}

function applyView() {
  const board = $("board");
  const world = board.querySelector(".canvas-world");
  if (!world) return;
  world.style.transform = `translate(${canvas.x}px, ${canvas.y}px) scale(${canvas.zoom})`;
  // The background pattern moves and zooms with the canvas.
  board.style.setProperty("--px", canvas.x + "px");
  board.style.setProperty("--py", canvas.y + "px");
  board.style.setProperty("--z", canvas.zoom);
  const z = board.querySelector(".zoom-label");
  if (z) z.textContent = Math.round(canvas.zoom * 100) + "%";
}

// Place cards that don't have a spot yet, and make sure no two workflows overlap.
// `cards` comes oldest first (sortedWorkflows), so when two overlap the newer one moves to a free spot.
function layoutCanvas(cards) {
  const COLW = 360, GAP = 20, COLS = 4;
  const apply = c => {
    const p = canvas.pos[c.dataset.id];
    c.style.left = p.x + "px";
    c.style.top = p.y + "px";
    c.style.zIndex = p.z || 1;
    if (p.w) c.style.width = p.w + "px";
    // A height you dragged is the most it grows to: with fewer tabs it shrinks to fit, so no empty gap.
    if (p.h) c.style.maxHeight = p.h + "px";
  };
  const placed = cards.filter(c => canvas.pos[c.dataset.id]);
  const unplaced = cards.filter(c => !canvas.pos[c.dataset.id]);
  placed.forEach(apply);
  // Real sizes (the card is in the page now); hidden cards (search) fall back to their saved or default size.
  const size = c => {
    const p = canvas.pos[c.dataset.id] || {};
    return { w: c.offsetWidth || p.w || 340, h: c.offsetHeight || p.h || 120 };
  };
  const rectOf = c => ({ c, x: canvas.pos[c.dataset.id].x, y: canvas.pos[c.dataset.id].y, ...size(c) });
  const hits = (a, b, gap) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
  // The free spot closest to (tx, ty): right of / below the existing cards, or at the target itself.
  const freeSpot = (w, h, rects, tx, ty) => {
    const xs = new Set([Math.round(tx)]), ys = new Set([Math.round(ty)]);
    for (const r of rects) { xs.add(r.x + r.w + GAP); xs.add(r.x); ys.add(r.y + r.h + GAP); ys.add(r.y); }
    let best = null, bestD = Infinity;
    for (const x of xs) for (const y of ys) {
      const cand = { x, y, w, h };
      if (rects.some(r => hits(cand, r, GAP - 1))) continue;
      const d = Math.hypot(x - tx, (y - ty) * 1.5);
      if (d < bestD) { bestD = d; best = cand; }
    }
    // There is always a spot right of everything.
    return best || { x: Math.max(...rects.map(r => r.x + r.w)) + GAP, y: Math.round(ty), w, h };
  };

  let changed = false;
  if (unplaced.length && !placed.length) {
    // Nothing placed yet (first time, or "Tidy up"): tidy columns.
    const colY = Array(COLS).fill(24);
    for (const c of unplaced) {
      const col = colY.indexOf(Math.min(...colY));
      canvas.pos[c.dataset.id] = { x: 24 + col * COLW, y: colY[col], z: ++zTop };
      apply(c);
      colY[col] += size(c).h + GAP;
    }
    changed = true;
  } else if (unplaced.length) {
    // New workflows go to the free spot nearest the top-left of what you're looking at.
    const rects = placed.map(rectOf);
    const tx = -canvas.x / canvas.zoom + 24, ty = -canvas.y / canvas.zoom + 24;
    for (const c of unplaced) {
      canvas.pos[c.dataset.id] = { x: 0, y: 0, z: ++zTop };
      apply(c);                                   // so its real size can be measured
      const s = size(c);
      const spot = freeSpot(s.w, s.h, rects, tx, ty);
      canvas.pos[c.dataset.id].x = spot.x;
      canvas.pos[c.dataset.id].y = spot.y;
      apply(c);
      rects.push(rectOf(c));
    }
    changed = true;
  }

  // Overlaps left over (a card grew, a workflow arrived through sync…): the newer workflow moves out.
  // Only when the cards can be measured (the canvas is on screen).
  if (cards.some(c => c.offsetWidth > 0)) {
    const done = [];
    for (const c of cards) {
      const r = rectOf(c);
      if (c.offsetWidth > 0 && done.some(o => hits(r, o, 0))) {
        const spot = freeSpot(r.w, r.h, done, r.x, r.y);
        canvas.pos[c.dataset.id].x = spot.x;
        canvas.pos[c.dataset.id].y = spot.y;
        apply(c);
        done.push(rectOf(c));
        changed = true;
      } else done.push(r);
    }
  }
  if (changed) saveCanvas();
}

function zoomAt(clientX, clientY, factor) {
  const r = $("board").getBoundingClientRect();
  const px = clientX - r.left, py = clientY - r.top;
  const nz = Math.min(2, Math.max(0.25, canvas.zoom * factor));
  const wx = (px - canvas.x) / canvas.zoom, wy = (py - canvas.y) / canvas.zoom;
  canvas.zoom = nz;
  canvas.x = px - wx * nz;
  canvas.y = py - wy * nz;
  applyView();
  saveCanvas();
}

// Zoom and pan so every workflow is visible.
function fitCanvas() {
  const board = $("board");
  const cards = [...board.querySelectorAll(".canvas-world .card:not(.hidden)")];
  if (!cards.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of cards) {
    const p = canvas.pos[c.dataset.id];
    if (!p) continue;
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + c.offsetWidth); maxY = Math.max(maxY, p.y + c.offsetHeight);
  }
  const r = board.getBoundingClientRect();
  const pad = 48;
  const z = Math.min(1, Math.max(0.25, Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY))));
  canvas.zoom = z;
  canvas.x = (r.width - (maxX - minX) * z) / 2 - minX * z;
  canvas.y = Math.max(pad, (r.height - (maxY - minY) * z) / 2) - minY * z;
  applyView();
  saveCanvas();
}

function tidyCanvas() {
  canvas.pos = {};
  renderBoard();
  requestAnimationFrame(fitCanvas);
}

function canvasControls() {
  const btn = (icon, title, fn) => el("button", { className: "iconbtn flat", title, "aria-label": title, html: svgIcon(icon, 15), on: { click: fn } });
  const center = () => { const r = $("board").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  return el("div", { className: "canvas-controls" }, [
    btn("minus", "Zoom out", () => zoomAt(...center(), 1 / 1.2)),
    el("button", { className: "zoom-label", title: "Reset zoom to 100%", textContent: Math.round(canvas.zoom * 100) + "%",
      on: { click: () => zoomAt(...center(), 1 / canvas.zoom) } }),
    btn("plus", "Zoom in", () => zoomAt(...center(), 1.2)),
    el("span", { className: "sep" }),
    btn("fit", "Fit all workflows on screen", fitCanvas),
    btn("grid", "Tidy up (arrange in columns)", tidyCanvas)
  ]);
}

// Drag a workflow card around by its header (pointer tracked on the window, so fast drags work).
// Workflows it lands on move out of the way (and slide back if you move on).
function otherCards(card) {
  return [...card.parentElement.querySelectorAll(".card:not(.hidden)")].filter(c => c !== card && canvas.pos[c.dataset.id])
    .map(c => ({ el: c, p: canvas.pos[c.dataset.id], x0: canvas.pos[c.dataset.id].x, y0: canvas.pos[c.dataset.id].y,
                 x: canvas.pos[c.dataset.id].x, y: canvas.pos[c.dataset.id].y, w: c.offsetWidth, h: c.offsetHeight }));
}

function enableCardMove(card, head) {
  head.addEventListener("pointerdown", e => {
    if (settings.display !== "canvas" || e.button !== 0) return;
    if (e.target.closest("button, input, select, a")) return;
    const p = canvas.pos[card.dataset.id];
    if (!p) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = p.x, oy = p.y;
    const w = card.offsetWidth, h = card.offsetHeight;
    const others = otherCards(card);
    let moved = false;
    p.z = ++zTop;
    card.style.zIndex = p.z;
    movingCard = true;
    const move = ev => {
      const dx = (ev.clientX - sx) / canvas.zoom, dy = (ev.clientY - sy) / canvas.zoom;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      if (!moved) { moved = true; card.classList.add("moving"); }
      p.x = Math.round(ox + dx);
      p.y = Math.round(oy + dy);
      card.style.left = p.x + "px";
      card.style.top = p.y + "px";
      pushNeighbours({ x: p.x, y: p.y, w, h }, others, "auto");
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      card.classList.remove("moving");
      movingCard = false;
      saveCanvas();
      if (pendingRender) { pendingRender = false; renderBoard(); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
}

// ---------- resizing cards ----------
// Canvas: every edge and corner resizes that card (left/top edges move it so the opposite edge stays put).
// Board: the left or right edge sets the width of all columns (the board keeps cards packed in columns).
// Double-click any edge to reset.
const RESIZE_DIRS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const BOARD_GAP = 16;

function boardWidth() { return Math.min(900, Math.max(240, settings.boardWidth || 320)); }

// ---------- Ctrl + scroll zoom for Board and List (the canvas has its own) ----------
let boardZoom = 1;
let boardZoomSave;
const clampZoom = z => Math.round(Math.min(1.6, Math.max(0.5, z)) * 100) / 100;

function applyBoardZoom() {
  const board = $("board");
  const on = settings.display !== "canvas";
  board.style.zoom = on && boardZoom !== 1 ? boardZoom : "";
  let pill = $("zoomPill");
  if (!pill) {
    pill = el("div", { id: "zoomPill", className: "zoom-pill" }, [
      el("button", { className: "iconbtn flat", title: "Zoom out", html: svgIcon("minus", 14), on: { click: () => setBoardZoom(boardZoom / 1.1) } }),
      el("button", { className: "zoom-label", title: "Reset to 100%", on: { click: () => setBoardZoom(1) } }),
      el("button", { className: "iconbtn flat", title: "Zoom in", html: svgIcon("plus", 14), on: { click: () => setBoardZoom(boardZoom * 1.1) } })
    ]);
    $("boardView").append(pill);
  }
  pill.querySelector(".zoom-label").textContent = Math.round(boardZoom * 100) + "%";
  pill.classList.toggle("hidden", !on || boardZoom === 1);
}

function setBoardZoom(z) {
  boardZoom = clampZoom(z);
  applyBoardZoom();
  applyBoardWidth();
  clearTimeout(boardZoomSave);
  boardZoomSave = setTimeout(() => { boardZoomSave = null; setSetting("boardZoom", boardZoom); }, 300);
}

window.addEventListener("wheel", e => {
  if (!(e.ctrlKey || e.metaKey) || settings.display === "canvas") return;
  if ($("boardView").classList.contains("hidden") || !$("modal").classList.contains("hidden")) return;
  e.preventDefault();                       // zoom the board instead of the whole browser page
  setBoardZoom(boardZoom * Math.exp(-e.deltaY * 0.0015));
}, { passive: false });

// Move workflows out of the way of a growing card (and out of the way of each other, in a chain),
// always starting from where they were when the resize began.
const PUSH_GAP = 16;
function pushNeighbours(rect, others, dir) {
  for (const o of others) { o.x = o.x0; o.y = o.y0; }
  const overlaps = (a, b) => a.x < b.x + b.w + PUSH_GAP && b.x < a.x + a.w + PUSH_GAP &&
                             a.y < b.y + b.h + PUSH_GAP && b.y < a.y + a.h + PUSH_GAP;
  const queue = [rect];
  let guard = 0;
  while (queue.length && guard++ < 400) {
    const cur = queue.shift();
    for (const o of others) {
      if (o === cur || !overlaps(cur, o)) continue;
      // How far it would have to move on each axis the card is growing along.
      const moves = [];
      const any = dir === "auto";
      if (any || dir.includes("e")) moves.push(["x", cur.x + cur.w + PUSH_GAP]);
      if (any || dir.includes("w")) moves.push(["x", cur.x - PUSH_GAP - o.w]);
      if (any || dir.includes("s")) moves.push(["y", cur.y + cur.h + PUSH_GAP]);
      if (any || dir.includes("n")) moves.push(["y", cur.y - PUSH_GAP - o.h]);
      if (!moves.length) continue;
      moves.sort((a, b) => Math.abs(a[1] - o[a[0]]) - Math.abs(b[1] - o[b[0]]));
      const [axis, to] = moves[0];
      o[axis] = Math.round(to);
      queue.push(o);
    }
  }
  for (const o of others) {
    if (o.p.x === o.x && o.p.y === o.y) continue;
    o.p.x = o.x; o.p.y = o.y;
    o.el.style.left = o.x + "px";
    o.el.style.top = o.y + "px";
  }
}

// Exact column width in Board layout: as many columns of `w` as fit, centred.
function applyBoardWidth(w = boardWidth()) {
  const board = $("board");
  if (settings.display !== "board") return;
  const view = $("boardView");
  if (!view.clientWidth) return;            // board hidden (Settings view) – done again when it's shown
  const cs = getComputedStyle(view);
  // The board is zoomed, so measure the free space in the board's own (unzoomed) pixels.
  const avail = (view.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) / boardZoom;
  const cards = board.querySelectorAll(".card:not(.hidden)").length || 1;
  const n = Math.max(1, Math.min(cards, Math.floor((avail + BOARD_GAP) / (w + BOARD_GAP))));
  board.style.columns = `${n} ${w}px`;
  board.style.width = Math.min(avail, n * w + (n - 1) * BOARD_GAP) + "px";
  board.style.marginLeft = board.style.marginRight = "auto";
}
window.addEventListener("resize", () => applyBoardWidth());

function enableCardResize(card) {
  for (const dir of RESIZE_DIRS) {
    const h = el("div", { className: `rz rz-${dir}`, title: "Drag to resize · double-click to reset" });
    card.append(h);
    h.addEventListener("dblclick", e => {
      e.stopPropagation();
      if (settings.display === "canvas") {
        const p = canvas.pos[card.dataset.id];
        if (!p) return;
        delete p.w; delete p.h;
        card.style.width = ""; card.style.height = ""; card.style.maxHeight = "";
        saveCanvas();
      } else if (settings.display === "board") {
        applyBoardWidth(320);
        setSetting("boardWidth", 320);
      }
    });
    h.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      const mode = settings.display;
      if (mode === "list" || (mode === "board" && dir !== "e" && dir !== "w")) return;
      e.preventDefault();
      e.stopPropagation();
      const sx = e.clientX, sy = e.clientY;
      const ow = card.offsetWidth, oh = card.offsetHeight;
      const p = mode === "canvas" ? canvas.pos[card.dataset.id] : null;
      if (mode === "canvas" && !p) return;
      const ox = p ? p.x : 0, oy = p ? p.y : 0;
      if (p) { p.z = ++zTop; card.style.zIndex = p.z; }
      // Where every other workflow started, so pushed ones can slide back if you shrink again.
      const others = mode === "canvas"
        ? [...card.parentElement.querySelectorAll(".card:not(.hidden)")].filter(c => c !== card && canvas.pos[c.dataset.id])
            .map(c => ({ el: c, p: canvas.pos[c.dataset.id], x0: canvas.pos[c.dataset.id].x, y0: canvas.pos[c.dataset.id].y, w: c.offsetWidth, h: c.offsetHeight }))
        : [];
      movingCard = true;
      card.classList.add("resizing");
      document.body.classList.add("resizing-" + (dir.length === 2 ? dir : (dir === "n" || dir === "s" ? "ns" : "ew")));
      let boardW = boardWidth();

      const move = ev => {
        const zoom = mode === "canvas" ? canvas.zoom : boardZoom;
        const dx = (ev.clientX - sx) / zoom, dy = (ev.clientY - sy) / zoom;
        if (mode === "board") {
          // Left edge: dragging left makes it wider. Right edge: dragging right makes it wider.
          boardW = Math.round(Math.min(900, Math.max(240, ow + (dir === "w" ? -dx : dx))));
          applyBoardWidth(boardW);
          return;
        }
        if (dir.includes("e") || dir.includes("w")) {
          const w = Math.round(Math.min(1200, Math.max(260, ow + (dir.includes("e") ? dx : -dx))));
          p.w = w;
          if (dir.includes("w")) p.x = Math.round(ox + (ow - w));
          card.style.width = w + "px";
          card.style.left = p.x + "px";
        }
        if (dir.includes("n") || dir.includes("s")) {
          const hgt = Math.round(Math.min(2000, Math.max(110, oh + (dir.includes("s") ? dy : -dy))));
          p.h = hgt;
          if (dir.includes("n")) p.y = Math.round(oy + (oh - hgt));
          card.style.height = hgt + "px";
          card.style.maxHeight = hgt + "px";
          card.style.top = p.y + "px";
        }
        pushNeighbours({ x: p.x, y: p.y, w: card.offsetWidth, h: card.offsetHeight }, others, dir);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        card.classList.remove("resizing");
        document.body.className = document.body.className.replace(/\bresizing-\w+\b/g, "").trim();
        movingCard = false;
        if (mode === "canvas") {
          // Let go: the card fits its tabs again, up to the height you dragged (keep the bottom edge put when
          // dragging the top edge further than the tabs need).
          if (card.style.height) {
            card.style.height = "";
            const real = card.offsetHeight;
            if (dir.includes("n") && p.h && real < p.h) { p.y += p.h - real; card.style.top = p.y + "px"; }
          }
          saveCanvas();
        } else setSetting("boardWidth", boardW);
        if (pendingRender) { pendingRender = false; renderBoard(); }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
  }
}

// Pan by dragging the empty canvas (or with the wheel / trackpad); Ctrl + wheel zooms.
function enableCanvasPan() {
  const board = $("board");
  board.addEventListener("pointerdown", e => {
    if (settings.display !== "canvas" || (e.button !== 0 && e.button !== 1)) return;
    if (e.target !== board && !e.target.classList.contains("canvas-world")) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = canvas.x, oy = canvas.y;
    board.classList.add("panning");
    try { board.setPointerCapture(e.pointerId); } catch (_) {}
    const move = ev => { canvas.x = ox + ev.clientX - sx; canvas.y = oy + ev.clientY - sy; applyView(); };
    const up = () => {
      board.removeEventListener("pointermove", move);
      board.removeEventListener("pointerup", up);
      board.removeEventListener("pointercancel", up);
      board.classList.remove("panning");
      saveCanvas();
    };
    board.addEventListener("pointermove", move);
    board.addEventListener("pointerup", up);
    board.addEventListener("pointercancel", up);
  });
  board.addEventListener("wheel", e => {
    if (settings.display !== "canvas") return;
    // Over a workflow the wheel belongs to that workflow: it scrolls its tabs (if they overflow)
    // and never moves the canvas – not even at the top or bottom. Scroll outside workflows to move around.
    // Over a workflow whose tabs can scroll, the wheel scrolls its tabs (and never moves the canvas).
    // Over a workflow with nothing to scroll, the wheel moves the canvas as if the workflow wasn't there.
    if (!e.ctrlKey && !e.metaKey && e.target.closest && e.target.closest(".canvas-world .card")) {
      const body = e.target.closest(".card").querySelector(".card-body");
      if (body && body.scrollHeight > body.clientHeight + 1) {
        if (e.target.closest(".card-body")) return;          // the browser scrolls the list
        e.preventDefault();                                  // header / footer: scroll the list too
        body.scrollTop += e.deltaY;
        return;
      }
    }
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    else { canvas.x -= e.deltaX; canvas.y -= e.deltaY; applyView(); saveCanvas(); }
  }, { passive: false });
}

// Hold the mouse wheel (middle button) and drag to move around – anywhere, also on top of a workflow.
// Canvas: moves the canvas. Board / List: scrolls the page.
document.addEventListener("pointerdown", e => {
  if (e.button !== 1 || $("boardView").classList.contains("hidden") || !$("modal").classList.contains("hidden")) return;
  if (!e.target.closest || !e.target.closest("#boardView")) return;
  e.preventDefault();                               // no browser autoscroll circle
  e.stopPropagation();
  const board = $("board");
  const canvasMode = settings.display === "canvas";
  const sx = e.clientX, sy = e.clientY, ox = canvas.x, oy = canvas.y, scrollX0 = window.scrollX, scrollY0 = window.scrollY;
  board.classList.add("panning");
  document.body.classList.add("mid-panning");
  const move = ev => {
    if (canvasMode) { canvas.x = ox + ev.clientX - sx; canvas.y = oy + ev.clientY - sy; applyView(); }
    else window.scrollTo(scrollX0 - (ev.clientX - sx), scrollY0 - (ev.clientY - sy));
  };
  const up = ev => {
    if (ev.type === "pointerup" && ev.button !== 1) return;
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
    board.classList.remove("panning");
    document.body.classList.remove("mid-panning");
    if (canvasMode) saveCanvas();
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
}, true);
document.addEventListener("mousedown", e => { if (e.button === 1 && e.target.closest && e.target.closest("#boardView")) e.preventDefault(); }, true);
document.addEventListener("auxclick", e => { if (e.button === 1 && e.target.closest && e.target.closest("#boardView")) e.preventDefault(); }, true);

// Keep the canvas below the (wrapping) top bar.
new ResizeObserver(() => {
  document.documentElement.style.setProperty("--bar-h", document.querySelector(".bar").offsetHeight + "px");
}).observe(document.querySelector(".bar"));

// ---------- undo ----------
const undoAction = { label: "Undo", run: () => doUndo() };

async function doUndo() {
  const r = await send("undo");
  toast(r.ok && r.result ? `Undid: ${r.result}` : "Nothing to undo");
}

async function updateUndoBtn() {
  const { history = [] } = await chrome.storage.local.get("history");
  const b = $("undoBtn");
  b.disabled = !history.length;
  b.title = history.length ? `Undo: ${history[0].label} (Ctrl+Z)` : "Nothing to undo";
}

// ---------- History & Trash view ----------
async function renderHistory() {
  const { history = [], trash = [], groupCopies = [] } = await chrome.storage.local.get(["history", "trash", "groupCopies"]);
  const root = $("history");
  const section = (title, extra, rows) => el("section", { className: "set-section" }, [
    el("div", { className: "sec-head" }, [el("h2", { textContent: title }), extra || null]), ...rows]);
  const btns = (...b) => el("div", { className: "row-btns" }, b);

  const changes = history.length ? history.map((h, i) => row(h.label, timeAgo(h.at) + (i === 0 ? " · latest" : ""),
    el("button", { className: "btn sm" + (i === 0 ? " primary" : ""), html: svgIcon("undo", 14) + (i === 0 ? "Undo" : "Undo to here"),
      title: i === 0 ? "Undo this change" : `Undo this change and the ${plural(i, "newer one")}`,
      on: { click: async () => {
        if (i > 0 && !(await confirmDialog(`Undo ${i + 1} changes?`, `“${h.label}” and the ${plural(i, "change")} after it will be undone.`, "Undo"))) return;
        const r = await send("undoTo", { index: i });
        toast(r.ok && r.result ? `Undid: ${r.result}` : "Couldn’t undo");
      } } })))
    : [el("div", { className: "set-row muted", textContent: "Nothing to undo yet. Changes you make here or in the popup (moves, removes, deletes, edits) show up here." })];

  const trashRows = trash.length ? trash.map(t => {
    const isWf = t.kind === "workflow";
    const n = isWf ? countTabs(t.workflow) : t.tabs.length;
    const label = isWf ? t.workflow.name : `${plural(n, "tab")} from “${t.fromName || "a workflow"}”`;
    const desc = (isWf ? `Deleted workflow · ${plural(n, "tab")}` : t.tabs.slice(0, 3).map(x => x.name || x.title || x.url).join(" · ") + (n > 3 ? " …" : ""))
      + " · " + timeAgo(t.at);
    const r = row(label, desc, btns(
      el("button", { className: "btn sm", html: svgIcon("undo", 14) + "Restore", on: { click: async () => {
        const res = await send("restoreFromTrash", { id: t.id });
        toast(res.ok && res.result ? `Restored to “${res.result}”` : "Couldn’t restore", undoAction);
      } } }),
      el("button", { className: "iconbtn flat danger", title: "Delete forever", html: svgIcon("trash", 15), on: { click: async () => {
        if (await confirmDialog("Delete forever?", `“${label}” will be gone for good.`, "Delete", true)) send("deleteFromTrash", { id: t.id });
      } } })));
    r.prepend(el("div", { className: "tile sm", html: svgIcon(isWf ? resolveIcon(t.workflow.icon) : "list", 16) }));
    return r;
  }) : [el("div", { className: "set-row muted", textContent: "Trash is empty. Deleted workflows and removed tabs stay here for 30 days." })];

  root.replaceChildren(
    section("Recent changes", history.length ? el("button", { className: "btn sm ghost danger", textContent: "Clear", title: "Forget all recent changes (they can’t be undone afterwards)", on: { click: async () => {
      if (await confirmDialog("Clear recent changes?", `The list of ${plural(history.length, "change")} is cleared. Your workflows stay exactly as they are – you just can’t undo those changes any more.`, "Clear", true)) {
        await send("clearHistory");
        toast("Recent changes cleared");
      }
    } } }) : null, changes),
    section("Deleted tab groups", groupCopies.length ? el("button", { className: "btn sm ghost danger", textContent: "Clear", title: "Delete every saved group copy", on: { click: async () => {
      if (await confirmDialog("Clear deleted tab groups?", `${groupCopies.length} saved ${groupCopies.length === 1 ? "copy" : "copies"} will be deleted for good. Your workflows keep their groups.`, "Clear", true)) send("deleteGroupCopy", {});
    } } }) : null, groupCopies.length ? groupCopies.map(c => {
      const label = c.title || "Unnamed group";
      const r = row(label, `${plural(c.tabs.length, "tab")}${c.workflowName ? ` · from “${c.workflowName}”` : ""} · ${timeAgo(c.at)} · `
        + c.tabs.slice(0, 3).map(t => t.title || t.url).join(" · ") + (c.tabs.length > 3 ? " …" : ""),
        el("div", { className: "row-btns" }, [
          el("button", { className: "btn sm", html: svgIcon("external", 14) + "Open", title: "Open it as a tab group in your current window",
            on: { click: async () => { const res = await send("openGroupCopy", { id: c.id }); toast(res.ok ? `Opened “${label}”` : "Couldn’t open it"); } } }),
          el("button", { className: "iconbtn flat", title: "Copy all links", html: svgIcon("copy", 15),
            on: { click: async () => { try { await navigator.clipboard.writeText(c.tabs.map(t => t.url).join("\n")); toast(`Copied ${plural(c.tabs.length, "link")}`); } catch (_) { toast("Couldn’t access the clipboard"); } } } }),
          el("button", { className: "iconbtn flat danger", title: "Delete this copy", html: svgIcon("trash", 15),
            on: { click: () => send("deleteGroupCopy", { id: c.id }) } })
        ]));
      r.prepend(el("span", { className: "tile sm group-tile", "data-gcolor": c.color, html: svgIcon("layers", 15) }));
      return r;
    }) : [el("div", { className: "set-row muted", textContent: "When you switch away from a workflow, its Chrome tab groups are removed from the browser and a copy of each is kept here (the newest copy of each group)." })]),
    section("Trash", trash.length ? el("button", { className: "btn sm ghost danger", textContent: "Empty trash", on: { click: async () => {
      if (await confirmDialog("Empty the trash?", `${plural(trash.length, "item")} will be deleted for good.`, "Empty trash", true)) send("emptyTrash");
    } } }) : null, trashRows)
  );
}

// ---------- notes, colours and tags ----------
const WF_COLORS = ["", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "grey"];
let tagFilter = "";
const allTags = () => [...new Set(sortedWorkflows().flatMap(w => w.tags || []))].sort();

function refreshTagFilter() {
  const sel = $("tagFilter");
  const tags = allTags();
  if (tagFilter && !tags.includes(tagFilter)) tagFilter = "";
  sel.replaceChildren(el("option", { value: "", textContent: "All tags" }),
    ...tags.map(t => el("option", { value: t, textContent: "#" + t, selected: t === tagFilter })));
  sel.classList.toggle("hidden", !tags.length);
  sel.classList.toggle("on", !!tagFilter);
}

function setTagFilter(t) {
  tagFilter = tagFilter === t ? "" : t;
  refreshTagFilter();
  renderBoard();
  if (tagFilter) toast(`Showing workflows tagged #${tagFilter}`);
}

function detailsDialog(wf) {
  return new Promise(resolve => {
    const m = $("modal");
    const note = el("textarea", { className: "field-area", value: wf.note || "", rows: 4, maxLength: 2000,
      placeholder: "What is this workflow for? Reminders, to-dos, links…" });
    let color = wf.color || "";
    const sw = el("div", { className: "color-swatches" });
    const paintSw = () => sw.replaceChildren(...WF_COLORS.map(c => el("button", {
      type: "button", className: "cswatch" + (c === color ? " on" : "") + (c ? "" : " none"), "data-color": c || null,
      title: c ? c[0].toUpperCase() + c.slice(1) : "No colour", "aria-label": c || "No colour",
      on: { click: () => { color = c; paintSw(); } } })));
    paintSw();
    let tags = [...(wf.tags || [])];
    const tagIn = el("input", { type: "text", maxLength: 24, placeholder: "Type a tag and press Enter" });
    const tagWrap = el("div", { className: "tag-editor", on: { click: () => tagIn.focus() } });
    const sugg = el("div", { className: "tag-suggest" });
    const paintTags = () => {
      tagWrap.replaceChildren(...tags.map(t => el("span", { className: "tag-chip" }, [
        "#" + t,
        el("button", { type: "button", title: "Remove tag", html: svgIcon("close", 10), on: { click: e => { e.stopPropagation(); tags = tags.filter(x => x !== t); paintTags(); } } })
      ])), tagIn);
      const s = allTags().filter(t => !tags.includes(t));
      sugg.replaceChildren(...(s.length ? [el("span", { className: "muted", textContent: "Used before:" })] : []),
        ...s.map(t => el("button", { type: "button", className: "tag-chip ghost", textContent: "#" + t, on: { click: () => { tags.push(t); paintTags(); tagIn.focus(); } } })));
    };
    const addFromInput = () => {
      const v = tagIn.value.trim().toLowerCase().replace(/^#/, "").replace(/[\s,]+/g, "-");
      if (v && !tags.includes(v)) tags.push(v);
      tagIn.value = "";
      paintTags();
      tagIn.focus();
    };
    tagIn.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addFromInput(); }
      else if (e.key === "Backspace" && !tagIn.value && tags.length) { tags.pop(); paintTags(); tagIn.focus(); }
    });
    paintTags();
    const done = v => { closeModal(); resolve(v); };
    const save = async () => {
      if (tagIn.value.trim()) addFromInput();
      await send("editWorkflow", { id: wf.id, note: note.value, color, tags });
      done(true);
    };
    const label = (txt, ctl) => el("label", { className: "field-col" }, [el("span", { textContent: txt }), ctl]);
    m.innerHTML = "";
    m.append(el("div", { className: "dialog", role: "dialog", "aria-modal": "true" }, [
      el("h2", { textContent: `Note, colour & tags` }),
      el("p", { textContent: wf.name }),
      label("Note", note),
      el("div", { className: "field-col" }, [el("span", { textContent: "Colour" }), sw]),
      el("div", { className: "field-col" }, [el("span", { textContent: "Tags" }), tagWrap, sugg]),
      el("div", { className: "buttons" }, [
        el("button", { className: "btn ghost", textContent: "Cancel", on: { click: () => done(false) } }),
        el("button", { className: "btn primary", textContent: "Save", on: { click: save } })
      ])
    ]));
    m.classList.remove("hidden");
    m.onmousedown = e => { if (e.target === m) done(false); };
    m._cancel = () => done(false);
    setTimeout(() => note.focus(), 0);
  });
}

// Tags + note shown on a card.
function cardExtras(wf) {
  const out = [];
  if (wf.tags && wf.tags.length) {
    out.push(el("div", { className: "card-tags" }, wf.tags.map(t => el("button", {
      className: "tag-chip" + (t === tagFilter ? " on" : ""), textContent: "#" + t, title: t === tagFilter ? "Show all workflows" : `Show only #${t}`,
      on: { click: () => setTagFilter(t) } }))));
  }
  if (wf.note) {
    out.push(el("div", { className: "card-note", title: "Click to edit", textContent: wf.note, on: { click: () => detailsDialog(wf) } }));
  }
  return out;
}

// ---------- dividers ----------
// Divider tab: a tiny page of this extension in the tab strip (divider.html#t=Text&c=colour).
// Label: only shown here, above a tab (stored as `section` on that tab).
const DIVIDER_RE = /^chrome-extension:\/\/[a-z]{32}\/divider\.html/i;
const DIVIDER_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const isDividerTab = t => DIVIDER_RE.test((t && t.url) || "");
function dividerOf(url) {
  const p = new URLSearchParams(String(url || "").split("#")[1] || "");
  const c = p.get("c");
  return { text: p.get("t") || "", color: DIVIDER_COLORS.includes(c) ? c : "grey" };
}

function labelRow(wf, wi, ti, sec) {
  return el("li", { className: "label-row", "data-gcolor": sec.color || "grey", title: "Label – only shown here, not a tab" }, [
    el("span", { className: "lbl-text", textContent: sec.text || "Section" }),
    el("span", { className: "div-line" }),
    el("div", { className: "row-actions" }, [
      el("button", { title: "Change text and colour", html: svgIcon("edit", 13), on: { click: async () => {
        const r = await dividerDialog({ title: "Edit label", text: sec.text, color: sec.color, kind: "label" });
        if (r) send("editDivider", { id: wf.id, win: wi, idx: ti, text: r.text, color: r.color, kind: "label" });
      } } }),
      el("button", { className: "rm", title: "Remove label", html: svgIcon("close", 13), on: { click: async () => {
        await send("removeLabel", { id: wf.id, win: wi, idx: ti });
        toast("Removed a label", undoAction);
      } } })
    ])
  ]);
}

// `idx` undefined = at the end. `chooseKind`: offer "label" too (needs a tab below it).
async function addDividerFlow(wf, wi, idx, chooseKind = true) {
  const r = await dividerDialog({ title: "Add divider", text: "", color: "grey", kind: "tab", chooseKind: chooseKind && idx !== undefined });
  if (!r) return;
  const res = await send("addDivider", { id: wf.id, win: wi, idx, text: r.text, color: r.color, kind: r.kind });
  if (!res.ok) return toast("Couldn’t add the divider: " + res.error);
  toast(r.kind === "label" ? "Label added" : isLive(wf) ? "Divider tab added – it’s asleep" : "Divider tab added", undoAction);
}

function dividerDialog({ title, text = "", color = "grey", kind = "tab", chooseKind = false }) {
  return new Promise(resolve => {
    const m = $("modal");
    const textIn = el("input", { type: "text", value: text, placeholder: "Text (optional), e.g. Work", maxLength: 80 });
    let pick = DIVIDER_COLORS.includes(color) ? color : "grey";
    const sw = el("div", { className: "color-swatches" });
    const paintSw = () => sw.replaceChildren(...DIVIDER_COLORS.map(c => el("button", {
      type: "button", className: "dswatch" + (c === pick ? " on" : ""), "data-gcolor": c,
      title: c[0].toUpperCase() + c.slice(1), "aria-label": c, on: { click: () => { pick = c; paintSw(); paintPreview(); } } })));
    const preview = el("div", { className: "divider-preview" });
    const paintPreview = () => {
      preview.dataset.gcolor = pick;
      preview.replaceChildren(el("span", { className: "div-line" }), el("span", { className: "div-text", textContent: textIn.value.trim() || "Divider" }), el("span", { className: "div-line" }));
    };
    let k = kind;
    const kinds = [
      ["tab", "Divider tab", "Shows in the browser’s tab strip. Sleeps when you’re not on it, so it costs almost no memory."],
      ["label", "Label", "Only shown here, above this tab. Not a tab at all – zero memory."]
    ];
    const kindBox = el("div", { className: "kind-pick" });
    const paintKinds = () => kindBox.replaceChildren(...kinds.map(([v, l, d]) => el("button", {
      type: "button", className: "kind" + (v === k ? " on" : ""), on: { click: () => { k = v; paintKinds(); } } }, [
      el("span", { className: "kind-name", textContent: l }), el("span", { className: "kind-desc", textContent: d })])));
    paintSw(); paintPreview(); paintKinds();
    textIn.addEventListener("input", paintPreview);
    const done = v => { closeModal(); resolve(v); };
    const ok = () => done({ text: textIn.value.trim(), color: pick, kind: k });
    textIn.addEventListener("keydown", e => { if (e.key === "Enter") ok(); });
    const label = (txt, ctl) => el("label", { className: "field-col" }, [el("span", { textContent: txt }), ctl]);
    m.innerHTML = "";
    m.append(el("div", { className: "dialog", role: "dialog", "aria-modal": "true" }, [
      el("h2", { textContent: title }),
      preview,
      chooseKind ? el("div", { className: "field-col" }, [el("span", { textContent: "Type" }), kindBox]) : null,
      label("Text", textIn),
      el("div", { className: "field-col" }, [el("span", { textContent: "Colour" }), sw]),
      el("div", { className: "buttons" }, [
        el("button", { className: "btn ghost", textContent: "Cancel", on: { click: () => done(null) } }),
        el("button", { className: "btn primary", textContent: "Save", on: { click: ok } })
      ])
    ]));
    m.classList.remove("hidden");
    m.onmousedown = e => { if (e.target === m) done(null); };
    m._cancel = () => done(null);
    setTimeout(() => textIn.focus(), 0);
  });
}

// ---------- backup copies of one workflow ----------
async function copiesDialog(wf) {
  const { wfCopies = {} } = await chrome.storage.local.get("wfCopies");
  const list = wfCopies[wf.id] || [];
  const m = $("modal");
  const done = () => closeModal();
  const items = list.length ? list.map((c, i) => {
    const tabs = (c.windows || []).flatMap(w => w.tabs || []);
    const sample = tabs.filter(t => !isDividerTab(t)).slice(0, 3).map(t => t.name || t.title || hostOf(t.url)).join(", ");
    return el("div", { className: "backup-item" }, [
      el("span", { className: "tile sm", html: svgIcon(resolveIcon(c.icon || wf.icon), 15) }),
      el("div", { className: "set-text" }, [
        el("div", { className: "set-label", textContent: fmtDate(c.at) + (c.name && c.name !== wf.name ? ` · “${c.name}”` : "") }),
        el("div", { className: "set-desc", textContent: plural(tabs.length, "tab") + (sample ? " · " + sample + (tabs.length > 3 ? "…" : "") : "") })
      ]),
      el("button", { className: "btn sm", html: svgIcon("undo", 14) + "Restore", on: { click: async () => {
        done();
        if (!(await confirmDialog(`Restore this copy of “${wf.name}”?`,
          `Its tabs go back to how they were on ${fmtDate(c.at)}.` + (isLive(wf) ? " It’s open right now, so your real tabs change too." : "") + " The tabs it has now are kept as a backup copy, and you can undo this.", "Restore"))) return;
        const r = await send("restoreWorkflowCopy", { id: wf.id, index: i });
        toast(r.ok ? `Restored ${plural(r.result, "tab")}` : "Couldn’t restore: " + r.error, r.ok ? undoAction : null);
      } } })
    ]);
  }) : [el("div", { className: "set-desc", textContent: "No copies yet. A copy is kept the next time this workflow’s tabs change." })];
  m.innerHTML = "";
  m.append(el("div", { className: "dialog", role: "dialog", "aria-modal": "true" }, [
    el("h2", { textContent: "Backup copies" }),
    el("p", { textContent: `The last 3 earlier versions of “${wf.name}”, kept in this browser. A new copy is taken when its tabs change (at most every 30 minutes – right away when many tabs disappear at once).` }),
    el("div", { className: "backup-list" }, items),
    el("div", { className: "buttons" }, [el("button", { className: "btn primary", textContent: "Close", on: { click: done } })])
  ]));
  m.classList.remove("hidden");
  m.onmousedown = e => { if (e.target === m) done(); };
  m._cancel = done;
}

// ---------- Chrome tab group header inside a card ----------
function groupHeader(g, count) {
  return el("li", { className: "group-row", "data-gcolor": g.color || "grey" }, [
    el("span", { className: "g-dot" }),
    el("span", { className: "g-title", textContent: g.title || "Unnamed group" }),
    el("span", { className: "g-count", textContent: count }),
    g.collapsed ? el("span", { className: "g-flag", textContent: "collapsed" }) : null
  ]);
}

// ---------- backups & sync (settings) ----------
function fmtDate(ts) {
  const d = new Date(ts);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return (same ? "Today" : d.toLocaleDateString()) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function backupSection(section) {
  const { backups = [] } = await chrome.storage.local.get("backups");

  const modeSel = el("select", { on: { change: async e => {
    let v = e.target.value;
    if (v === "file") {
      let ok = false;
      try { ok = await chrome.permissions.request({ permissions: ["downloads"] }); } catch (_) {}
      if (!ok) { toast("Saving files needs the Downloads permission"); v = "local"; e.target.value = "local"; }
    }
    setSetting("backupMode", v);
  } } }, [["off", "Off"], ["local", "Keep in Tab Workflows"], ["file", "Also save a file to Downloads"]]
    .map(([v, l]) => el("option", { value: v, textContent: l, selected: settings.backupMode === v })));

  const list = el("div", { className: "backup-list" }, backups.length ? backups.map(b => el("div", { className: "backup-item" }, [
    el("span", { className: "tile sm", html: svgIcon(b.auto ? "calendar" : "save", 15) }),
    el("div", { className: "set-text" }, [
      el("div", { className: "set-label", textContent: fmtDate(b.at) }),
      el("div", { className: "set-desc", textContent: `${plural(b.count || 0, "workflow")} · ${(b.size / 1024).toFixed(1)} KB · ${b.auto ? "automatic" : "manual"}` })
    ]),
    el("div", { className: "row-btns" }, [
      el("button", { className: "btn sm", html: svgIcon("undo", 14) + "Restore", on: { click: async () => {
        if (!(await confirmDialog("Restore this backup?", `Your workflows will be replaced by the ones from ${fmtDate(b.at)}. You can undo this.`, "Restore"))) return;
        const r = await send("restoreBackup", { id: b.id });
        toast(r.ok ? `Restored ${plural(r.result, "workflow")}` : "Couldn’t restore", undoAction);
      } } }),
      el("button", { className: "iconbtn flat", title: "Download this backup", html: svgIcon("download", 15),
        on: { click: () => download(`tab-workflows-backup-${new Date(b.at).toISOString().slice(0, 10)}.json`, b.data) } }),
      el("button", { className: "iconbtn flat danger", title: "Delete this backup", html: svgIcon("trash", 15),
        on: { click: () => send("deleteBackup", { id: b.id }) } })
    ])
  ])) : [el("div", { className: "set-desc", textContent: "No backups yet." })]);

  const rows = [
    row("Daily backup", "Once a day Tab Workflows keeps a copy of all workflows (the last 10 are kept). You can also have it save a file to your Downloads folder.", modeSel),
    row("Saved backups", null, el("button", { className: "btn sm", html: svgIcon("save", 14) + "Back up now", on: { click: async () => {
      await send("makeBackup");
      toast("Backup saved");
    } } })),
    list
  ];
  return section("Daily backups", rows);
}

// ---------- command palette ----------
function managerPalette() {
  const layout = (v, label) => ({ icon: v === "canvas" ? "canvas" : v, title: `Layout: ${label}`, keywords: "view display " + v, run: () => setSetting("display", v) });
  openPalette({
    openWorkflow: wf => openWorkflow(wf),
    actions: [
      { icon: "plus", title: "New workflow", keywords: "create add", run: () => newWorkflow() },
      { icon: "plus", title: "New tab…", keywords: "add link url", run: () => newTabDialog(LOOSE) },
      { icon: "undo", title: "Undo last change", keywords: "revert back ctrl z", run: () => doUndo() },
      { icon: "search", title: "Search the board", keywords: "find filter", run: () => { setView("board"); $("search").focus(); } },
      layout("board", "Board"), layout("list", "List"), layout("canvas", "Canvas"),
      { icon: "history", title: "History & trash", keywords: "deleted restore undo", run: () => setView("history") },
      { icon: "sliders", title: "Settings", keywords: "preferences options", run: () => setView("settings") },
      { icon: "cloud", title: "Sync settings", keywords: "sync brave helium browsers gist webdav folder server", run: () => openSettingsPage("sync") },
      { icon: "upload", title: "Sync now", keywords: "sync upload download", run: async () => syncToast(await runSync()) },
      { icon: "moon", title: "Switch theme", keywords: "dark light system", run: () => {
        const order = ["system", "light", "dark"];
        setSetting("theme", order[(order.indexOf(settings.theme) + 1) % 3]);
      } },
      { icon: "save", title: "Back up now", keywords: "backup save copy", run: async () => { await send("makeBackup"); toast("Backup saved"); } },
      { icon: "download", title: "Export all workflows", keywords: "download json", run: () => exportAll() }
    ]
  });
}

// ---------- views ----------
function setView(v) {
  if (!["board", "history", "settings"].includes(v)) v = "board";
  document.body.classList.toggle("view-settings", v !== "board");
  $("boardView").classList.toggle("hidden", v !== "board");
  $("settingsView").classList.toggle("hidden", v !== "settings");
  $("historyView").classList.toggle("hidden", v !== "history");
  if (v === "history") renderHistory();
  document.querySelectorAll(".views button").forEach(b => b.classList.toggle("on", b.dataset.view === v));
  moveSlider(document.querySelector(".views"));
  moveSlider($("displaySeg"));            // hidden outside Workflows: placed again when it shows
  if (location.hash !== "#" + v) { try { history.replaceState(null, "", "#" + v); } catch (_) {} }
  if (v === "settings") renderSettings();
  else if (typeof applyBoardWidth === "function") applyBoardWidth();
}

// A highlight that slides from the selected button to the one you click (Workflows / History / Settings,
// and Board / List / Canvas). It lives in the container, so it survives the buttons being rebuilt.
// `memo`: a name for a container that is rebuilt from scratch (the Settings menu) – the new highlight
// then starts where the old one was and slides from there.
const sliderAt = {};
function moveSlider(box, memo) {
  if (!box) return;
  let s = box.querySelector(":scope > .seg-slider");
  const first = !s;
  if (first) { s = el("span", { className: "seg-slider", "aria-hidden": "true" }); box.prepend(s); box.classList.add("has-slider"); }
  const on = box.querySelector(":scope > button.on");
  if (!on || !on.offsetWidth) { s.style.opacity = "0"; return; }   // not on screen yet: placed when it is
  const place = p => { s.style.width = p.w + "px"; s.style.height = p.h + "px"; s.style.transform = `translate(${p.x}px, ${p.y}px)`; };
  const to = { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight };
  if (first || s.style.opacity === "0") {
    s.style.transition = "none";
    s.style.opacity = "1";
    const from = first && memo && sliderAt[memo];
    if (from) { place(from); void s.offsetWidth; s.style.transition = ""; place(to); }
    else { place(to); void s.offsetWidth; s.style.transition = ""; }
  } else place(to);
  if (memo) sliderAt[memo] = to;
}
const moveAllSliders = () => document.querySelectorAll(".has-slider").forEach(moveSlider);
window.addEventListener("resize", moveAllSliders);
document.fonts?.ready.then(moveAllSliders).catch(() => {});

function renderDisplaySeg() {
  const seg = $("displaySeg");
  seg.querySelectorAll(":scope > button").forEach(b => b.remove());
  for (const [v, icon, label] of [["board", "board", "Board"], ["list", "list", "List"], ["canvas", "canvas", "Canvas"]]) {
    seg.append(el("button", { type: "button", title: label, className: settings.display === v ? "on" : "", html: svgIcon(icon, 14),
      on: { click: () => setSetting("display", v) } }));
  }
  moveSlider(seg);
  document.body.classList.toggle("display-list", settings.display === "list");
  document.body.classList.toggle("display-canvas", settings.display === "canvas");
}

// ---------- data ----------
async function load() {
  const data = await chrome.storage.local.get(["workflows", "activeWorkflowId", "looseTabs", "openWindows", "pinnedTabs"]);
  state = { workflows: data.workflows || {}, activeWorkflowId: data.activeWorkflowId || null,
            looseTabs: data.looseTabs || [], openWindows: data.openWindows || {},
            pinnedTabs: (data.pinnedTabs && data.pinnedTabs.tabs) || [] };
  refreshTagFilter();
  renderBoard();
}

let settingsPointerDown = false, settingsRenderPending = false;
document.addEventListener("pointerdown", e => { settingsPointerDown = $("settings").contains(e.target); }, true);
const settingsPointerUp = () => {
  if (!settingsPointerDown) return;
  // setTimeout: runs after the click that follows this pointerup.
  setTimeout(() => {
    settingsPointerDown = false;
    if (settingsRenderPending) { settingsRenderPending = false; if (!$("settingsView").classList.contains("hidden")) renderSettings(); }
  }, 0);
};
document.addEventListener("pointerup", settingsPointerUp, true);
document.addEventListener("pointercancel", settingsPointerUp, true);

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  if (ch.workflows || ch.activeWorkflowId || ch.looseTabs || ch.openWindows || ch.pinnedTabs) load();
  if (ch.history) updateUndoBtn();
  if ((ch.history || ch.trash || ch.groupCopies) && !$("historyView").classList.contains("hidden")) renderHistory();
  const typingInSettings = $("settings").contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if ((ch.backups || ch.syncStatus || ch.multiSyncStatus || ch.syncConfig) && !$("settingsView").classList.contains("hidden") && !typingInSettings) {
    // Mid-click (e.g. leaving a login field saves it, then you release on Connect): redraw only after the click,
    // or the button you're clicking is replaced and the click is lost.
    if (settingsPointerDown) settingsRenderPending = true;
    else renderSettings();
  }
  if (ch.workflows || ch.looseTabs || ch.tombstones) scheduleFolderSync();
  if (ch.updateNotice) maybeShowUpdate();
});

let folderSyncStarted = false;
onSettings(s => {
  if (s.syncMethod === "folder" && !folderSyncStarted) { folderSyncStarted = true; setTimeout(() => folderSyncNow(), 1500); }
  const autosaveChanged = s.autosaveEnabled !== settings.autosaveEnabled
    || s.display !== settings.display || s.switchMode !== settings.switchMode;
  settings = s;
  renderDisplaySeg();
  paintPaletteBtn();
  if (!movingCard) {
    if (typeof s.boardZoom === "number" && s.boardZoom !== boardZoom && !boardZoomSave) boardZoom = clampZoom(s.boardZoom);
    applyBoardZoom();
    applyBoardWidth();
  }
  if (!$("settingsView").classList.contains("hidden")) renderSettings();
  if (autosaveChanged) renderBoard(); else renderSub();
});

// ---------- static UI ----------
$("logo").innerHTML = svgIcon("layers", 18);
$("searchIcon").innerHTML = svgIcon("search", 15);
$("addBtn").innerHTML = svgIcon("plus", 16) + "New workflow";
$("themeSlot").append(themeToggle());
$("emptyBoard").append(
  el("h2", { textContent: "No workflows yet" }),
  el("div", { textContent: "Create one here, or save your current tabs from the toolbar popup." })
);

$("addBtn").addEventListener("click", newWorkflow);
$("undoBtn").innerHTML = svgIcon("undo", 16);
$("undoBtn").addEventListener("click", doUndo);
function paintPaletteBtn() {
  $("paletteBtn").innerHTML = svgIcon("command", 15);
  $("paletteBtn").append(el("kbd", { textContent: hotkeyLabel(hotkeys().palette) }));
  $("paletteBtn").title = `Command palette (${hotkeyLabel(hotkeys().palette)})`;
}
paintPaletteBtn();
$("paletteBtn").addEventListener("click", () => managerPalette());
$("tagFilter").addEventListener("change", e => { tagFilter = e.target.value; refreshTagFilter(); renderBoard(); });
$("newTabBtn").innerHTML = svgIcon("plus", 17);
$("newTabBtn").title = "New tab";
$("newTabBtn").setAttribute("aria-label", "New tab");
$("newTabBtn").addEventListener("click", () => newTabDialog(LOOSE));
$("fileInput").addEventListener("change", e => {
  const f = e.target.files && e.target.files[0];
  if (f) importFile(f);
  e.target.value = "";
});
$("search").addEventListener("input", e => { query = e.target.value; renderBoard(); });
document.querySelectorAll(".views button").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
window.addEventListener("hashchange", () => setView(location.hash.slice(1)));

document.addEventListener("keydown", e => {
  if (recordingHotkey) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  const combo = comboFromEvent(e);
  const hk = hotkeys();
  if (combo && combo === hk.palette && (combo.includes("+") || !typing)) { e.preventDefault(); if ($("modal").classList.contains("hidden")) managerPalette(); return; }
  if (combo && combo === hk.undo && !typing && $("modal").classList.contains("hidden") && !paletteEl) {
    e.preventDefault(); doUndo(); return;
  }
  if (e.key === "Escape") {
    if (!$("modal").classList.contains("hidden")) { $("modal")._cancel && $("modal")._cancel(); return; }
    if (!$("menu").classList.contains("hidden")) { closeMenu(); return; }
    if ($("helpPop") && !$("helpPop").classList.contains("hidden")) { toggleHelp(false); return; }
    if (selection.size) { clearSelection(); return; }
    if (document.activeElement === $("search") && query) { $("search").value = ""; query = ""; renderBoard(); }
  }
  if (combo && combo === hk.search && (combo.includes("+") || !typing) && $("modal").classList.contains("hidden")) {
    e.preventDefault();
    setView("board");
    $("search").focus();
  }
});

enableCanvasPan();
renderDisplaySeg();
setView(location.hash.slice(1) || "board");
updateUndoBtn();
load();

// ---------- welcome & update screens ----------
function sheetDialog(children, wide = true) {
  const m = $("modal");
  m.innerHTML = "";
  const d = el("div", { className: "dialog sheet-screen" + (wide ? " wide" : ""), role: "dialog", "aria-modal": "true" }, children);
  m.append(d);
  m.classList.remove("hidden");
  return d;
}

function showWelcome() {
  const done = async () => { closeModal(); await chrome.storage.local.set({ showWelcome: false }); };
  const point = (icon, title, text) => el("div", { className: "welcome-point" }, [
    el("span", { className: "tile sm", html: svgIcon(icon, 16) }),
    el("div", {}, [el("div", { className: "wp-title", textContent: title }), el("div", { className: "wp-text", textContent: text })])
  ]);
  sheetDialog([
    el("div", { className: "screen-hero" }, [el("div", { className: "logo big", html: svgIcon("layers", 26) }),
      el("div", {}, [el("h2", { textContent: "Welcome to Tab Workflows" }),
        el("p", { textContent: "Keep your tabs in named workflows and switch between them in one click." })])]),
    el("div", { className: "welcome-points" }, [
      point("folder", "Workflows", "A workflow is a set of tabs – work, school, a project. Your open tabs are your first one."),
      point("save", "Autosave", "Every change to your tabs is saved into the workflow you’re in. “Save current” in the popup saves right away."),
      point("switch", "Switching", "Open another workflow from the popup or here. Your tabs are saved, closed and the other workflow’s tabs open."),
      point("divider", "Dividers", "Split your tab strip with named, coloured divider tabs (Alt+Shift+D). They sleep, so they cost almost no memory."),
      point("cloud", "Sync & backups", "Sync between Chrome, Helium, Brave… in Settings → Sync. Daily backups and 3 copies per workflow keep you safe."),
      point("command", "Shortcuts", "Ctrl+Shift+K opens the popup, Ctrl+K here opens the command palette, Ctrl+Z undoes.")
    ]),
    el("div", { className: "buttons" }, [el("button", { className: "btn primary", textContent: "Get started", on: { click: done } })])
  ]);
  $("modal").onmousedown = null;
  $("modal")._cancel = done;
}

// Render the changelog sections newer than `mine` (as text – never as HTML).
function changelogNodes(text, mine) {
  const out = [];
  let on = false, list = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    const v = line.match(/^##\s+v?(\d+(?:\.\d+)*)/);
    if (v) {
      on = cmpVer(v[1], mine) > 0;
      list = null;
      if (on) out.push(el("h3", { className: "cl-version", textContent: "Version " + v[1] }));
      continue;
    }
    if (!on || !line || /^#\s/.test(line)) continue;
    const h = line.match(/^###\s+(.*)/);
    if (h) { out.push(el("div", { className: "cl-kind", textContent: h[1] })); list = null; continue; }
    const b = line.match(/^[*-]\s+(.*)/);
    if (b) {
      if (!list) { list = el("ul", { className: "cl-list" }); out.push(list); }
      list.append(el("li", {}, boldNodes(b[1])));
    }
  }
  return out;
}
// "**text**" in a changelog line shows as bold (built as text nodes, never as HTML).
function boldNodes(text) {
  return String(text).split(/\*\*(.+?)\*\*/).map((part, i) => i % 2 ? el("strong", { textContent: part }) : document.createTextNode(part));
}
// A changelog without any "## <version>" sections (e.g. a placeholder): show every line as it is (as text).
function plainChangelogNodes(text) {
  const out = [];
  let list = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const b = line.match(/^[*-]\s+(.*)/);
    const body = (b ? b[1] : line).replace(/^#+\s*/, "");
    if (!body) continue;
    if (b) {
      if (!list) { list = el("ul", { className: "cl-list" }); out.push(list); }
      list.append(el("li", { textContent: body }));
    } else {
      list = null;
      out.push(el(/^#/.test(line) ? "h3" : "p", { className: /^#/.test(line) ? "cl-version" : "", textContent: body }));
    }
  }
  return out;
}
const hasVersionSections = text => /^\s*##\s+v?\d/m.test(String(text || ""));
function cmpVer(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

// The outdated screen shows CHANGELOG.md from GitHub (always the newest). If GitHub can't be reached,
// or that file has nothing newer than this browser's version, it uses the copy the newer browser shared through sync.
const CHANGELOG_URL = "https://raw.githubusercontent.com/reapertakumi/Tab-Workflows/main/CHANGELOG.md";
const CHANGELOG_PAGE = "https://github.com/reapertakumi/Tab-Workflows/blob/main/CHANGELOG.md";

async function githubChangelog() {
  try {
    const r = await fetch(CHANGELOG_URL, { cache: "no-store" });
    return r.ok ? await r.text() : null;
  } catch (_) { return null; }
}

async function showUpdateScreen(n) {
  const github = await githubChangelog();
  // GitHub's file wins whenever it has something to show: its newer versions, or – if it has no
  // version sections at all – its whole text.
  const fromGithub = !github ? [] : hasVersionSections(github) ? changelogNodes(github, n.mine) : plainChangelogNodes(github);
  const later = async () => {
    closeModal();
    const { updateNotice } = await chrome.storage.local.get("updateNotice");
    if (updateNotice) await chrome.storage.local.set({ updateNotice: { ...updateNotice, dismissed: true } });
  };
  const notes = fromGithub.length ? fromGithub : changelogNodes(n.notes, n.mine);
  const source = fromGithub.length ? "From the changelog on GitHub."
    : notes.length ? (github === null ? "GitHub couldn’t be reached – showing the changelog your other browser shared." : "Showing the changelog your other browser shared.") : "";
  sheetDialog([
    el("div", { className: "screen-hero" }, [el("div", { className: "logo big warn", html: svgIcon("upload", 24) }),
      el("div", {}, [el("div", { className: "chip warn-chip", textContent: "OUTDATED" }),
        el("h2", { textContent: "Update available" }),
        el("p", { textContent: `This browser runs Tab Workflows ${n.mine}. ${n.browser} – synced with this one – already runs ${n.latest}. Update here too so both work the same way.` })])]),
    el("div", { className: "version-compare" }, [
      el("div", { className: "vc old" }, [el("span", { textContent: "This browser" }), el("b", { textContent: n.mine })]),
      el("span", { className: "vc-arrow", html: svgIcon("arrow", 18) }),
      el("div", { className: "vc new" }, [el("span", { textContent: n.browser }), el("b", { textContent: n.latest })])
    ]),
    el("div", { className: "changelog" }, notes.length ? notes : [el("p", { textContent: "No list of changes found – update to see what’s new." })]),
    el("p", { className: "muted small" }, [source ? source + " " : "",
      el("a", { href: CHANGELOG_PAGE, target: "_blank", rel: "noopener", textContent: "View the changelog on GitHub" })]),
    el("p", { className: "muted small", textContent: "To update: replace the extension’s files with the new version (or update it from the store), then press the reload button on the extensions page." }),
    el("div", { className: "buttons" }, [
      el("button", { className: "btn ghost", textContent: "Later", on: { click: later } }),
      el("button", { className: "btn primary", textContent: "Open extensions page", on: { click: () => chrome.tabs.create({ url: "chrome://extensions/?id=" + chrome.runtime.id }) } })
    ])
  ]);
  $("modal").onmousedown = e => { if (e.target === $("modal")) later(); };
  $("modal")._cancel = later;
}

let updateShownFor = null;
async function maybeShowUpdate() {
  const { updateNotice: n } = await chrome.storage.local.get("updateNotice");
  if (!n || n.dismissed || updateShownFor === n.latest || !$("modal").classList.contains("hidden")) return;
  updateShownFor = n.latest;
  showUpdateScreen(n);
}

(async () => {
  const { showWelcome: welcome } = await chrome.storage.local.get("showWelcome");
  if (welcome) showWelcome();
  else maybeShowUpdate();
})();

// ---------- Session Manager shortcuts (changeable in Settings → About) ----------
const HOTKEY_ACTIONS = [["palette", "Command palette"], ["undo", "Undo"], ["search", "Search the board"]];
let recordingHotkey = false;
// (function declarations: the palette button uses them before this part of the file has run)
function hotkeys() { return { ...DEFAULT_SETTINGS.hotkeys, ...(settings.hotkeys || {}) }; }
function hotkeyLabel(c) { return String(c || "").split("+").join(" "); }

// "Ctrl+Shift+K", "Alt+F2", "/" … (Ctrl and ⌘ count as the same; Shift is ignored for symbols like / and ?)
function comboFromEvent(e) {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "Dead", "Unidentified"].includes(e.key)) return "";
  let key = e.key === " " ? "Space" : e.key;
  if (key.length === 1) key = key.toUpperCase();
  const symbol = key.length === 1 && key.toLowerCase() === key.toUpperCase() && !/[0-9]/.test(key);
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey && !(symbol && !e.ctrlKey && !e.metaKey && !e.altKey)) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

function hotkeyCap(id) {
  const cap = el("button", { type: "button", className: "keycap edit", title: "Click, then press the new shortcut (Esc cancels)", textContent: hotkeyLabel(hotkeys()[id]) });
  cap.addEventListener("click", () => {
    if (recordingHotkey) return;
    recordingHotkey = true;
    cap.classList.add("recording");
    cap.textContent = "Press keys…";
    const stop = () => { recordingHotkey = false; cap.classList.remove("recording"); window.removeEventListener("keydown", onKey, true); cap.removeEventListener("blur", cancel); };
    const cancel = () => { stop(); cap.textContent = hotkeyLabel(hotkeys()[id]); };
    const onKey = async e => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") return cancel();
      const combo = comboFromEvent(e);
      if (!combo) return;
      if (/^(Shift\+)?[A-Z0-9]$/.test(combo)) { cap.textContent = "Add Ctrl or Alt"; return; }   // would block typing
      stop();
      const next = hotkeys();
      const clash = Object.keys(next).find(k => k !== id && next[k] === combo);
      if (clash) next[clash] = next[id];       // swap with the action that had it
      next[id] = combo;
      await setSetting("hotkeys", next);
      toast(`Shortcut set to ${hotkeyLabel(combo)}` + (clash ? ` (swapped with ${HOTKEY_ACTIONS.find(a => a[0] === clash)[1]})` : ""));
    };
    window.addEventListener("keydown", onKey, true);
    cap.addEventListener("blur", cancel);
  });
  return el("div", { className: "row-btns" }, [cap,
    hotkeys()[id] !== DEFAULT_SETTINGS.hotkeys[id] ? el("button", { className: "btn sm ghost", textContent: "Reset",
      on: { click: () => setSetting("hotkeys", { ...hotkeys(), [id]: DEFAULT_SETTINGS.hotkeys[id] }) } }) : null]);
}

// The shortcut the browser really uses for one of our commands ("" when none is set).
async function browserShortcut(name) {
  try { const c = (await chrome.commands.getAll()).find(x => x.name === name); return c && c.shortcut ? hotkeyLabel(c.shortcut) : ""; }
  catch (_) { return ""; }
}
