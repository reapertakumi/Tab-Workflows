// Tab Workflows – background service worker
//
// Storage layout (chrome.storage.local):
//   currentSession   : { savedAt, windows: [ { tabs: [Tab], activeIndex } ] }   <- always overwritten
//   workflows        : { [id]: { id, name, icon, autosave, createdAt, savedAt, windows } }
//   activeWorkflowId : id | null  <- the workflow you're in (focused one in "new window" mode)
//   openWindows      : { [windowId]: workflowId }  <- which browser window belongs to which workflow
//   looseTabs        : [Tab]  <- "Unsorted tabs" in the manager
//   settings         : see settings.js
//
// Tab = { url, title, pinned, favIconUrl, name? }
//
// Window ownership: a window listed in openWindows belongs to that workflow; any other window
// belongs to the active workflow. Autosave writes each workflow's own windows into it, so in
// "new window" mode several workflows can be open (and autosaving) at the same time.
// An open workflow is "live" when its autosave is on: manager edits then change the real tabs too.

importScripts("settings.js", "sync-core.js", "webdav.js", "bg-extras.js", "context-menu.js");

const EXT_PREFIX = chrome.runtime.getURL("");
const MANAGER_URL = chrome.runtime.getURL("manager.html");
const NEWTAB_RE = /^(chrome|edge):\/\/newtab\/?$/i;
const LOOSE = "__loose";

let switching = false;      // suppress autosave while we close/open tabs during a switch
let switchDepth = 0;        // nested pauses (a switch, a sync applying changes to open tabs, …)
function pauseAutosave() { switchDepth++; switching = true; clearTimeout(saveTimer); }
function resumeAutosave() { switchDepth = Math.max(0, switchDepth - 1); switching = switchDepth > 0; }
let saveTimer = null;
let settings = { ...DEFAULT_SETTINGS };
getSettings().then(s => { settings = s; });
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.settings) settings = { ...DEFAULT_SETTINGS, ...(ch.settings.newValue || {}) };
});

// ---------- serialized task queue (avoid read/modify/write races) ----------
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// ---------- state helpers ----------
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// "Unsorted tabs" act like a one-window workflow with id LOOSE, so tab edits work the same everywhere.
async function loadState() {
  const { workflows = {}, activeWorkflowId = null, looseTabs = [] } =
    await chrome.storage.local.get(["workflows", "activeWorkflowId", "looseTabs"]);
  workflows[LOOSE] = { id: LOOSE, name: "Unsorted tabs", autosave: false, windows: [{ tabs: looseTabs, activeIndex: 0 }] };
  return { workflows, activeWorkflowId };
}

// Write state, splitting the Unsorted container back out of `workflows`.
async function persist(update) {
  if (update.workflows && update.workflows[LOOSE]) {
    const loose = update.workflows[LOOSE];
    update = { ...update, workflows: { ...update.workflows }, looseTabs: (loose.windows || []).flatMap(w => w.tabs) };
    delete update.workflows[LOOSE];
  }
  await chrome.storage.local.set(update);
}

async function getOpenWindows() {
  const { openWindows = {} } = await chrome.storage.local.get("openWindows");
  return openWindows;
}

// Which workflow a window belongs to.
const ownerOf = (windowId, map, activeId) => map[windowId] || activeId || null;

// ---------- reading the browser ----------
// Normal windows (stable order by id) with the tabs we keep: no extension pages, optionally no New Tabs.
async function readWindows() {
  const s = await getSettings();
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  wins.sort((a, b) => a.id - b.id);
  const out = [];
  for (const w of wins) {
    if (w.incognito) continue;
    const tabs = (w.tabs || []).slice().sort((a, b) => a.index - b.index)
      .map(t => ({ ...t, url: t.url || t.pendingUrl || "" }))
      .filter(t => t.url && (!t.url.startsWith(EXT_PREFIX) || isDividerUrl(t.url)) && !(s.skipNewTabs && NEWTAB_RE.test(t.url)));
    if (s.skipDuplicateTabs) {
      const seen = new Set();
      for (let i = tabs.length - 1; i >= 0; i--) {
        const t = tabs[i];
        if (isDividerUrl(t.url) || NEWTAB_RE.test(t.url)) continue;   // dividers and blank tabs are never "duplicates"
        if (t.active || t.pinned) seen.add(t.url);                    // keep the copy you're on / the pinned one
      }
      for (let i = 0; i < tabs.length; i++) {
        const t = tabs[i];
        if (isDividerUrl(t.url) || NEWTAB_RE.test(t.url) || t.active || t.pinned) continue;
        if (seen.has(t.url)) { tabs.splice(i--, 1); continue; }
        seen.add(t.url);
      }
    }
    if (tabs.length) out.push({ windowId: w.id, focused: w.focused, tabs });
  }
  return out;
}

// Titles/icons we already know, by URL – used for lazy-loaded tabs that haven't loaded their page yet.
async function knownTabInfo() {
  const { workflows = {}, currentSession } = await chrome.storage.local.get(["workflows", "currentSession"]);
  const map = new Map();
  const add = wins => (wins || []).forEach(w => w.tabs.forEach(t => {
    if (t.title && t.title !== t.url && !map.has(t.url)) map.set(t.url, t);
  }));
  Object.values(workflows).forEach(wf => add(wf.windows));
  if (currentSession) add(currentSession.windows);
  return map;
}

const looksUnloaded = t => !t.title || t.title === t.url || t.url.endsWith(t.title) || t.title.startsWith("http");

// "Keep pinned tabs open": pinned tabs belong to no workflow, so they're never saved into one.
const keepPins = () => !!settings.keepPinnedTabs;
const withoutPins = list => keepPins() ? list.filter(t => !t.pinned) : list;

function savedWindowFrom(w, known, ginfo = new Map()) {
  const src = withoutPins(w.tabs);
  const a = src.findIndex(t => t.active);
  const groups = {};
  const tabs = src.map(t => {
    const k = looksUnloaded(t) && known.get(t.url);
    const out = {
      url: t.url,
      title: (k ? k.title : t.title) || t.url,
      pinned: !!t.pinned,
      favIconUrl: t.favIconUrl || (k ? k.favIconUrl : "") || ""
    };
    // Chrome tab group: remember which group the tab is in, plus the group's name/colour.
    if (typeof t.groupId === "number" && t.groupId >= 0 && ginfo.has(t.groupId)) {
      const key = "g" + t.groupId;
      groups[key] = ginfo.get(t.groupId);
      out.group = key;
    }
    return out;
  });
  const saved = { activeIndex: a < 0 ? 0 : a, tabs };
  if (Object.keys(groups).length) saved.groups = groups;
  return saved;
}

async function snapshotOf(wins) {
  const known = wins.some(w => w.tabs.some(looksUnloaded)) ? await knownTabInfo() : new Map();
  const ginfo = await groupInfo(wins);
  return { savedAt: Date.now(), windows: wins.map(w => savedWindowFrom(w, known, ginfo)) };
}

// Snapshot of the windows that belong to the active workflow (all of them in "replace" mode).
async function takeSnapshot() {
  const [wins, map, { activeWorkflowId }] = await Promise.all([readWindows(), getOpenWindows(), loadState()]);
  return snapshotOf(wins.filter(w => !map[w.windowId] || map[w.windowId] === activeWorkflowId));
}

// Keep the custom names you gave tabs when a workflow is re-saved from the open tabs.
// Also keeps the manager-only dividers ("labels", stored as `section` on the tab below them).
function carryNames(newWindows, oldWindows) {
  const byUrl = new Map();
  (oldWindows || []).forEach(w => w.tabs.forEach(t => { if (t.name && !byUrl.has(t.url)) byUrl.set(t.url, t.name); }));
  if (byUrl.size) newWindows.forEach((w, wi) => w.tabs.forEach((t, ti) => {
    const same = oldWindows[wi] && oldWindows[wi].tabs[ti];
    const name = same && same.url === t.url && same.name ? same.name : byUrl.get(t.url);
    if (name) t.name = name;
  }));
  carrySections(newWindows, oldWindows);
  return newWindows;
}

// A label sits above a tab. If that tab was closed, the label moves to the next tab that's still there.
function carrySections(newWindows, oldWindows) {
  (oldWindows || []).forEach((w, wi) => {
    const tabs = w.tabs || [];
    const target = newWindows[wi] || newWindows[newWindows.length - 1];
    if (!target) return;
    tabs.forEach((t, ti) => {
      if (!t.section) return;
      for (let j = ti; j < tabs.length; j++) {
        const hit = target.tabs.find(x => x.url === tabs[j].url && !x.section);
        if (hit) { hit.section = { ...t.section }; return; }
      }
    });
  });
}

// `stamp`: mark every saved workflow as just changed, even if its tabs are the same (so it wins the next sync).
async function saveNow({ stamp = false } = {}) {
  if (switching) return;
  const s = await getSettings();
  if (!s.autosaveEnabled) return;
  const wins = await readWindows();
  if (!wins.length) return; // browser closing: don't wipe the save with an empty session
  const { workflows = {}, activeWorkflowId = null } = await chrome.storage.local.get(["workflows", "activeWorkflowId"]);
  const map = await getOpenWindows();

  // In "new window" mode, windows nobody owns yet join the active workflow for good.
  let mapChanged = false;
  if (s.switchMode === "windows" && activeWorkflowId && workflows[activeWorkflowId]) {
    for (const w of wins) if (!map[w.windowId]) { map[w.windowId] = activeWorkflowId; mapChanged = true; }
  }

  const snap = await snapshotOf(wins);
  const update = { currentSession: snap };
  if (mapChanged) update.openWindows = map;

  // Group windows by the workflow that owns them and save each workflow (if its autosave is on).
  const groups = new Map();
  wins.forEach((w, i) => {
    const owner = ownerOf(w.windowId, map, activeWorkflowId);
    if (!owner || !workflows[owner]) return;
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(snap.windows[i]);
  });
  for (const [id, saved] of groups) {
    const wf = workflows[id];
    if (wf.autosave === false) continue;
    const windows = carryNames(JSON.parse(JSON.stringify(saved)), wf.windows).filter(w => w.tabs.length);
    // Only a real change (tabs added/removed/moved, pinned, renamed, regrouped) counts as a newer version
    // for sync - switching tabs or a page title loading doesn't, so edits from other browsers aren't overruled.
    if (stamp || !wf.savedAt || tabShape(windows) !== tabShape(wf.windows)) wf.savedAt = snap.savedAt;
    wf.windows = windows;
    update.workflows = workflows;
  }
  const pins = await pinnedUpdate(wins);
  if (pins) update.pinnedTabs = pins;
  await chrome.storage.local.set(update);
}

// ---------- shared pinned tabs ("Keep pinned tabs open") ----------
// pinnedTabs: { at, tabs: [{ url, title, favIconUrl }] } – the pinned tabs open here (each link once).
// `at` only changes when the set of links changes, so it can be synced: the newest set wins.
let pinsSettled = true;     // false while the browser is still restoring its tabs after a start
const pinKey = tabs => scCanon([...new Set(tabs.map(t => t.url))].sort());

function pinnedOpenNow(wins) {
  const seen = new Set(), out = [];
  for (const w of wins) for (const t of w.tabs) {
    if (!t.pinned || seen.has(t.url)) continue;
    seen.add(t.url);
    out.push({ url: t.url, title: t.title || t.url, favIconUrl: t.favIconUrl || "" });
  }
  return out;
}

async function pinnedUpdate(wins) {
  if (!keepPins() || !pinsSettled) return null;
  const tabs = pinnedOpenNow(wins);
  const { pinnedTabs } = await chrome.storage.local.get("pinnedTabs");
  if (pinnedTabs && pinKey(pinnedTabs.tabs || []) === pinKey(tabs)) {
    // Same links: only refresh titles / icons (no new `at`, so other browsers aren't overruled).
    return scCanon(pinnedTabs.tabs) === scCanon(tabs) ? null : { at: pinnedTabs.at || 0, tabs };
  }
  return { at: Date.now(), tabs };
}

// Open `tabs` pinned at the front of a window, skipping links already pinned there.
async function addPinnedTabs(windowId, tabs) {
  const have = new Set((await chrome.tabs.query({ windowId, pinned: true }).catch(() => [])).map(t => t.url || t.pendingUrl));
  let i = have.size;
  for (const t of tabs) {
    if (have.has(t.url)) continue;
    have.add(t.url);
    await chrome.tabs.create({ windowId, url: t.url, pinned: true, active: false, index: i++ }).catch(() => {});
  }
}

function scheduleSave() {
  if (switching || !settings.autosaveEnabled) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => enqueue(saveNow), settings.autosaveDelay || 400);
}

// ---------- tab & window events ----------
chrome.tabs.onCreated.addListener(scheduleSave);
chrome.tabs.onRemoved.addListener((tabId, info) => {
  if (info.isWindowClosing) return; // keep the last save when a whole window/browser closes
  scheduleSave();
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url || change.title || change.pinned !== undefined || change.favIconUrl || change.groupId !== undefined) scheduleSave();
});
chrome.tabs.onMoved.addListener(scheduleSave);
chrome.tabs.onAttached.addListener(scheduleSave);
chrome.tabs.onDetached.addListener(scheduleSave);
chrome.tabs.onActivated.addListener(scheduleSave);

// A window you open yourself (Ctrl+N, dragging a tab out) belongs to the workflow you're in.
chrome.windows.onCreated.addListener(win => {
  if (win.type !== "normal" || win.incognito) return;
  enqueue(async () => {
    if (switching || settings.switchMode !== "windows") return;
    const map = await getOpenWindows();
    const { activeWorkflowId } = await chrome.storage.local.get("activeWorkflowId");
    if (map[win.id] || !activeWorkflowId) return;
    map[win.id] = activeWorkflowId;
    await chrome.storage.local.set({ openWindows: map });
  });
});

// "Copy into every window": a window you open yourself (Ctrl+N, …) gets the pinned tabs too.
// (Windows a workflow switch opens get them in openInNewWindows.)
chrome.windows.onCreated.addListener(win => {
  if (win.type !== "normal" || win.incognito || switching) return;
  if (!settings.keepPinnedTabs || !["every", "sync"].includes(settings.pinnedScope)) return;
  setTimeout(() => enqueue(async () => {
    if (switching) return;
    const others = (await readWindows()).filter(w => w.windowId !== win.id);
    const pins = pinnedOpenNow(others);
    if (pins.length) await addPinnedTabs(win.id, pins);
  }), 300);
});

// Closing a window keeps its workflow as last saved; the workflow just isn't open any more.
chrome.windows.onRemoved.addListener(windowId => {
  enqueue(async () => {
    const map = await getOpenWindows();
    if (!map[windowId]) return;
    const owner = map[windowId];
    delete map[windowId];
    const update = { openWindows: map };
    const { activeWorkflowId } = await chrome.storage.local.get("activeWorkflowId");
    if (activeWorkflowId === owner && !Object.values(map).includes(owner) && settings.switchMode === "windows") {
      update.activeWorkflowId = null;
    }
    await chrome.storage.local.set(update);
  });
});

// In "new window" mode the active workflow follows the focused window.
chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId === chrome.windows.WINDOW_ID_NONE || settings.switchMode !== "windows") return;
  enqueue(async () => {
    const map = await getOpenWindows();
    const owner = map[windowId];
    if (!owner) return;
    const { activeWorkflowId } = await chrome.storage.local.get("activeWorkflowId");
    if (owner !== activeWorkflowId) await chrome.storage.local.set({ activeWorkflowId: owner });
  });
});

// After a browser restart window ids change: re-match restored windows to workflows by their tabs.
async function reconcileWindows() {
  const s = await getSettings();
  if (s.switchMode !== "windows") { await chrome.storage.local.set({ openWindows: {} }); return; }
  const { workflows } = await loadState();
  const wins = await readWindows();
  const map = {};
  for (const w of wins) {
    const urls = new Set(w.tabs.map(t => t.url));
    let best = null, score = 0;
    for (const wf of Object.values(workflows)) {
      if (wf.id === LOOSE) continue;
      for (const sw of wf.windows || []) {
        const hit = sw.tabs.filter(t => urls.has(t.url)).length;
        const sc = hit / Math.max(sw.tabs.length, urls.size, 1);
        if (sc > score) { score = sc; best = wf.id; }
      }
    }
    if (best && score >= 0.5) map[w.windowId] = best;
  }
  await chrome.storage.local.set({ openWindows: map });
}

chrome.runtime.onInstalled.addListener(details => enqueue(async () => {
  ensureAlarms();
  // First install: show the welcome sheet in the Session Manager.
  if (details && details.reason === "install") {
    await chrome.storage.local.set({ showWelcome: true });
    openManager({}).catch(() => {});
  }
  await reconcileWindows();
  // Brand-new install: the tabs you have open become your first workflow, "Current".
  if (details && details.reason === "install") {
    const { workflows = {} } = await chrome.storage.local.get("workflows");
    if (!Object.keys(workflows).length) await saveAsWorkflow({ name: "Current", icon: "folder" });
  }
  await saveNow();
}));
chrome.runtime.onStartup.addListener(() => { pinsSettled = false; });
chrome.runtime.onStartup.addListener(() => enqueue(async () => {
  ensureAlarms();
  await waitForRestoredTabs();
  pinsSettled = true;
  await reconcileWindows();
  const s = await getSettings();
  if (AUTO_SYNC_METHODS.includes(s.syncMethod) && s.syncApplyOnStartup) {
    // Pick up what other browsers changed while this one was closed and apply it to the open tabs.
    await multiSyncNow();
    await saveNow();
  } else {
    // The tabs you start with are the newest version of their workflow.
    await saveNow({ stamp: AUTO_SYNC_METHODS.includes(s.syncMethod) });
  }
  await autoBackup();
}));

// The browser restores its tabs a moment after start: wait until the tab count stops changing (max ~10 s).
async function waitForRestoredTabs() {
  const count = async () => (await chrome.tabs.query({})).length;
  let last = await count(), steady = 0;
  for (let i = 0; i < 20 && steady < 3; i++) {
    await new Promise(r => setTimeout(r, 500));
    const n = await count();
    if (n === last && n > 0) steady++; else { steady = 0; last = n; }
  }
}

// ---------- live workflows ----------
// The real windows of a workflow whose edits should also change real tabs, or null.
async function liveLayoutFor(id) {
  if (!id || id === LOOSE) return null;
  const s = await getSettings();
  if (!s.autosaveEnabled) return null;
  const { workflows, activeWorkflowId } = await loadState();
  const wf = workflows[id];
  if (!wf || wf.autosave === false) return null;
  const map = await getOpenWindows();
  let mine = (await readWindows()).filter(w => ownerOf(w.windowId, map, activeWorkflowId) === id);
  if (keepPins() && mine.length) {
    // Positions in a workflow don't count pinned tabs (they aren't saved in it); a window with only
    // pinned tabs is where the workflow's first tabs go.
    const stripped = mine.map(w => ({ ...w, tabs: w.tabs.filter(t => !t.pinned) }));
    mine = stripped.some(w => w.tabs.length) ? stripped.filter(w => w.tabs.length) : [stripped[0]];
  }
  if (mine.length) return mine;
  return id === activeWorkflowId && s.switchMode !== "windows" ? [] : null;
}

async function mapWindow(windowId, id) {
  if (settings.switchMode !== "windows" || !windowId) return;
  const map = await getOpenWindows();
  map[windowId] = id;
  await chrome.storage.local.set({ openWindows: map });
}

function normalizeUrl(url) {
  url = String(url || "").trim();
  if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
  return url;
}

function cleanTab(t) {
  const out = { url: String(t.url || ""), title: String(t.title || t.url || ""), pinned: !!t.pinned, favIconUrl: String(t.favIconUrl || "") };
  if (t.name) out.name = String(t.name);
  if (t.group) out.group = String(t.group);
  if (t.section) out.section = { text: String(t.section.text || ""), color: String(t.section.color || "grey") };
  return out;
}

function fixActive(w) {
  if (!w) return;
  w.activeIndex = Math.max(0, Math.min(w.activeIndex || 0, w.tabs.length - 1));
}

const SAFE_URL = /^(https?:|file:|ftp:|chrome:\/\/newtab|edge:\/\/newtab|about:blank)/i;
const EMPTY_WINDOWS = () => [{ tabs: [{ url: "chrome://newtab/", pinned: false }], activeIndex: 0 }];

// ---------- lazy loading ----------
// Background tabs load normally and are only unloaded (to save memory) once their page has
// completely finished loading. A tab is never unloaded half-way through loading – doing that
// mid-navigation/redirect is what left some pages stuck on the spinner or blank.
const isBlank = url => !url || /^about:blank/i.test(url);

function whenLoaded(tabId, timeout = 20000) {
  return new Promise(resolve => {
    let timer;
    const done = r => {
      chrome.tabs.onUpdated.removeListener(onUpd);
      chrome.tabs.onRemoved.removeListener(onGone);
      clearTimeout(timer);
      resolve(r);
    };
    const onUpd = (id, ch, tab) => { if (id === tabId && tab.status === "complete" && !isBlank(tab.url)) done("complete"); };
    const onGone = id => { if (id === tabId) done("gone"); };
    timer = setTimeout(() => done("timeout"), timeout);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.onRemoved.addListener(onGone);
    chrome.tabs.get(tabId).then(t => { if (t.status === "complete" && !isBlank(t.url)) done("complete"); }, () => done("gone"));
  });
}

// Chrome can give a tab a new id when it's put to sleep (discarded). Remember the swaps, so tabs
// we're about to close are still found.
const replacedTabs = new Map();      // old id -> new id
chrome.tabs.onReplaced.addListener((added, removed) => {
  replacedTabs.set(removed, added);
  if (replacedTabs.size > 2000) replacedTabs.delete(replacedTabs.keys().next().value);
});
function currentTabId(id) {
  for (let i = 0; i < 20 && replacedTabs.has(id); i++) id = replacedTabs.get(id);
  return id;
}

function lazyLoad(tabs, savedTabs, activeTab) {
  tabs.forEach((t, i) => {
    if (!t || t.id === (activeTab && activeTab.id)) return;
    const url = savedTabs[i] && savedTabs[i].url;
    if (!/^https?:/i.test(url || "")) return;
    whenLoaded(t.id).then(async r => {
      if (r !== "complete") return;                       // still busy after 20 s: leave it as it is
      // Never put a tab to sleep in the middle of a switch (its id could change while it's being
      // closed, and it would stay open): wait until the switch is over.
      for (let n = 0; switching && n < 120; n++) await new Promise(res => setTimeout(res, 500));
      const id = currentTabId(t.id);
      const cur = await chrome.tabs.get(id).catch(() => null);
      if (cur && !cur.active && !cur.discarded && cur.status === "complete") chrome.tabs.discard(id).catch(() => {});
    });
  });
}

// ---------- stuck-tab watchdog ----------
// Tabs opened by a workflow switch are remembered (for this browser session). When you click one
// and it is still stuck loading 15 seconds later, it's reloaded once.
const WATCH_KEY = "watchTabs";
const sessionStore = chrome.storage.session || chrome.storage.local;

async function watchTabs(ids) {
  if (!ids.length) return;
  const { [WATCH_KEY]: w = {} } = await sessionStore.get(WATCH_KEY);
  ids.forEach(id => { w[id] = Date.now(); });
  // forget very old entries
  for (const [id, at] of Object.entries(w)) if (Date.now() - at > 6 * 3600e3) delete w[id];
  await sessionStore.set({ [WATCH_KEY]: w });
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const { [WATCH_KEY]: w = {} } = await sessionStore.get(WATCH_KEY);
  if (!w[tabId]) return;
  delete w[tabId];
  await sessionStore.set({ [WATCH_KEY]: w });
  setTimeout(async () => {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (t && t.active && (t.status === "loading" || t.discarded)) chrome.tabs.reload(tabId).catch(() => {});
  }, 15000);
});

// ---------- opening tabs ----------
// Open a whole saved window in ONE call: Chrome creates every tab at once, already in order.
async function openSavedWindow(sw, opts, lazy = false) {
  const urls = sw.tabs.map(t => t.url);
  let win;
  try {
    win = await chrome.windows.create({ url: urls, ...opts });
  } catch (e) {
    // A URL was refused (e.g. some chrome:// pages) – swap those for a new tab so positions still line up.
    win = await chrome.windows.create({ url: urls.map(u => (SAFE_URL.test(u) || isDividerUrl(u) ? u : "chrome://newtab/")), ...opts });
  }
  const tabs = (win.tabs || []).slice().sort((a, b) => a.index - b.index);
  watchTabs(tabs.map(t => t.id));
  // Pinned tabs are always at the front of a saved window, so pinning them in order keeps the order.
  for (let i = 0; i < sw.tabs.length; i++) {
    if (sw.tabs[i].pinned && tabs[i]) await chrome.tabs.update(tabs[i].id, { pinned: true }).catch(() => {});
  }
  const active = tabs[sw.activeIndex] || tabs[0];
  if (active) await chrome.tabs.update(active.id, { active: true }).catch(() => {});
  await applyGroups(tabs, sw, active);
  if (lazy) lazyLoad(tabs, sw.tabs, active);
  return win;
}

// Close tabs when switching away. Their Chrome tab groups are deleted (so no copies pile up in Chrome's
// saved tab groups – the workflow rebuilds them when it opens again), but a copy of every group is kept
// first: History → "Deleted tab groups" can reopen it.
const GROUP_COPIES_MAX = 100;

async function saveGroupCopies(tabs) {
  if (!HAS_GROUPS) return;
  const byGroup = new Map();
  tabs.forEach(t => {
    if (typeof t.groupId !== "number" || t.groupId < 0) return;
    if (!byGroup.has(t.groupId)) byGroup.set(t.groupId, []);
    byGroup.get(t.groupId).push(t);
  });
  if (!byGroup.size) return;
  const { workflows, activeWorkflowId } = await loadState();
  const wf = workflows[activeWorkflowId];
  const { groupCopies = [] } = await chrome.storage.local.get("groupCopies");
  for (const [gid, list] of byGroup) {
    const g = await chrome.tabGroups.get(gid).catch(() => null);
    if (!g) continue;
    const copy = {
      id: newId(), at: Date.now(),
      title: g.title || "", color: g.color || "grey",
      workflowId: wf ? wf.id : null, workflowName: wf ? wf.name : "",
      tabs: list.sort((x, y) => x.index - y.index)
        .map(t => ({ url: t.url || t.pendingUrl || "", title: t.title || t.url || "", favIconUrl: t.favIconUrl || "" }))
        .filter(t => t.url)
    };
    // One copy per group (same workflow + name + colour): the newest one replaces the older one.
    const same = c => c.workflowId === copy.workflowId && c.title === copy.title && c.color === copy.color;
    const kept = groupCopies.filter(c => !same(c));
    kept.unshift(copy);
    groupCopies.length = 0;
    groupCopies.push(...kept);
  }
  await chrome.storage.local.set({ groupCopies: groupCopies.slice(0, GROUP_COPIES_MAX) });
}

async function closeTabsArchivingGroups(tabs) {
  const fresh = [];
  for (const t of tabs) { const f = await chrome.tabs.get(currentTabId(t.id)).catch(() => null); if (f) fresh.push(f); }
  await saveGroupCopies(fresh).catch(e => console.warn("Tab Workflows: couldn't save group copies", e));
  // Closing a group's tabs only *closes* the group (Chrome keeps it in its saved tab groups);
  // ungrouping them first is what deletes it. Then the tabs close.
  const grouped = HAS_GROUPS ? fresh.filter(t => typeof t.groupId === "number" && t.groupId >= 0).map(t => t.id) : [];
  if (grouped.length) await chrome.tabs.ungroup(grouped).catch(() => {});
  if (!fresh.length) return;
  // One call for all of them; if that fails (a tab changed or went away meanwhile), close them one by one.
  await chrome.tabs.remove(fresh.map(t => currentTabId(t.id))).catch(() =>
    Promise.all(fresh.map(t => chrome.tabs.remove(currentTabId(t.id)).catch(() => {}))));
}

// Reopen a saved group copy as a tab group at the end of your current window.
async function openGroupCopy({ id }) {
  const { groupCopies = [] } = await chrome.storage.local.get("groupCopies");
  const c = groupCopies.find(x => x.id === id);
  if (!c || !c.tabs.length) throw new Error("Group copy not found");
  const wins = (await chrome.windows.getAll({ windowTypes: ["normal"] })).filter(w => !w.incognito);
  const win = wins.find(w => w.focused) || wins[0];
  const sw = { activeIndex: 0, groups: { g: { title: c.title, color: c.color, collapsed: false } },
               tabs: c.tabs.map(t => ({ ...t, pinned: false, group: "g" })) };
  if (win) await appendSavedWindow(win.id, sw, false);
  else await openSavedWindow(sw, { focused: true });
  return c.title || "group";
}

async function deleteGroupCopy({ id }) {
  const { groupCopies = [] } = await chrome.storage.local.get("groupCopies");
  await chrome.storage.local.set({ groupCopies: id ? groupCopies.filter(c => c.id !== id) : [] });
}

// Fill an existing window with a saved window's tabs, in order, then close the window's old tabs.
// All tabs are created at once (in parallel), put in order with ONE move call, then old tabs go in ONE remove call.
async function fillWindow(win, sw, keepManager, lazy = false) {
  const oldTabs = (win.tabs || []).filter(t => !(keepManager && (t.url || t.pendingUrl || "").startsWith(MANAGER_URL))
    && !(keepPins() && t.pinned));
  const managerTabs = (win.tabs || []).filter(t => !oldTabs.includes(t));
  // (The old workflow was already saved when the switch started.)
  // 1) The new workflow opens: its tabs are created in order and the right one is shown straight away…
  const created = await appendSavedWindow(win.id, sw, lazy, { groupsLater: true });
  if (!created.length) return;
  // 2) …the old workflow's tabs close (a copy of each of their groups is kept, the groups are deleted)…
  if (oldTabs.length) await closeTabsArchivingGroups(oldTabs);
  // With many tabs some old ones could survive (one was put to sleep and got a new id, one failed to
  // close…) and would then be saved into the new workflow. Check the window and close what's left over.
  const keep = new Set(managerTabs.map(t => t.id));
  for (let pass = 0; pass < 3; pass++) {
    const mine = new Set(created.filter(Boolean).map(t => currentTabId(t.id)));
    const now = await chrome.tabs.query({ windowId: win.id }).catch(() => []);
    const left = now.filter(t => !mine.has(t.id) && !keep.has(t.id) && ![...keep].some(k => currentTabId(k) === t.id)
      && !(keepManager && (t.url || t.pendingUrl || "").startsWith(MANAGER_URL)) && !(keepPins() && t.pinned));
    if (!left.length) break;
    console.warn(`Tab Workflows: ${left.length} old tab(s) were still open after switching – closing them`);
    await closeTabsArchivingGroups(left);
    await new Promise(r => setTimeout(r, 250));
  }
  for (const m of managerTabs) await chrome.tabs.move(currentTabId(m.id), { index: -1 }).catch(() => {});
  // 3) …and then the new workflow's tab groups are created.
  await applyGroups(created, sw, created.active);
}

async function clearHistory() {
  await chrome.storage.local.set({ history: [] });
}

// "Replace" mode: swap everything that's open for `savedWindows`, in exactly the saved order.
// The current window is reused; extra saved windows get their own window, other old windows are closed.
async function replaceAllTabs(savedWindows) {
  savedWindows = (savedWindows || []).filter(w => w.tabs && w.tabs.length);
  if (!savedWindows.length) savedWindows = EMPTY_WINDOWS();
  const s = await getSettings();
  const existing = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const oldWindows = existing.filter(w => !w.incognito);
  let mainWin = oldWindows.find(w => w.focused) || oldWindows[0];
  const others = oldWindows.filter(w => w !== mainWin);
  const managerElsewhere = others.some(w => (w.tabs || []).some(t => (t.url || "").startsWith(MANAGER_URL)));

  if (mainWin) {
    await fillWindow(mainWin, savedWindows[0], s.keepManagerOpen, s.lazyLoad);
  } else {
    mainWin = await openSavedWindow(savedWindows[0], { focused: true }, s.lazyLoad);
  }

  // Extra saved windows (one call each, tabs already in order).
  for (let i = 1; i < savedWindows.length; i++) {
    await openSavedWindow(savedWindows[i], { focused: false }, s.lazyLoad).catch(() => {});
  }

  if (managerElsewhere && s.keepManagerOpen) {
    await chrome.tabs.create({ windowId: mainWin.id, url: MANAGER_URL, active: false }).catch(() => {});
  }
  // Kept pinned tabs from windows that are about to close move into the main window (once per link).
  if (keepPins()) {
    const have = new Set((await chrome.tabs.query({ windowId: mainWin.id, pinned: true }).catch(() => [])).map(t => t.url || t.pendingUrl));
    for (const w of others) for (const t of (w.tabs || []).filter(x => x.pinned).sort((a, b) => a.index - b.index)) {
      const url = t.url || t.pendingUrl;
      if (have.has(url)) continue;
      have.add(url);
      await chrome.tabs.move(t.id, { windowId: mainWin.id, index: -1 }).catch(() => {});
      await chrome.tabs.update(t.id, { pinned: true }).catch(() => {});
    }
  }
  // Other windows close too – their groups are saved as copies and deleted the same way first.
  for (const w of others) {
    const grouped = (w.tabs || []).filter(t => typeof t.groupId === "number" && t.groupId >= 0);
    if (grouped.length) await closeTabsArchivingGroups(grouped);
  }
  await Promise.all(others.map(w => chrome.windows.remove(w.id).catch(() => {})));
  await chrome.storage.local.set({ openWindows: {} }); // everything left belongs to the new active workflow
  await chrome.windows.update(mainWin.id, { focused: true }).catch(() => {});
}

// "New window" mode: open `savedWindows` in new windows owned by workflow `id`; nothing is closed.
async function openInNewWindows(id, savedWindows) {
  savedWindows = (savedWindows || []).filter(w => w.tabs && w.tabs.length);
  if (!savedWindows.length) savedWindows = EMPTY_WINDOWS();
  const s = await getSettings();
  const map = await getOpenWindows();
  // "Copy into every workflow" / "every window": each workflow window that opens also gets the pinned tabs open now.
  const copyPins = s.keepPinnedTabs && ["workflow", "every", "sync"].includes(s.pinnedScope)
    ? pinnedOpenNow(await readWindows()) : [];
  for (let i = 0; i < savedWindows.length; i++) {
    const win = await openSavedWindow(savedWindows[i], { focused: i === 0 }, s.lazyLoad).catch(() => null);
    if (win) map[win.id] = id;
    if (win && copyPins.length) await addPinnedTabs(win.id, copyPins);
  }
  await chrome.storage.local.set({ openWindows: map });
}

// Before opening another window, tie every unowned window to the workflow you're in now,
// so it keeps autosaving into that workflow instead of following focus.
async function claimUnownedWindows(activeId) {
  if (!activeId) return;
  const map = await getOpenWindows();
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  let changed = false;
  for (const w of wins) if (!w.incognito && !map[w.id]) { map[w.id] = activeId; changed = true; }
  if (changed) await chrome.storage.local.set({ openWindows: map });
}

// Windows (by id) currently showing workflow `id`, if any.
async function windowsOf(id) {
  const map = await getOpenWindows();
  const { activeWorkflowId } = await chrome.storage.local.get("activeWorkflowId");
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  return wins.filter(w => !w.incognito && ownerOf(w.id, map, activeWorkflowId) === id).map(w => w.id);
}

// Autosave is paused for the whole switch: from the first tab closing until every new tab has its
// address. Only then is the new state saved once – so a half-switched set of tabs is never saved
// (and never synced) into either workflow.
async function withSwitching(fn) {
  pauseAutosave();
  await chrome.storage.session?.set({ switchingWorkflow: Date.now() }).catch(() => {});
  try { return await fn(); }
  finally {
    await waitForTabsToSettle().catch(() => {});
    resumeAutosave();
    await chrome.storage.session?.remove("switchingWorkflow").catch(() => {});
    if (!switching) await saveNow().catch(() => {});
  }
}

// Every tab has a real address (not blank / still being created) – at least 0.8 s, at most 6 s.
async function waitForTabsToSettle() {
  const start = Date.now();
  await new Promise(r => setTimeout(r, 800));
  while (Date.now() - start < 6000) {
    const tabs = await chrome.tabs.query({ windowType: "normal" });
    if (tabs.every(t => (t.url || t.pendingUrl) && !(t.status === "loading" && isBlank(t.url) && !t.pendingUrl))) return;
    await new Promise(r => setTimeout(r, 250));
  }
}

// Close real tabs without ever closing the browser's last window.
async function closeLiveTabs(ids, layout) {
  if (!ids.length) return;
  const all = await chrome.tabs.query({ windowType: "normal" });
  if (ids.length >= all.length && layout[0]) {
    await chrome.tabs.create({ windowId: layout[0].windowId, active: true }).catch(() => {});
  }
  await chrome.tabs.remove(ids).catch(() => {});
}

// ---------- workflow operations ----------
async function saveAsWorkflow({ name, icon }) {
  const snap = await takeSnapshot();
  const { workflows, activeWorkflowId } = await loadState();
  const id = newId();
  workflows[id] = {
    id, name: name || "Untitled", icon: icon || "folder", autosave: settings.newWorkflowAutosave !== false,
    createdAt: Date.now(), savedAt: snap.savedAt, windows: snap.windows.filter(w => w.tabs.length)
  };
  // The windows that were saved now belong to the new workflow.
  const map = await getOpenWindows();
  for (const k of Object.keys(map)) if (map[k] === activeWorkflowId) map[k] = id;
  await persist({ workflows, activeWorkflowId: id, currentSession: snap, openWindows: map });
  return id;
}

// Empty workflow, created from the manager without touching open tabs.
async function createEmptyWorkflow({ name, icon }) {
  const { workflows } = await loadState();
  const id = newId();
  workflows[id] = {
    id, name: name || "Untitled", icon: icon || "folder", autosave: settings.newWorkflowAutosave !== false,
    createdAt: Date.now(), savedAt: Date.now(), windows: []
  };
  await persist({ workflows });
  return id;
}

// Manually write a workflow's open tabs into it (works even when its autosave is off).
async function saveIntoWorkflow({ id }) {
  const [wins, map, { workflows, activeWorkflowId }] = await Promise.all([readWindows(), getOpenWindows(), loadState()]);
  if (!workflows[id]) return;
  const mine = wins.filter(w => ownerOf(w.windowId, map, activeWorkflowId) === id);
  if (!mine.length) return false;
  const snap = await snapshotOf(mine);
  workflows[id].windows = carryNames(JSON.parse(JSON.stringify(snap.windows)), workflows[id].windows).filter(w => w.tabs.length);
  workflows[id].savedAt = snap.savedAt;
  await persist({ workflows });
  return { name: workflows[id].name, tabs: snap.windows.reduce((n, w) => n + w.tabs.length, 0) };
}

// "Save current" in the popup: save the open tabs into the workflow you're in.
async function saveCurrent() {
  const { workflows, activeWorkflowId } = await loadState();
  if (!activeWorkflowId || !workflows[activeWorkflowId]) return false;
  return saveIntoWorkflow({ id: activeWorkflowId });
}

async function editWorkflow({ id, name, icon, note, color, tags }) {
  const { workflows } = await loadState();
  const wf = workflows[id];
  if (!wf) return;
  if (name) wf.name = name;
  if (icon) wf.icon = icon;
  if (note !== undefined) { note = String(note || "").trim(); if (note) wf.note = note; else delete wf.note; }
  if (color !== undefined) { if (color) wf.color = String(color); else delete wf.color; }
  if (tags !== undefined) {
    const list = [...new Set((tags || []).map(t => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 12);
    if (list.length) wf.tags = list; else delete wf.tags;
  }
  wf.savedAt = Date.now();     // newer version -> other browsers pick up the new name / icon
  await persist({ workflows });
}

async function setAutosave({ id, value }) {
  const { workflows } = await loadState();
  if (!workflows[id]) return;
  workflows[id].autosave = !!value;
  workflows[id].savedAt = Date.now();
  await persist({ workflows });
  if (value) await saveNow(); // catch up immediately
}

async function deleteWorkflow({ id }) {
  const { workflows, activeWorkflowId } = await loadState();
  if (workflows[id] && id !== LOOSE) await addToTrash({ kind: "workflow", workflow: workflows[id] });
  delete workflows[id];
  if (id !== LOOSE) {
    const { tombstones = {} } = await chrome.storage.local.get("tombstones");
    tombstones[id] = Date.now();
    await chrome.storage.local.set({ tombstones });
  }
  const map = await getOpenWindows();
  for (const k of Object.keys(map)) if (map[k] === id) delete map[k];
  const update = { workflows, openWindows: map };
  if (activeWorkflowId === id) update.activeWorkflowId = null;
  await persist(update);
}

// pinned: what to do with pinned tabs still saved in the workflow (from before "Keep pinned tabs open"):
// "pin" – open them pinned (they then belong to no workflow), "unpin" – they become normal tabs of the
// workflow, "remove" – take them out of the workflow. Left out: Settings → "Workflows with pinned tabs".
async function openWorkflow({ id, pinned }) {
  const { workflows, activeWorkflowId } = await loadState();
  let target = workflows[id];
  if (!target || id === LOOSE) throw new Error("Workflow not found");
  const s = await getSettings();
  let extraPins = [];
  if (s.keepPinnedTabs && pinnedTabsIn(target).length) {
    const how = ["pin", "unpin", "remove"].includes(pinned) ? pinned : (s.pinnedOnOpen !== "ask" ? s.pinnedOnOpen : "pin");
    if (how === "pin") extraPins = pinnedTabsIn(target).map(t => ({ url: t.url, title: t.title, favIconUrl: t.favIconUrl }));
    target = { ...target, savedAt: Date.now(), windows: (target.windows || []).map(w => {
      if (how === "unpin") return { ...w, tabs: w.tabs.map(t => ({ ...t, pinned: false })) };
      const active = w.tabs[w.activeIndex || 0];
      const tabs = w.tabs.filter(t => !t.pinned);
      return { ...w, tabs, activeIndex: Math.max(0, tabs.indexOf(active)) };
    }).filter(w => w.tabs.length) };
    workflows[id] = target;
    await persist({ workflows });
  }

  if (s.switchMode === "windows") {
    // Already open somewhere? Just bring that window to the front.
    const open = await windowsOf(id);
    if (open.length) {
      await chrome.windows.update(open[0], { focused: true }).catch(() => {});
      await chrome.storage.local.set({ activeWorkflowId: id });
      return;
    }
    clearTimeout(saveTimer);
    await saveNow();
    await claimUnownedWindows(activeWorkflowId);
    await withSwitching(async () => {
      await openInNewWindows(id, target.windows);
      if (extraPins.length) { const [wid] = await windowsOf(id); if (wid) await addPinnedTabs(wid, extraPins); }
      await chrome.storage.local.set({ activeWorkflowId: id });
    });
    return;
  }

  clearTimeout(saveTimer);
  await saveNow(); // save what is open right now (each workflow only if its autosave is on)
  await withSwitching(async () => {
    await replaceAllTabs(target.windows);
    if (extraPins.length) {
      const wins = (await chrome.windows.getAll({ windowTypes: ["normal"] })).filter(w => !w.incognito);
      const main = wins.find(w => w.focused) || wins[0];
      if (main) await addPinnedTabs(main.id, extraPins);
    }
    await chrome.storage.local.set({ activeWorkflowId: id });
  });
}

// save: { mode: "active" | "new" | "none", name, icon }
async function createWorkflow({ name, icon, save = { mode: "none" } }) {
  clearTimeout(saveTimer);
  const s = await getSettings();
  const { activeWorkflowId } = await loadState();
  const windowsMode = s.switchMode === "windows";

  if (!windowsMode) {
    if (save.mode === "active" && activeWorkflowId) await saveIntoWorkflow({ id: activeWorkflowId });
    else if (save.mode === "new") await saveAsWorkflow({ name: save.name, icon: save.icon });
    else {
      const snap = await takeSnapshot();
      if (snap.windows.length) await chrome.storage.local.set({ currentSession: snap });
    }
  } else {
    await saveNow();
    await claimUnownedWindows(activeWorkflowId);
  }

  const id = newId();
  await withSwitching(async () => {
    if (windowsMode) await openInNewWindows(id, null); // a new window with one empty tab
    else await replaceAllTabs(null);                    // closes everything, leaves one empty tab
    const { workflows } = await loadState();
    workflows[id] = {
      id, name: name || "Untitled", icon: icon || "folder", autosave: settings.newWorkflowAutosave !== false,
      createdAt: Date.now(), savedAt: Date.now(),
      windows: [{ tabs: [{ url: "chrome://newtab/", title: "New Tab", pinned: false, favIconUrl: "" }], activeIndex: 0 }]
    };
    await persist({ workflows, activeWorkflowId: id });
  });
  return id;
}

// ---------- tab-level edits (manager page) ----------
// from/to = { id: workflowId, win: windowIndex, idx: tabIndex }. to.idx is the position AFTER removal.
async function moveTab({ from, to, copy = false }) {
  const { workflows } = await loadState();
  const src = workflows[from.id], dst = workflows[to.id];
  const sw = src && src.windows && src.windows[from.win];
  const tab = sw && sw.tabs[from.idx];
  if (!tab || !dst) return;

  const srcLayout = await liveLayoutFor(from.id);
  const dstLayout = from.id === to.id ? srcLayout : await liveLayoutFor(to.id);
  const liveTab = srcLayout && srcLayout[from.win] ? srcLayout[from.win].tabs[from.idx] : null;

  // --- storage ---
  if (!copy) {
    sw.tabs.splice(from.idx, 1);
    if (from.idx < (sw.activeIndex || 0)) sw.activeIndex--;
  }
  dst.windows = dst.windows || [];
  const toWin = Math.min(to.win, dst.windows.length);
  if (!dst.windows[toWin]) dst.windows[toWin] = { tabs: [], activeIndex: 0 };
  const tw = dst.windows[toWin];
  const pinnedCount = tw.tabs.filter(t => t.pinned).length;
  let idx = Math.max(0, Math.min(to.idx, tw.tabs.length));
  idx = tab.pinned ? Math.min(idx, pinnedCount) : Math.max(idx, pinnedCount);
  const placed = cleanTab(tab);
  if (copy || sw !== tw) delete placed.group;      // leaving its window = leaving its tab group
  tw.tabs.splice(idx, 0, placed);
  if (sw !== tw || copy) { if (idx <= (tw.activeIndex || 0) && tw.tabs.length > 1) tw.activeIndex = (tw.activeIndex || 0) + 1; }
  for (const w of [src, dst]) { w.windows = w.windows.filter(x => x.tabs.length); w.windows.forEach(fixActive); w.savedAt = Date.now(); }
  await persist({ workflows });

  // --- real tabs (only for live workflows) ---
  const lw = dstLayout ? dstLayout[toWin] : null;

  if (liveTab && !copy && dstLayout) {
    // Move the real tab – possibly into another workflow's window.
    if (!lw) {
      const win = await chrome.windows.create({ tabId: liveTab.id, focused: false }).catch(() => null);
      if (win) await mapWindow(win.id, to.id);
      return;
    }
    const list = lw.tabs.filter(t => t.id !== liveTab.id);
    const before = list[idx];
    let index = -1;
    if (before) index = before.index - (liveTab.windowId === lw.windowId && liveTab.index < before.index ? 1 : 0);
    await chrome.tabs.move(liveTab.id, { windowId: lw.windowId, index }).catch(() => {});
    if (tab.pinned !== liveTab.pinned) await chrome.tabs.update(liveTab.id, { pinned: tab.pinned }).catch(() => {});
    return;
  }
  if (dstLayout) {
    if (lw) {
      const before = lw.tabs[idx];
      const props = { windowId: lw.windowId, url: tab.url, pinned: !!tab.pinned, active: false };
      if (before) props.index = before.index;
      await chrome.tabs.create(props).catch(() => chrome.tabs.create({ windowId: lw.windowId, active: false }));
    } else {
      const win = await chrome.windows.create({ url: tab.url, focused: false }).catch(() => null);
      if (win) await mapWindow(win.id, to.id);
    }
  }
  if (liveTab && !copy) await closeLiveTabs([liveTab.id], srcLayout);
}

// Move or copy several tabs (items = [{ win, idx }]) into a workflow, keeping their order.
// win / at: the window and the position (in that window as it is now) to drop them before;
// left out, they go to the end of the last window. Works inside one workflow too (reordering).
// A model of both workflows (one key per tab) is kept in step with every single move, so each
// moveTab gets the right positions even as earlier moves shift things around.
async function moveTabs({ fromId, items = [], toId, copy = false, win = null, at = null }) {
  if (!items.length) return 0;
  if (fromId === toId && win == null && !copy) return 0;
  const { workflows } = await loadState();
  const src = workflows[fromId], dst = workflows[toId];
  if (!src || !dst) return 0;
  const model = wf => ({ wins: (wf.windows || []).map((w, wi) => w.tabs.map((_, ti) => `${wi}:${ti}`)) });
  const S = model(src);
  const D = fromId === toId ? S : model(dst);
  const toWin = win == null ? Math.max(0, D.wins.length - 1) : Math.max(0, Math.min(win, D.wins.length));
  if (!D.wins[toWin]) D.wins[toWin] = [];
  const T = D.wins[toWin];
  const picked = new Set(items.map(it => `${it.win}:${it.idx}`));
  // The tab the moved ones should end up in front of (never one of the moved tabs themselves).
  let anchor = null;
  if (at != null) {
    for (let i = Math.max(0, at); i < T.length; i++) {
      if (copy || S !== D || !picked.has(T[i])) { anchor = T[i]; break; }
    }
  }
  const find = (wins, key) => {
    for (let wi = 0; wi < wins.length; wi++) { const ti = wins[wi].indexOf(key); if (ti >= 0) return { wi, ti }; }
    return null;
  };
  const order = items.slice().sort((a, b) => a.win - b.win || a.idx - b.idx);
  let prev = null, n = 0;
  for (const it of order) {
    const p = find(S.wins, `${it.win}:${it.idx}`);
    if (!p) continue;
    if (!copy) S.wins[p.wi].splice(p.ti, 1);
    const idx = prev ? T.indexOf(prev) + 1 : anchor ? T.indexOf(anchor) : T.length;
    await moveTab({ from: { id: fromId, win: p.wi, idx: p.ti }, to: { id: toId, win: D.wins.indexOf(T), idx }, copy });
    prev = `+${n++}`;
    T.splice(idx, 0, prev);
    // moveTab drops windows that end up empty – do the same here so window numbers stay right.
    S.wins = S.wins.filter(w => w.length || w === T);
    if (D !== S) D.wins = D.wins.filter(w => w.length || w === T);
  }
  return n;
}

async function removeTabs({ id, items = [] }) {
  const { workflows } = await loadState();
  const wf = workflows[id];
  if (!wf) return 0;
  const removed = items.map(it => wf.windows[it.win] && wf.windows[it.win].tabs[it.idx]).filter(Boolean);
  if (removed.length) await addToTrash({ kind: "tabs", fromId: id, fromName: wf.name, tabs: removed });
  const lastFirst = items.slice().sort((a, b) => b.win - a.win || b.idx - a.idx);
  for (const it of lastFirst) await removeTab({ id, win: it.win, idx: it.idx, trash: false });
  return items.length;
}

async function removeTab({ id, win, idx, trash = true }) {
  const { workflows } = await loadState();
  const wf = workflows[id];
  const w = wf && wf.windows[win];
  if (!w || !w.tabs[idx]) return;
  if (trash) await addToTrash({ kind: "tabs", fromId: id, fromName: wf.name, tabs: [w.tabs[idx]] });
  const layout = await liveLayoutFor(id);
  const liveTab = layout && layout[win] ? layout[win].tabs[idx] : null;

  const [gone] = w.tabs.splice(idx, 1);
  if (gone && gone.section && w.tabs[idx] && !w.tabs[idx].section) w.tabs[idx].section = gone.section;
  if (idx < (w.activeIndex || 0)) w.activeIndex--;
  wf.windows = wf.windows.filter(x => x.tabs.length);
  wf.windows.forEach(fixActive);
  wf.savedAt = Date.now();
  await persist({ workflows });
  if (liveTab) await closeLiveTabs([liveTab.id], layout);
}

async function addTab({ id, win = 0, url, name = "", title = "", favIconUrl = "" }) {
  url = normalizeUrl(url);
  if (!url) return;
  const { workflows } = await loadState();
  const wf = workflows[id];
  if (!wf) return;
  wf.windows = wf.windows || [];
  const wi = Math.min(win, wf.windows.length);
  if (!wf.windows[wi]) wf.windows[wi] = { tabs: [], activeIndex: 0 };
  if (!title) { title = url; try { title = new URL(url).hostname || url; } catch (_) {} }
  const tab = { url, title: String(title), pinned: false, favIconUrl: /^(https?:|data:)/.test(favIconUrl) ? favIconUrl : "" };
  if (name && name.trim()) tab.name = name.trim();
  wf.windows[wi].tabs.push(tab);
  wf.savedAt = Date.now();
  const layout = await liveLayoutFor(id);
  await persist({ workflows });

  if (layout) {
    const lw = layout[wi];
    if (lw) await chrome.tabs.create({ windowId: lw.windowId, url, active: false }).catch(() => {});
    else {
      const w2 = await chrome.windows.create({ url, focused: false }).catch(() => null);
      if (w2) await mapWindow(w2.id, id);
    }
  }
}

// Rename a tab and/or change its URL. For a live workflow a URL change also navigates the real tab.
async function editTab({ id, win, idx, name, url }) {
  const { workflows } = await loadState();
  const tab = workflows[id] && workflows[id].windows[win] && workflows[id].windows[win].tabs[idx];
  if (!tab) return;
  const layout = await liveLayoutFor(id);
  const liveTab = layout && layout[win] ? layout[win].tabs[idx] : null;

  if (name !== undefined) {
    name = String(name || "").trim();
    if (name && name !== tab.title) tab.name = name; else delete tab.name;
  }
  url = url !== undefined ? normalizeUrl(url) : tab.url;
  const urlChanged = url && url !== tab.url;
  if (urlChanged) {
    tab.url = url;
    if (isDividerUrl(url)) tab.title = dividerTitle(dividerInfo(url).text);
    else try { tab.title = new URL(url).hostname || url; } catch (_) { tab.title = url; }
    tab.favIconUrl = "";
  }
  workflows[id].savedAt = Date.now();
  await persist({ workflows });
  if (urlChanged && liveTab) await chrome.tabs.update(liveTab.id, { url }).catch(() => {});
}

// Focus a tab of a live workflow, or open a saved tab in the current window.
async function focusTab({ id, win, idx }) {
  const { workflows } = await loadState();
  const tab = workflows[id] && workflows[id].windows[win] && workflows[id].windows[win].tabs[idx];
  if (!tab) return;
  const layout = await liveLayoutFor(id);
  const lt = layout && layout[win] && layout[win].tabs[idx];
  if (lt) {
    await chrome.tabs.update(lt.id, { active: true });
    await chrome.windows.update(lt.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: tab.url, active: true }).catch(() => {});
}

// ---------- pinning from the Session Manager ----------
const focusedNormalWindow = async () => {
  const wins = (await chrome.windows.getAll({ windowTypes: ["normal"] })).filter(w => !w.incognito);
  return wins.find(w => w.focused) || wins[0] || null;
};

// Pin or unpin a tab of a workflow. With "Keep pinned tabs open" a pinned tab belongs to no workflow:
// it leaves the workflow and is opened (or stays open) as a shared pinned tab.
async function setTabPinned({ id, win, idx, pinned }) {
  const { workflows } = await loadState();
  const wf = workflows[id];
  const w = wf && wf.windows[win];
  const tab = w && w.tabs[idx];
  if (!tab) return;
  const layout = await liveLayoutFor(id);
  const liveTab = layout && layout[win] ? layout[win].tabs[idx] : null;

  if (pinned && keepPins()) {
    w.tabs.splice(idx, 1);
    wf.windows = wf.windows.filter(x => x.tabs.length);
    wf.windows.forEach(fixActive);
    wf.savedAt = Date.now();
    await persist({ workflows });
    if (liveTab) await chrome.tabs.update(liveTab.id, { pinned: true }).catch(() => {});
    else { const fw = await focusedNormalWindow(); if (fw) await addPinnedTabs(fw.id, [tab]); }
    return;
  }

  // Saved in the workflow with its pinned flag; pinned tabs always sit at the front of their window.
  w.tabs.splice(idx, 1);
  tab.pinned = !!pinned;
  const pinnedCount = w.tabs.filter(t => t.pinned).length;
  w.tabs.splice(pinnedCount, 0, tab);
  fixActive(w);
  wf.savedAt = Date.now();
  await persist({ workflows });
  if (liveTab) await chrome.tabs.update(liveTab.id, { pinned: !!pinned }).catch(() => {});
}

// The shared pinned tabs ("Keep pinned tabs open"), by link.
async function openPinnedCopies(url) {
  const tabs = await chrome.tabs.query({ pinned: true });
  return tabs.filter(t => (t.url || t.pendingUrl) === url);
}

// Go to a shared pinned tab (the one in the focused window if there are copies); reopen it if it's gone.
async function focusPinned({ url }) {
  const fw = await focusedNormalWindow();
  const copies = await openPinnedCopies(url);
  const t = copies.find(x => fw && x.windowId === fw.id) || copies[0];
  if (t) {
    await chrome.tabs.update(t.id, { active: true }).catch(() => {});
    await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
  } else if (fw) {
    await addPinnedTabs(fw.id, [{ url }]);
  }
}

// Forget a link from the shared pinned set right away (saveNow would only notice once tabs change).
async function dropSharedPin(url) {
  const { pinnedTabs } = await chrome.storage.local.get("pinnedTabs");
  if (!pinnedTabs || !(pinnedTabs.tabs || []).some(t => t.url === url)) return;
  await chrome.storage.local.set({ pinnedTabs: { at: Date.now(), tabs: pinnedTabs.tabs.filter(t => t.url !== url) } });
}

// Unpin a shared pinned tab: the copy in your window becomes a normal tab of the workflow you're in;
// copies in other windows close.
async function unpinShared({ url }) {
  const fw = await focusedNormalWindow();
  const copies = await openPinnedCopies(url);
  const keep = copies.find(x => fw && x.windowId === fw.id) || copies[0];
  if (keep) await chrome.tabs.update(keep.id, { pinned: false }).catch(() => {});
  const extra = copies.filter(x => x !== keep).map(x => x.id);
  if (extra.length) await chrome.tabs.remove(extra).catch(() => {});
  await dropSharedPin(url);
}

// Close a shared pinned tab everywhere.
async function closeShared({ url }) {
  const ids = (await openPinnedCopies(url)).map(t => t.id);
  if (ids.length) {
    const all = await chrome.tabs.query({ windowType: "normal" });
    if (ids.length >= all.length) { const fw = await focusedNormalWindow(); if (fw) await chrome.tabs.create({ windowId: fw.id }).catch(() => {}); }
    await chrome.tabs.remove(ids).catch(() => {});
  }
  await dropSharedPin(url);
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return url; }
}

async function sortWorkflow({ id, by = "title" }) {
  const { workflows } = await loadState();
  const wf = workflows[id];
  if (!wf) return;
  const layout = await liveLayoutFor(id);
  const key = t => (by === "site" ? hostOf(t.url) + " " + (t.name || t.title || "") : (t.name || t.title || t.url)).toLowerCase();

  for (let wi = 0; wi < wf.windows.length; wi++) {
    const w = wf.windows[wi];
    const items = w.tabs.map((t, i) => ({ t, i }));
    items.sort((a, b) => (b.t.pinned - a.t.pinned) || key(a.t).localeCompare(key(b.t)));
    const activeOrig = w.activeIndex || 0;
    w.tabs = items.map(x => x.t);
    w.activeIndex = Math.max(0, items.findIndex(x => x.i === activeOrig));

    const lw = layout && layout[wi];
    if (lw && lw.tabs.length === items.length) {
      const base = lw.tabs[0].index;
      for (let k = 0; k < items.length; k++) {
        await chrome.tabs.move(lw.tabs[items[k].i].id, { index: base + k }).catch(() => {});
      }
    }
  }
  wf.savedAt = Date.now();
  await persist({ workflows });
}

async function dedupeWorkflow({ id }) {
  const { workflows } = await loadState();
  const wf = workflows[id];
  if (!wf) return 0;
  const layout = await liveLayoutFor(id);
  const seen = new Set();
  const closeIds = [];
  let removed = 0;
  wf.windows.forEach((w, wi) => {
    const keep = [];
    w.tabs.forEach((t, i) => {
      const k = t.url.replace(/#.*$/, "");
      if (seen.has(k)) {
        removed++;
        const lt = layout && layout[wi] && layout[wi].tabs[i];
        if (lt) closeIds.push(lt.id);
      } else { seen.add(k); keep.push(t); }
    });
    w.tabs = keep;
  });
  wf.windows = wf.windows.filter(w => w.tabs.length);
  wf.windows.forEach(fixActive);
  wf.savedAt = Date.now();
  await persist({ workflows });
  if (closeIds.length) await chrome.tabs.remove(closeIds).catch(() => {});
  return removed;
}

async function clearWorkflow({ id }) {
  const { workflows } = await loadState();
  const wf = workflows[id];
  if (!wf) return;
  const layout = await liveLayoutFor(id);
  const all = (wf.windows || []).flatMap(w => w.tabs);
  if (all.length) await addToTrash({ kind: "tabs", fromId: id, fromName: wf.name, tabs: all });
  wf.windows = [];
  wf.savedAt = Date.now();
  await persist({ workflows });
  if (layout && layout.length) await closeLiveTabs(layout.flatMap(w => w.tabs.map(t => t.id)), layout);
}

async function importWorkflows({ workflows: incoming = [] }) {
  const { workflows } = await loadState();
  let n = 0;
  for (const w of incoming) {
    const windows = (w.windows || [])
      .map(x => ({ activeIndex: x.activeIndex || 0, tabs: (x.tabs || []).filter(t => t && t.url).map(cleanTab),
                   ...(x.groups ? { groups: x.groups } : {}) }))
      .filter(x => x.tabs.length);
    windows.forEach(fixActive);
    const id = newId() + n;
    workflows[id] = {
      id, name: String(w.name || "Imported"), icon: String(w.icon || "folder"),
      autosave: w.autosave !== false, createdAt: Date.now() + n, savedAt: Date.now(), windows
    };
    n++;
  }
  await persist({ workflows });
  return n;
}

async function clearAllData() {
  const { workflows = {}, tombstones = {} } = await chrome.storage.local.get(["workflows", "tombstones"]);
  for (const id of Object.keys(workflows)) tombstones[id] = Date.now();
  await chrome.storage.local.set({ workflows: {}, activeWorkflowId: null, looseTabs: [], openWindows: {}, tombstones });
  await chrome.storage.local.remove("currentSession");
  await saveNow();
}

async function openManager({ view } = {}) {
  const url = MANAGER_URL + (view ? "#" + view : "");
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(t => (t.url || "").startsWith(MANAGER_URL));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true, url });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

// ---------- messages from the popup and the Session Manager ----------
const handlers = {
  saveAsWorkflow, saveIntoWorkflow, editWorkflow, setAutosave, deleteWorkflow,
  openWorkflow, createWorkflow, createEmptyWorkflow,
  moveTab, moveTabs, removeTab, removeTabs, addTab, editTab, focusTab, setTabPinned, focusPinned, unpinShared, closeShared, sortWorkflow, dedupeWorkflow, clearWorkflow,
  importWorkflows, clearAllData, openManager, saveCurrent,
  addDivider, editDivider, removeLabel, insertDividerTab, restoreWorkflowCopy,
  undo, undoTo, clearHistory, restoreFromTrash, deleteFromTrash, emptyTrash, openGroupCopy, deleteGroupCopy,
  makeBackup: () => makeBackup({ auto: false }), downloadLatestBackup: async () => {
    const { backups = [] } = await chrome.storage.local.get("backups");
    return backups[0] ? downloadBackup(JSON.stringify(backups[0].data), backups[0].data.createdAt) : false;
  },
  restoreBackup, deleteBackup, syncNow, syncInfo, syncPull, multiSyncNow, syncMergeRemote,
  saveNow: () => saveNow()
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = handlers[msg && msg.type];
  if (!fn) return false;
  enqueue(async () => {
    // Remember how things were, so this change can be undone.
    if (UNDOABLE.has(msg.type)) await pushHistory(await undoLabel(msg.type, msg.payload || {}));
    return fn(msg.payload || {});
  })
    .then(result => sendResponse({ ok: true, result }))
    .catch(err => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // async response
});
