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
function openMenu(anchor, items) {
  const m = $("menu");
  m.innerHTML = "";
  for (const it of items) {
    if (it === "sep") { m.append(el("hr")); continue; }
    m.append(el("button", {
      className: it.danger ? "danger" : "", role: "menuitem",
      html: svgIcon(it.icon, 15) + `<span></span>`,
      on: { click: () => { closeMenu(); it.action(); } }
    }));
    m.lastChild.querySelector("span").textContent = it.label;
  }
  m.classList.remove("hidden");
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  let left = Math.min(r.right - w, window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  m.style.left = Math.max(8, left) + "px";
  m.style.top = top + "px";
}
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
  toast(`Opening “${wf.name}”…`);
  const res = await send("openWorkflow", { id: wf.id });
  if (!res.ok) toast("Couldn’t open: " + res.error);
}

async function deleteWorkflow(wf) {
  if (!(await confirmDialog(`Delete “${wf.name}”?`, `Its ${plural(countTabs(wf), "saved tab")} will be removed. Your open tabs are not affected.`, "Delete", true))) return;
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
  const rows = [...ul.querySelectorAll(".tab-row")].filter(r => !r.classList.contains("hide") && r !== dragging.row);
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
      if (before) { if (dropLine.nextSibling !== before) ul.insertBefore(dropLine, before); }
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
    const total = wins[win] ? wins[win].tabs.length : 0;
    const same = dragging.from.id === wf.id && dragging.from.win === win && !e.ctrlKey;
    clearDropUi();
    doDrop({ id: wf.id, win, idx: same ? total - 1 : total }, e.ctrlKey);
  });
  card.addEventListener("dragleave", e => {
    if (!card.contains(e.relatedTarget)) { card.classList.remove("drop-target"); if (card.contains(dropLine)) dropLine.remove(); }
  });
}

// ---------- selecting several tabs (per workflow card) ----------
// selection: workflowId -> { keys: Set("win:idx"), last: "win:idx" | null }
const selection = new Map();
const selFor = id => selection.get(id);
const keyOf = (wi, ti) => `${wi}:${ti}`;
const allKeys = wf => (wf.windows || []).flatMap((w, wi) => w.tabs.map((_, ti) => keyOf(wi, ti)));

function setSelectMode(wf, on) {
  if (on) selection.set(wf.id, { keys: new Set(), last: null });
  else selection.delete(wf.id);
  renderBoard();
}

function toggleTabSelected(wf, wi, ti, shift) {
  const sel = selFor(wf.id);
  if (!sel) return;
  const k = keyOf(wi, ti);
  if (shift && sel.last && sel.last.split(":")[0] === String(wi)) {
    // Shift-click: tick everything between the last clicked tab and this one (same window).
    const from = +sel.last.split(":")[1];
    const [a, b] = from < ti ? [from, ti] : [ti, from];
    for (let i = a; i <= b; i++) sel.keys.add(keyOf(wi, i));
  } else if (sel.keys.has(k)) sel.keys.delete(k);
  else sel.keys.add(k);
  sel.last = k;
  renderBoard();
}

// The checkbox row above the first tab.
function selectBar(wf, total) {
  const sel = selFor(wf.id);
  if (sel) { const valid = new Set(allKeys(wf)); sel.keys.forEach(k => { if (!valid.has(k)) sel.keys.delete(k); }); }
  const n = sel ? sel.keys.size : 0;
  const cb = el("input", { type: "checkbox", className: "sel-check", checked: !!sel && n > 0 && n === total,
    title: !sel ? "Select tabs" : n === total ? "Select none" : "Select all" });
  cb.indeterminate = !!sel && n > 0 && n < total;
  cb.addEventListener("change", () => {
    if (!sel) return setSelectMode(wf, true);
    if (n === total) sel.keys.clear();
    else allKeys(wf).forEach(k => sel.keys.add(k));
    renderBoard();
  });
  return el("div", { className: "select-bar" + (sel ? " on" : "") }, [
    el("label", {}, [cb, el("span", { textContent: !sel ? "Select tabs" : n ? `${n} of ${total} selected` : "Tick the tabs you want" })]),
    sel ? el("button", { className: "sel-done", textContent: "Done", title: "Stop selecting", on: { click: () => setSelectMode(wf, false) } }) : null
  ]);
}

// Header buttons while tabs are ticked.
function selectionActions(wf) {
  const n = selFor(wf.id).keys.size;
  return el("div", { className: "card-actions sel-actions" }, [
    el("button", { className: "btn sm", html: svgIcon("copy", 14) + "Copy", title: `Copy ${plural(n, "tab")} to another workflow`,
      on: { click: () => bulkAction(wf, "copy") } }),
    el("button", { className: "btn sm primary", html: svgIcon("arrow", 14) + "Move", title: `Move ${plural(n, "tab")} to another workflow`,
      on: { click: () => bulkAction(wf, "move") } }),
    el("button", { className: "iconbtn flat danger", title: `Remove ${plural(n, "tab")}`, html: svgIcon("trash", 15),
      on: { click: () => bulkAction(wf, "remove") } }),
    el("button", { className: "iconbtn flat", title: "Cancel selection", html: svgIcon("close", 15),
      on: { click: () => setSelectMode(wf, false) } })
  ]);
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

async function bulkAction(wf, kind) {
  const sel = selFor(wf.id);
  if (!sel || !sel.keys.size) return;
  const items = [...sel.keys].map(k => { const [win, idx] = k.split(":").map(Number); return { win, idx }; });
  const n = items.length;
  const live = isLive(wf);

  if (kind === "remove") {
    const ok = await confirmDialog(`Remove ${plural(n, "tab")} from “${wf.name}”?`,
      live ? "This workflow is open, so these tabs will be closed in the browser too." : "They’ll be removed from this workflow.", "Remove", true);
    if (!ok) return;
    await send("removeTabs", { id: wf.id, items });
    toast(`Removed ${plural(n, "tab")}`, undoAction);
  } else {
    let toId = await chooseTarget({
      title: `${kind === "copy" ? "Copy" : "Move"} ${plural(n, "tab")} to…`,
      text: kind === "move" && live ? "This workflow is open, so moved tabs are closed here in the browser." : null,
      excludeId: wf.id
    });
    if (!toId) return;
    if (toId === "__new__") {
      const r = await workflowDialog({ title: "New workflow", text: `The ${plural(n, "tab")} will go into it.`, submit: "Create" });
      if (!r) return;
      const res = await send("createEmptyWorkflow", r);
      if (!res.ok) return toast("Couldn’t create the workflow");
      toId = res.result;
    }
    await send("moveTabs", { fromId: wf.id, items, toId, copy: kind === "copy" });
    const dst = toId === LOOSE ? "Unsorted tabs" : (state.workflows[toId] ? state.workflows[toId].name : "the new workflow");
    toast(`${kind === "copy" ? "Copied" : "Moved"} ${plural(n, "tab")} to “${dst}”`, undoAction);
  }
  selection.delete(wf.id);
  renderBoard();
}

// ---------- tips (? button, bottom-left) ----------
const TAB_TIPS = [
  "Drag a tab to another workflow to move it – hold Ctrl while dropping to copy it",
  "Double-click a tab to open it; hover it for edit, open and remove",
  "Tick “Select tabs” above the first tab to copy, move or remove several at once",
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
  const sel = selFor(wf.id);
  const picked = !!sel && sel.keys.has(keyOf(wi, ti));
  const row = el("li", { className: "tab-row" + (hidden ? " hide" : "") + (picked ? " picked" : ""), draggable: true,
      title: label === t.url ? t.url : `${label}\n${t.url}`, "data-idx": ti }, [
    sel ? el("input", { type: "checkbox", className: "row-check", checked: picked, tabIndex: -1, "aria-label": "Select " + label }) : null,
    el("span", { className: "tab-num", textContent: ti + 1 }),
    favicon(t.url, t.favIconUrl),
    el("div", { className: "tab-text" }, [
      el("span", { className: "tab-title" }, [highlight(label, q)]),
      el("span", { className: "tab-host" }, [highlight(hostOf(t.url), q)]),
      el("span", { className: "tab-url" }, [highlight(t.url, q)])
    ]),
    t.pinned ? el("span", { className: "pin", title: "Pinned", html: svgIcon("pin", 13) }) : null,
    el("div", { className: "row-actions" }, [
      el("button", { title: "Edit name and link", html: svgIcon("edit", 13),
        on: { click: e => { e.stopPropagation(); editTabDialog(wf, wi, ti, t); } } }),
      el("button", { title: live ? "Go to this tab" : "Open in a new tab", html: svgIcon("external", 13),
        on: { click: e => { e.stopPropagation(); send("focusTab", { id: wf.id, win: wi, idx: ti }); } } }),
      el("button", { className: "rm", title: live ? "Close this tab" : (wf.id === LOOSE ? "Delete this tab" : "Remove from workflow"), html: svgIcon("close", 13),
        on: { click: async e => { e.stopPropagation(); await send("removeTab", { id: wf.id, win: wi, idx: ti }); toast("Removed a tab", undoAction); } } })
    ])
  ]);
  row.addEventListener("click", e => {
    if (!selFor(wf.id) || e.target.closest(".row-actions")) return;
    e.preventDefault();
    toggleTabSelected(wf, wi, ti, e.shiftKey);
  });
  row.addEventListener("dblclick", () => { if (!selFor(wf.id)) send("focusTab", { id: wf.id, win: wi, idx: ti }); });
  row.addEventListener("dragstart", e => {
    dragging = { from: { id: wf.id, win: wi, idx: ti }, row };
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData("text/uri-list", t.url);
    e.dataTransfer.setData("text/plain", t.url);
    setTimeout(() => row.classList.add("dragging"), 0);
  });
  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    clearDropUi();
    dragging = null;
    if (pendingRender) { pendingRender = false; renderBoard(); }
  });
  return row;
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
    className: "card" + (active ? " active" : "") + (isCollapsed ? " collapsed" : "") + (loose ? " loose" : "")
      + (selFor(wf.id) ? " selecting" : ""),
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
      collapsed.has(wf.id) ? collapsed.delete(wf.id) : collapsed.add(wf.id);
      writeLocal("tm-collapsed", [...collapsed]);
      card.classList.toggle("collapsed");
    } } });

  const picking = !!selFor(wf.id) && selFor(wf.id).keys.size > 0;
  const head = loose ? el("div", { className: "card-head" }, [
    el("div", { className: "tile", html: svgIcon("list", 19) }),
    el("div", { className: "card-title" }, [
      el("div", { className: "card-name" }, [highlight(wf.name, q)]),
      el("div", { className: "card-meta", textContent: `${plural(tabsN, "tab")} · not in any workflow` })
    ]),
    picking ? selectionActions(wf) : el("div", { className: "card-actions" }, [
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
    picking ? selectionActions(wf) : el("div", { className: "card-actions" }, [
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
  if (tabsN) body.append(selectBar(wf, tabsN));
  windows.forEach((w, wi) => {
    if (windows.length > 1) body.append(el("div", { className: "win-label", textContent: `Window ${wi + 1}` }));
    const ul = el("ul", { className: "tab-list" + (w.tabs.length ? "" : " empty-list"), "data-id": wf.id, "data-win": wi });
    if (!w.tabs.length) ul.textContent = loose ? "Drop tabs here to keep them outside any workflow" : "Drop tabs here";
    let lastGroup = null;
    w.tabs.forEach((t, ti) => {
      const m = !q || nameMatch || ((t.name || "") + " " + (t.title || "") + " " + t.url).toLowerCase().includes(q);
      if (m && q) matches++;
      const g = t.group && w.groups && w.groups[t.group];
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
  ["sync", "Sync", "cloud"],
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
async function renderSettings() {
  const myId = ++settingsRenderId;
  const section = (title, rows) => el("section", { className: "set-section" }, [title ? el("h2", { textContent: title }) : null, ...rows]);
  const page = SETTINGS_PAGES.find(p => p[0] === settingsPage) || SETTINGS_PAGES[0];
  const content = await settingsPageContent(page[0], section);
  if (myId !== settingsRenderId) return;          // a newer render started meanwhile

  const nav = el("nav", { className: "set-nav", "aria-label": "Settings" }, SETTINGS_PAGES.map(([id, label, icon]) =>
    el("button", { className: "set-nav-item" + (id === page[0] ? " on" : ""), html: svgIcon(icon, 16), "aria-current": id === page[0] ? "page" : null,
      on: { click: () => openSettingsPage(id) } }, [el("span", { textContent: label })])));
  const target = $("settings");
  const fresh = !target.querySelector(".settings-layout");
  target.replaceChildren(el("div", { className: "settings-layout" }, [
    nav,
    el("div", { className: "set-panel" + (fresh ? "" : " no-anim") }, [el("h1", { className: "set-page-title", textContent: page[1] }), ...content])
  ]));
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
      ])
    ];
  }
  if (id === "saving") {
    return [section("Autosave", [
      row("Autosave", "Save the session (and the open workflow, if its autosave is on) on every tab change.", switchCtl("autosaveEnabled")),
      row("Autosave delay", "How long to wait after the last tab change before saving.",
        selectCtl("autosaveDelay", [[400, "Instant (0.4 s)"], [1000, "1 second"], [3000, "3 seconds"], [10000, "10 seconds"]])),
      row("Autosave new workflows", "New workflows start with autosave turned on.", switchCtl("newWorkflowAutosave")),
      row("Skip empty New Tab pages", "Don’t store blank New Tab pages in sessions and workflows.", switchCtl("skipNewTabs"))
    ])];
  }
  if (id === "switching") {
    return [section("Opening workflows", [
      row("Opening a workflow", "Replace your current tabs in this window, or open each workflow in its own window so several can be open at once.",
        segText("switchMode", [["replace", "Replace current"], ["windows", "New window"]])),
      row("Save memory after switching", "Background tabs finish loading and are then put to sleep until you click them. Tabs are never interrupted while loading, and a tab that’s stuck when you open it is reloaded.", switchCtl("lazyLoad")),
      row("Ask before switching", "Always confirm before closing your tabs to open another workflow. You’re always asked when unsaved tabs would be lost.", switchCtl("confirmSwitch")),
      row("Keep this page open", "Re-open the Session Manager after switching workflows.", switchCtl("keepManagerOpen"))
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
  const keys = [["Ctrl K", "Command palette"], ["Ctrl Z", "Undo"], ["/", "Search the board"], ["Ctrl + scroll", "Zoom"], ["Esc", "Close / stop selecting"]];
  return [
    section("Tab Workflows", [row("Version " + version, `${(bytes / 1024).toFixed(1)} KB stored on this device`, el("span"))]),
    section("Keyboard", keys.map(([k, what]) => row(what, null, el("kbd", { className: "keycap", textContent: k }))))
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

async function askHostAccess(urls) {
  const origins = [...new Set(urls.map(u => { try { return new URL(u).origin + "/*"; } catch (_) { return null; } }).filter(Boolean))];
  if (!origins.length) return false;
  try { return await chrome.permissions.request({ origins }); } catch (_) { return false; }
}

async function runSync(force = false) {
  if (settings.syncMethod === "folder") return folderSyncNow({ ask: true, force });
  if (MULTI_SYNC.includes(settings.syncMethod)) {
    const r = await send("multiSyncNow", { force });
    return r.result;
  }
  return null;
}

function syncToast(st) {
  if (!st) return;
  toast(st.ok ? (st.fromOther ? "Synced – workflows from your other browsers are here" : "Synced") : "Sync problem: " + st.error);
}

async function syncPage(section) {
  const { syncConfig = {}, multiSyncStatus = null, syncStatus = null } =
    await chrome.storage.local.get(["syncConfig", "multiSyncStatus", "syncStatus"]);
  const method = settings.syncMethod || "off";
  const multi = MULTI_SYNC.includes(method);
  const out = [];

  out.push(section("How to sync", [el("div", { className: "method-grid" }, SYNC_METHODS.map(([id, label, icon, desc]) =>
    el("button", { className: "method" + (id === method ? " on" : ""), "aria-pressed": String(id === method),
      on: { click: async () => {
        if (id === method) return;
        await setSetting("syncMethod", id);
        if (id === "chrome") { const r = await send("syncNow"); toast(r.ok && r.result && r.result.ok ? "Synced to your Chrome profile" : "Chrome profile sync turned on"); }
        else if (MULTI_SYNC.includes(id) && syncConfig.passphrase && id !== "folder") syncToast(await runSync());
      } } }, [
      el("span", { className: "tile sm", html: svgIcon(icon, 16) }),
      el("span", { className: "method-text" }, [el("span", { className: "method-name", textContent: label }), el("span", { className: "method-desc", textContent: desc })]),
      el("span", { className: "method-check", html: svgIcon("check", 14) })
    ])))]));

  if (method === "chrome") out.push(await chromeSyncSection(section, syncStatus));

  if (multi) {
    // Passphrase
    const pass = el("input", { type: "password", className: "field", value: syncConfig.passphrase || "", placeholder: "Same passphrase in every browser", autocomplete: "new-password" });
    const eye = el("button", { className: "iconbtn flat", title: "Show / hide", html: svgIcon("eye", 15), on: { click: () => { pass.type = pass.type === "password" ? "text" : "password"; } } });
    const savePass = el("button", { className: "btn sm primary", textContent: "Save", on: { click: async () => {
      const v = pass.value;
      if (v.length < 8) { toast("Use at least 8 characters"); pass.focus(); return; }
      if (syncConfig.passphrase && v !== syncConfig.passphrase &&
          !(await confirmDialog("Change the passphrase?", "Every browser has to use the new passphrase. The synced copy was encrypted with the old one – you can overwrite it from this browser afterwards.", "Change"))) return;
      await chrome.storage.local.set({ syncConfig: { ...syncConfig, passphrase: v } });
      toast("Passphrase saved");
      syncToast(await runSync());
    } } });
    out.push(section("Passphrase", [
      row("Passphrase", "Your workflows are encrypted with it before they leave this browser, so the storage can’t read them. Use the same one in Chrome, Brave, Helium… If you lose it, pick a new one and overwrite the synced copy.",
        el("div", { className: "field-row" }, [pass, eye, savePass]))
    ]));

    // Method settings
    out.push(section(SYNC_METHODS.find(m => m[0] === method)[1], await methodRows(method, syncConfig)));

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
        : "Syncs every 5 minutes and about 30 seconds after a change – even when this page is closed." })
    ]));
    out.push(section("Good to know", [el("ul", { className: "good-to-know" }, [
      method === "folder" ? "Brave: folder access is off by default – turn on brave://flags/#file-system-access-api and restart Brave." : null,
      method === "folder" ? "The folder only syncs while this Session Manager page is open in that browser." : null,
      method === "server" ? "Your server finds your data by the passphrase itself: a typo starts a separate, empty sync instead of showing an error. The status warns you when a passphrase had nothing synced yet." : null,
      "Your passphrase" + (method === "gist" ? " and GitHub token are" : method === "webdav" ? " and WebDAV password are" : " is") + " stored in this browser’s Tab Workflows data, so it can sync on its own. Anyone with access to this browser profile could read " + (method === "gist" || method === "webdav" ? "them" : "it") + ".",
      "Each workflow keeps whichever version was changed most recently. Deleting a workflow deletes it everywhere.",
      "Unsorted tabs are combined: a tab removed in one browser can come back from another.",
      method === "folder" ? null : "The first time you connect, Chrome asks to let Tab Workflows reach that address – it’s needed to send and fetch the encrypted file."
    ].filter(Boolean).map(t => el("li", { textContent: t })))]));
  }
  return out;
}

async function methodRows(method, cfg) {
  const input = (value, placeholder, type = "text") => el("input", { type, className: "field", value: value || "", placeholder, spellcheck: false, autocomplete: "off" });
  const save = async patch => {
    const { syncConfig = {} } = await chrome.storage.local.get("syncConfig");
    await chrome.storage.local.set({ syncConfig: { ...syncConfig, ...patch } });
  };

  if (method === "folder") {
    const handle = await idbGet("syncFolder").catch(() => null);
    const perm = handle ? await handle.queryPermission({ mode: "readwrite" }).catch(() => "denied") : null;
    return [
      row("Folder", handle ? `“${handle.name}”${perm === "granted" ? "" : " – needs your OK again"}`
                           : "Pick the same folder in each browser (for other computers: a Dropbox / OneDrive / Google Drive folder).",
        el("div", { className: "row-btns" }, [
          handle && perm !== "granted" ? el("button", { className: "btn sm primary", textContent: "Allow access", on: { click: async () => syncToast(await folderSyncNow({ ask: true })) } }) : null,
          el("button", { className: "btn sm" + (handle ? "" : " primary"), html: svgIcon("folder", 14) + (handle ? "Change folder" : "Choose folder"), on: { click: chooseSyncFolder } })
        ])),
      el("div", { className: "set-row muted", textContent: "Brave: folder access is off by default – turn on brave://flags/#file-system-access-api, then restart Brave." })
    ];
  }

  if (method === "gist") {
    const token = input(cfg.gistToken, "ghp_… or github_pat_…", "password");
    return [
      row("GitHub token", "A token that may only create and edit gists. Create one (tick just “gist”), copy it here, and use the same token in each browser.",
        el("div", { className: "field-row" }, [token,
          el("button", { className: "btn sm", textContent: "Create token", on: { click: () => window.open("https://github.com/settings/tokens/new?scopes=gist&description=Tab%20Workflows%20sync", "_blank") } }),
          el("button", { className: "btn sm primary", textContent: "Connect", on: { click: async () => {
            if (!(await askHostAccess(["https://api.github.com/", "https://gist.githubusercontent.com/"]))) { toast("Tab Workflows needs access to GitHub to sync"); return; }
            await save({ gistToken: token.value.trim() });
            syncToast(await runSync());
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
            syncToast(await runSync());
          } } })])),
      help
    ];
  }

  // webdav
  const url = input(cfg.webdavUrl, "https://cloud.example.com/remote.php/dav/files/you/TabWorkflows/");
  const user = input(cfg.webdavUser, "Username");
  const pass = input(cfg.webdavPass, "App password", "password");
  return [
    row("Folder address", "A WebDAV folder that already exists (Nextcloud: Settings → WebDAV shows it). The file " + SYNC_FILE + " is created in it.", url),
    row("Username & app password", "Use an app password if your storage offers one.", el("div", { className: "field-row" }, [user, pass,
      el("button", { className: "btn sm primary", textContent: "Connect", on: { click: async () => {
        const v = url.value.trim();
        if (!/^https?:\/\//i.test(v)) { toast("Enter the full folder address, starting with https://"); return; }
        if (!(await askHostAccess([v]))) { toast("Tab Workflows needs access to your WebDAV storage to sync"); return; }
        await save({ webdavUrl: v, webdavUser: user.value.trim(), webdavPass: pass.value });
        syncToast(await runSync());
      } } })]))
  ];
}

async function chromeSyncSection(section, syncStatus) {
  const info = (await send("syncInfo")).result;
  return section("Chrome profile", [
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
  catch (_) { return; }   // cancelled
  await idbSet("syncFolder", handle);
  const { syncConfig = {} } = await chrome.storage.local.get("syncConfig");
  await chrome.storage.local.set({ syncConfig: { ...syncConfig, folderName: handle.name } });
  syncToast(await folderSyncNow({ ask: true }));
  renderSettings();
}

let folderSyncing = false;
async function folderSyncNow({ ask = false, force = false } = {}) {
  if (settings.syncMethod !== "folder" || folderSyncing) return null;
  const status = async st => { const s = { at: Date.now(), method: "folder", ...st }; await chrome.storage.local.set({ multiSyncStatus: s }); return s; };
  const handle = await idbGet("syncFolder").catch(() => null);
  if (!handle) return status({ ok: false, error: "Choose a folder first." });
  const { syncConfig = {} } = await chrome.storage.local.get("syncConfig");
  if (!syncConfig.passphrase) return status({ ok: false, error: "Set a passphrase first." });
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
    const remote = text ? await openSync(text, syncConfig.passphrase) : null;
    const res = await send("syncMergeRemote", { remote: force ? null : remote });
    if (!res.ok) throw new Error(res.error);
    const payload = res.result;
    let uploaded = false;
    if (force || !remote || !sameSyncContent(remote, payload)) {
      const fh = await handle.getFileHandle(SYNC_FILE, { create: true });
      const w = await fh.createWritable();
      await w.write(await sealSync(payload, syncConfig.passphrase));
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

// Place cards that don't have a spot yet in tidy columns next to the ones you've placed.
function layoutCanvas(cards) {
  const COLW = 360, GAP = 20, COLS = 4;
  const unplaced = cards.filter(c => !canvas.pos[c.dataset.id]);
  if (unplaced.length) {
    const placed = cards.filter(c => canvas.pos[c.dataset.id]);
    const baseX = placed.length ? Math.max(...placed.map(c => canvas.pos[c.dataset.id].x + 340)) + 40 : 24;
    const colY = Array(COLS).fill(24);
    for (const c of unplaced) {
      const col = colY.indexOf(Math.min(...colY));
      canvas.pos[c.dataset.id] = { x: baseX + col * COLW, y: colY[col], z: ++zTop };
      colY[col] += (c.offsetHeight || 120) + GAP;
    }
    saveCanvas();
  }
  for (const c of cards) {
    const p = canvas.pos[c.dataset.id];
    c.style.left = p.x + "px";
    c.style.top = p.y + "px";
    c.style.zIndex = p.z || 1;
    if (p.w) c.style.width = p.w + "px";
    if (p.h) c.style.height = p.h + "px";
  }
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
        card.style.width = ""; card.style.height = "";
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
        if (mode === "canvas") saveCanvas();
        else setSetting("boardWidth", boardW);
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
    if (!e.ctrlKey && !e.metaKey && e.target.closest && e.target.closest(".canvas-world .card")) {
      const body = e.target.closest(".card-body");
      if (!(body && body.scrollHeight > body.clientHeight + 1)) e.preventDefault();
      return;   // scrollable list: the browser scrolls it (overscroll-behavior keeps it from spilling over)
    }
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    else { canvas.x -= e.deltaX; canvas.y -= e.deltaY; applyView(); saveCanvas(); }
  }, { passive: false });
}

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
  if (location.hash !== "#" + v) { try { history.replaceState(null, "", "#" + v); } catch (_) {} }
  if (v === "settings") renderSettings();
  else if (typeof applyBoardWidth === "function") applyBoardWidth();
}

function renderDisplaySeg() {
  const seg = $("displaySeg");
  seg.innerHTML = "";
  for (const [v, icon, label] of [["board", "board", "Board"], ["list", "list", "List"], ["canvas", "canvas", "Canvas"]]) {
    seg.append(el("button", { type: "button", title: label, className: settings.display === v ? "on" : "", html: svgIcon(icon, 14),
      on: { click: () => setSetting("display", v) } }));
  }
  document.body.classList.toggle("display-list", settings.display === "list");
  document.body.classList.toggle("display-canvas", settings.display === "canvas");
}

// ---------- data ----------
async function load() {
  const data = await chrome.storage.local.get(["workflows", "activeWorkflowId", "looseTabs", "openWindows"]);
  state = { workflows: data.workflows || {}, activeWorkflowId: data.activeWorkflowId || null,
            looseTabs: data.looseTabs || [], openWindows: data.openWindows || {} };
  refreshTagFilter();
  renderBoard();
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  if (ch.workflows || ch.activeWorkflowId || ch.looseTabs || ch.openWindows) load();
  if (ch.history) updateUndoBtn();
  if ((ch.history || ch.trash || ch.groupCopies) && !$("historyView").classList.contains("hidden")) renderHistory();
  const typingInSettings = $("settings").contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if ((ch.backups || ch.syncStatus || ch.multiSyncStatus || ch.syncConfig) && !$("settingsView").classList.contains("hidden") && !typingInSettings) renderSettings();
  if (ch.workflows || ch.looseTabs || ch.tombstones) scheduleFolderSync();
});

let folderSyncStarted = false;
onSettings(s => {
  if (s.syncMethod === "folder" && !folderSyncStarted) { folderSyncStarted = true; setTimeout(() => folderSyncNow(), 1500); }
  const autosaveChanged = s.autosaveEnabled !== settings.autosaveEnabled
    || s.display !== settings.display || s.switchMode !== settings.switchMode;
  settings = s;
  renderDisplaySeg();
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
$("paletteBtn").innerHTML = svgIcon("command", 15) + "<kbd>Ctrl K</kbd>";
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
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); if ($("modal").classList.contains("hidden")) managerPalette(); return; }
  if (mod && !e.shiftKey && e.key.toLowerCase() === "z" && !typing && $("modal").classList.contains("hidden") && !paletteEl) {
    e.preventDefault(); doUndo(); return;
  }
  if (e.key === "Escape") {
    if (!$("modal").classList.contains("hidden")) { $("modal")._cancel && $("modal")._cancel(); return; }
    if (!$("menu").classList.contains("hidden")) { closeMenu(); return; }
    if ($("helpPop") && !$("helpPop").classList.contains("hidden")) { toggleHelp(false); return; }
    if (selection.size) { selection.clear(); renderBoard(); return; }
    if (document.activeElement === $("search") && query) { $("search").value = ""; query = ""; renderBoard(); }
  }
  if (e.key === "/" && !typing && $("modal").classList.contains("hidden")) {
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
