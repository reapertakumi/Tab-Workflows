const ICON_NAMES = Object.keys(ICON_PATHS);
const $ = id => document.getElementById(id);

const els = {
  logo: $("logo"), status: $("status"), newBtn: $("newBtn"), saveBtn: $("saveBtn"), dividerBtn: $("dividerBtn"),
  sheet: $("sheet"), list: $("list"), empty: $("empty"), count: $("count")
};

let state = { workflows: {}, activeWorkflowId: null, currentSession: null, openWindows: {} };
let sheetMode = null;        // null | "save" | "edit" | "new2" (new workflow)
let sheetData = {};          // form state for the open sheet
const expanded = new Set();

// ---------- helpers ----------
function send(type, payload) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type, payload }, res => resolve(res || { ok: false }));
  });
}

const countTabs = (windows = []) => windows.reduce((n, w) => n + (w.tabs ? w.tabs.length : 0), 0);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

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

function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "html") n.innerHTML = v;
    else if (k === "on") for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
    else if (k in n) n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null && c !== false) n.append(c);
  return n;
}

const icon = (name, size) => el("span", { html: svgIcon(name, size), style: "display:contents" });

// ---------- icon picker + name field ----------
// Colour label – same colours as in the Session Manager; shown as a stripe on the workflow's left side.
const WF_COLORS = ["", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "grey"];
function colorField(data) {
  const wrap = el("div", { className: "color-row" }, [el("span", { className: "color-label", textContent: "Colour" })]);
  const sw = el("div", { className: "color-swatches" });
  const paint = () => sw.replaceChildren(...WF_COLORS.map(c => el("button", {
    type: "button", className: "cswatch" + ((data.color || "") === c ? " on" : "") + (c ? "" : " none"),
    "data-color": c || null, title: c ? c[0].toUpperCase() + c.slice(1) : "No colour", "aria-label": c || "No colour",
    on: { click: () => { data.color = c; paint(); } } })));
  paint();
  wrap.append(sw);
  return wrap;
}

function nameField(data, placeholder, onEnter) {
  let gridOpen = false;
  const wrap = el("div");
  const pickBtn = el("button", { className: "picker-btn", title: "Choose icon", type: "button" });
  const input = el("input", { type: "text", placeholder, maxLength: 40, value: data.name || "" });
  const grid = el("div", { className: "icon-grid hidden" });

  const paint = () => {
    pickBtn.innerHTML = svgIcon(data.icon, 18);
    pickBtn.classList.toggle("on", gridOpen);
    grid.innerHTML = "";
    for (const name of ICON_NAMES) {
      grid.append(el("button", {
        type: "button", title: name, className: name === data.icon ? "sel" : "",
        html: svgIcon(name, 18),
        on: { click: () => { data.icon = name; gridOpen = false; grid.classList.add("hidden"); paint(); input.focus(); } }
      }));
    }
  };
  pickBtn.addEventListener("click", () => { gridOpen = !gridOpen; grid.classList.toggle("hidden", !gridOpen); paint(); });
  input.addEventListener("input", () => { data.name = input.value; });
  input.addEventListener("keydown", e => { if (e.key === "Enter") onEnter(); });
  paint();

  wrap.append(el("div", { className: "field" }, [pickBtn, input]), grid);
  setTimeout(() => input.focus(), 0);
  return { node: wrap, input };
}

// ---------- sheets ----------
function openSheet(mode, data = {}) {
  sheetMode = mode;
  sheetData = data;
  renderSheet();
}
function closeSheet() { sheetMode = null; sheetData = {}; renderSheet(); }

function sheetHead(title, text, step) {
  return el("div", {}, [
    el("div", { className: "sheet-head" }, [
      el("div", {}, [
        step ? el("div", { className: "step", textContent: step }) : null,
        el("h2", { textContent: title })
      ]),
      el("button", { className: "iconbtn", title: "Cancel", html: svgIcon("close", 16), on: { click: closeSheet } })
    ]),
    text ? el("p", { textContent: text }) : null
  ]);
}

function busy(btn, label = "Working…") { btn.disabled = true; btn.textContent = label; }

function renderSheet() {
  const s = els.sheet;
  s.innerHTML = "";
  s.classList.toggle("hidden", !sheetMode);
  if (!sheetMode) return;

  const active = state.workflows[state.activeWorkflowId];
  const openTabs = state.currentSession ? countTabs(state.currentSession.windows) : 0;

  if (sheetMode === "save" || sheetMode === "edit") {
    const isEdit = sheetMode === "edit";
    const submit = async () => {
      const name = (sheetData.name || "").trim();
      if (!name) return f.input.focus();
      busy(btn);
      if (isEdit) await send("editWorkflow", { id: sheetData.id, name, icon: sheetData.icon, color: sheetData.color || "" });
      else {
        const res = await send("saveAsWorkflow", { name, icon: sheetData.icon });
        if (res.ok && res.result && sheetData.color) await send("editWorkflow", { id: res.result, color: sheetData.color });
      }
      closeSheet(); load();
    };
    const f = nameField(sheetData, "Workflow name", submit);
    const btn = el("button", { className: "btn primary sm", textContent: isEdit ? "Save changes" : "Save workflow", on: { click: submit } });
    s.append(
      sheetHead(isEdit ? "Edit workflow" : "Save current tabs",
        isEdit ? null : `Saves your ${plural(openTabs, "open tab")} as a new workflow and makes it active.`),
      f.node,
      colorField(sheetData),
      el("div", { className: "sheet-buttons" }, [btn])
    );
    return;
  }

  if (sheetMode === "new2") {
    const create = async () => {
      const name = (sheetData.name || "").trim();
      if (!name) return f.input.focus();
      busy(btn, "Creating…");
      if (sheetData.saveOpenTabs) {
        // Save the open tabs as this workflow; the tabs stay where they are.
        await send("saveAsWorkflow", { name, icon: sheetData.icon });
        closeSheet(); load();
        return;
      }
      sendAndClose("createWorkflow", { name, icon: sheetData.icon, save: sheetData.save });
    };
    const f = nameField(sheetData, "New workflow name", create);
    const btn = el("button", { className: "btn primary sm", html: svgIcon("plus", 14) + "Create workflow", on: { click: create } });
    s.append(
      sheetHead("New workflow", sheetData.text),
      f.node,
      el("div", { className: "sheet-buttons" }, [btn])
    );
  }
}

// ---------- inline confirmations (kept across re-renders) ----------
let pendingConfirm = null;   // { id, kind: "open" | "delete" }

// Manual save (autosave off): the save button turns into "Saved" for a moment. Kept here, not in the
// button, because saving changes storage and the popup redraws right away.
// It fades in and out (popup.css, 2 s); a redraw meanwhile continues the animation where it was.
const SAVED_FLASH_MS = 2000;
let savedFlash = null;       // { id, ok, text, at }
let savedFlashTimer;
async function saveManually(wf) {
  const r = await send("saveIntoWorkflow", { id: wf.id });
  const ok = !!(r.ok && r.result);
  savedFlash = { id: wf.id, ok, at: Date.now(), text: ok ? `Saved ${plural(r.result.tabs, "tab")} to “${r.result.name}”` : "" };
  render();
  clearTimeout(savedFlashTimer);
  savedFlashTimer = setTimeout(() => { savedFlash = null; savedFlashBack = wf.id; render(); savedFlashBack = null; }, SAVED_FLASH_MS);
}
let savedFlashBack = null;   // the save button fades back in after the confirmation
let settings = { ...DEFAULT_SETTINGS };
onSettings(s => { settings = s; });

// Hand the switch to the background and close the popup right away;
// the background finishes the switch on its own.
function sendAndClose(type, payload) {
  chrome.runtime.sendMessage({ type, payload }, () => void chrome.runtime.lastError);
  setTimeout(() => window.close(), 60);
}

function openNow(wf, btn) {
  if (btn) busy(btn, "Opening…");
  sendAndClose("openWorkflow", { id: wf.id });
}

function confirmBox(wf, kind) {
  const cancel = () => { pendingConfirm = null; render(); };
  const box = (cls, text, buttons) => {
    const node = el("div", { className: "confirm" + (cls ? " " + cls : ""), role: "alertdialog" }, [
      el("p", { textContent: text }),
      el("div", { className: "confirm-btns" }, [
        el("button", { className: "btn sm ghost", textContent: "Cancel", on: { click: cancel } }),
        ...buttons
      ])
    ]);
    node.addEventListener("keydown", e => { if (e.key === "Escape") cancel(); });
    setTimeout(() => { const b = node.querySelector(".confirm-btns .btn:last-child"); b && b.focus(); }, 0);
    return node;
  };

  if (kind === "delete") {
    return box("danger", `Delete “${wf.name}”? Its ${plural(countTabs(wf.windows), "saved tab")} will be removed. Your open tabs aren’t affected.`, [
      el("button", { className: "btn sm danger-fill", textContent: "Delete", on: { click: async () => {
        pendingConfirm = null;
        await send("deleteWorkflow", { id: wf.id });
        load();
      } } })
    ]);
  }

  const notice = switchNotice(state, settings, wf);
  const buttons = [];
  if (notice.saveAsNew) {
    buttons.push(el("button", { className: "btn sm", textContent: "Save first", on: { click: () => {
      pendingConfirm = null; render(); openSheet("save", { name: "", icon: "folder" });
    } } }));
  }
  if (notice.saveId) {
    buttons.push(el("button", { className: "btn sm", textContent: "Open anyway", on: { click: e => openNow(wf, e.currentTarget) } }));
    buttons.push(el("button", { className: "btn sm primary", textContent: "Save & open", on: { click: async e => {
      busy(e.currentTarget, "Saving…");
      await send("saveIntoWorkflow", { id: notice.saveId });
      openNow(wf, e.currentTarget);
    } } }));
  } else {
    buttons.push(el("button", { className: "btn sm primary", textContent: notice.risky ? "Open anyway" : `Open “${wf.name}”`,
      on: { click: e => openNow(wf, e.currentTarget) } }));
  }
  return box(notice.risky ? "warn" : "", notice.text, buttons);
}

// ---------- list ----------
function renderTabs(wf) {
  const ul = el("ul", { className: "tabs", "data-wf": wf.id });
  let n = 0;
  const live = openWorkflowIds(state).has(wf.id) && wf.autosave !== false && settings.autosaveEnabled;
  (wf.windows || []).forEach((w, wi) => {
    if (wf.windows.length > 1) ul.append(el("li", { className: "win", textContent: `Window ${wi + 1}` }));
    w.tabs.forEach((t, ti) => {
      n++;
      let fav;
      if (/^https?:/.test(t.url) && chrome.runtime.getURL) {
        fav = el("img", { src: chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(t.url)}&size=32`), alt: "" });
        fav.addEventListener("error", () => fav.replaceWith(el("span", { className: "fav" })));
      } else if (t.favIconUrl && /^(https?:|data:)/.test(t.favIconUrl)) {
        fav = el("img", { src: t.favIconUrl, alt: "" });
        fav.addEventListener("error", () => fav.replaceWith(el("span", { className: "fav" })));
      } else fav = el("span", { className: "fav" });
      const slot = el("span", { className: "slot" }, [
        el("span", { className: "num", textContent: n }),
        el("button", { className: "x", title: live ? "Close this tab" : "Remove from workflow",
          "aria-label": live ? "Close this tab" : "Remove from workflow", html: svgIcon("close", 11),
          on: { click: e => { e.stopPropagation(); send("removeTab", { id: wf.id, win: wi, idx: ti }); } } })
      ]);
      ul.append(el("li", { title: t.url }, [
        slot,
        fav,
        t.pinned ? el("span", { html: svgIcon("pin", 12), style: "display:contents" }) : null,
        el("span", { className: "t", textContent: t.name || t.title || t.url })
      ]));
    });
  });
  return ul;
}

function renderItem(wf) {
  const isActive = wf.id === state.activeWorkflowId;           // the workflow you're in
  const isOpenWin = openWorkflowIds(state).has(wf.id);         // open in some window
  const tabsN = countTabs(wf.windows);
  const autosave = wf.autosave !== false;
  const isOpen = expanded.has(wf.id);

  const right = isActive
    ? el("span", { className: "current", textContent: "Open now" })
    : isOpenWin
    ? el("button", { className: "btn sm", html: "Show" + svgIcon("arrow", 13), title: "Bring this workflow's window to the front",
        on: { click: e => openNow(wf, e.currentTarget) } })
    : el("button", {
        className: "btn sm", html: "Open" + svgIcon("arrow", 13),
        title: settings.switchMode === "windows" ? "Open this workflow in a new window" : "Close current tabs and open this workflow",
        on: { click: (e) => {
          const notice = switchNotice(state, settings, wf);
          if (settings.confirmSwitch || notice.risky) { pendingConfirm = { id: wf.id, kind: "open" }; render(); }
          else openNow(wf, e.currentTarget);
        } }
      });

  const toggle = el("label", { className: "switch", title: autosave
      ? "Autosave on: changes to your tabs are saved to this workflow while it's open"
      : "Autosave off: this workflow only changes when you save it manually" }, [
    el("input", { type: "checkbox", checked: autosave, on: { change: e => send("setAutosave", { id: wf.id, value: e.target.checked }) } }),
    el("span", { className: "track" }),
    el("span", { className: "lbl", textContent: "Autosave" })
  ]);

  const foot = el("div", { className: "item-foot" }, [
    toggle,
    el("span", { className: "spacer" }),
    isOpenWin && !autosave
      ? (savedFlash && savedFlash.id === wf.id
        ? el("span", { className: "saved-flash" + (savedFlash.ok ? "" : " fail"), role: "status",
            style: `animation-delay: -${Math.min(SAVED_FLASH_MS, Date.now() - savedFlash.at)}ms`,
            title: savedFlash.ok ? savedFlash.text : "There were no open tabs to save",
            html: svgIcon(savedFlash.ok ? "check" : "close", 14) + (savedFlash.ok ? "Saved" : "Nothing to save") })
        : el("button", { className: "iconbtn" + (savedFlashBack === wf.id ? " fade-in" : ""), title: "Save open tabs into this workflow now", html: svgIcon("save", 15),
            on: { click: () => saveManually(wf) } }))
      : null,
    el("button", { className: "iconbtn open" + (isOpen ? " expanded" : ""), title: isOpen ? "Hide tabs" : "Show tabs",
      html: svgIcon("chevron", 16), on: { click: () => { isOpen ? expanded.delete(wf.id) : expanded.add(wf.id); render(); } } }),
    el("button", { className: "iconbtn", title: "Rename / change icon", html: svgIcon("edit", 15),
      on: { click: () => openSheet("edit", { id: wf.id, name: wf.name, icon: resolveIcon(wf.icon), color: wf.color || "" }) } }),
    el("button", { className: "iconbtn danger", title: "Delete workflow", html: svgIcon("trash", 15),
      on: { click: () => { pendingConfirm = { id: wf.id, kind: "delete" }; render(); } } })
  ]);

  return el("li", { className: "item" + (isActive ? " active" : "") + (isOpenWin && !isActive ? " open-elsewhere" : ""), "data-color": wf.color || null }, [
    el("div", { className: "item-head" }, [
      el("div", { className: "tile", html: svgIcon(resolveIcon(wf.icon), 18) }),
      el("div", { className: "item-main" }, [
        el("div", { className: "item-name", textContent: wf.name }),
        el("div", { className: "item-meta", textContent:
          plural(tabsN, "tab") +
          (wf.windows && wf.windows.length > 1 ? ` · ${plural(wf.windows.length, "window")}` : "") +
          ` · saved ${timeAgo(wf.savedAt)}` })
      ]),
      right
    ]),
    pendingConfirm && pendingConfirm.id === wf.id ? confirmBox(wf, pendingConfirm.kind) : null,
    foot,
    isOpen ? renderTabs(wf) : null
  ]);
}

function render() {
  const { workflows, currentSession } = state;
  const n = currentSession ? countTabs(currentSession.windows) : 0;
  const cur = workflows[state.activeWorkflowId];
  // Green only when your tabs really are being autosaved: not when autosave is paused everywhere,
  // or turned off for the workflow you're in (then it only changes when you press save).
  els.status.innerHTML = "";
  if (!settings.autosaveEnabled) {
    els.status.append(el("span", { className: "dot off" }), "Autosave paused – turn it on in Settings");
  } else if (cur && cur.autosave === false) {
    els.status.append(el("span", { className: "dot off" }),
      `Autosave off for “${cur.name}” · saved ${timeAgo(cur.savedAt)}`);
  } else {
    els.status.append(el("span", { className: "dot" }),
      currentSession ? `Autosaved · ${plural(n, "tab")} · ${timeAgo(currentSession.savedAt)}` : "Not saved yet");
  }
  els.status.title = els.status.textContent;

  els.saveBtn.title = cur ? `Save your open tabs into “${cur.name}” now` : "Save your open tabs as a new workflow";
  const list = Object.values(workflows).sort((a, b) => a.createdAt - b.createdAt);
  els.count.textContent = list.length || "";
  // The list is rebuilt on every change (a tab loading, autosave…): keep every scroll position –
  // the page, the list and each workflow's open tab list – instead of jumping back to the top.
  const scrollers = [document.scrollingElement, els.list, ...ancestors(els.list)].filter(Boolean);
  const outer = scrollers.map(n => n.scrollTop);
  const inner = {};
  for (const ul of els.list.querySelectorAll("ul.tabs[data-wf]")) if (ul.scrollTop) inner[ul.dataset.wf] = ul.scrollTop;
  els.list.innerHTML = "";
  els.empty.classList.toggle("hidden", list.length > 0);
  for (const wf of list) els.list.append(renderItem(wf));
  for (const ul of els.list.querySelectorAll("ul.tabs[data-wf]")) if (inner[ul.dataset.wf]) ul.scrollTop = inner[ul.dataset.wf];
  scrollers.forEach((n, i) => { if (outer[i]) n.scrollTop = outer[i]; });
}
function ancestors(n) {
  const out = [];
  for (let p = n.parentElement; p && p !== document.body; p = p.parentElement) out.push(p);
  return out;
}

async function load() {
  const data = await chrome.storage.local.get(["workflows", "activeWorkflowId", "currentSession", "openWindows"]);
  state = { workflows: data.workflows || {}, activeWorkflowId: data.activeWorkflowId || null,
            currentSession: data.currentSession || null, openWindows: data.openWindows || {} };
  render();
}

// ---------- static UI ----------
els.logo.innerHTML = svgIcon("layers", 18);
$("topRight").append(
  el("button", { className: "iconbtn", title: "Open Session Manager", html: svgIcon("dashboard", 16),
    on: { click: () => { send("openManager", {}); window.close(); } } }),
  themeToggle()
);
els.newBtn.innerHTML = svgIcon("plus", 16) + "New workflow";
els.saveBtn.innerHTML = svgIcon("save", 15) + "Save current";
els.empty.textContent = "No workflows yet. Save your current tabs or create a new workflow to get started.";
// "New workflow" goes straight to naming it – nothing to answer first.
els.newBtn.addEventListener("click", () => {
  const active = state.workflows[state.activeWorkflowId];
  let save, text;
  if (settings.switchMode === "windows") {
    save = { mode: "none" };
    text = "It opens in a new window with one empty tab. Your current workflow stays open.";
  } else if (active && active.autosave !== false) {
    save = { mode: "active" };
    text = `Your tabs stay saved in “${active.name}”. They close and you start with one empty tab.`;
  } else if (active) {
    save = { mode: "none" };       // autosave off: that workflow stays as you last saved it
    text = `“${active.name}” stays as you last saved it. Your tabs close and you start with one empty tab.`;
  } else {
    // No workflow open: the tabs you have open simply become the new workflow (nothing closes).
    openSheet("new2", { name: "", icon: "folder", saveOpenTabs: true, text: "Your open tabs will be saved in this new Workflow" });
    return;
  }
  openSheet("new2", { name: "", icon: "folder", save, text });
});
// "Save current": save the open tabs into the workflow you're in. Not in a workflow: save them as a new one.
els.saveBtn.addEventListener("click", async () => {
  const active = state.workflows[state.activeWorkflowId];
  if (!active) return openSheet("save", { name: "", icon: "folder" });
  const r = await send("saveCurrent");
  if (!r.ok || !r.result) return openSheet("save", { name: "", icon: "folder" });
  els.saveBtn.innerHTML = svgIcon("check", 15) + "Saved";
  els.saveBtn.title = `Saved ${plural(r.result.tabs, "tab")} to “${r.result.name}”`;
  setTimeout(() => { els.saveBtn.innerHTML = svgIcon("save", 15) + "Save current"; }, 1500);
});
els.dividerBtn.innerHTML = svgIcon("divider", 16);
els.dividerBtn.addEventListener("click", async () => { await send("insertDividerTab"); window.close(); });

chrome.storage.onChanged.addListener((changes, area) => { if (area === "local") load(); });
load();
