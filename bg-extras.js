// Tab Workflows – background extras: undo history, trash, Chrome tab groups,
// daily backups and Chrome-profile sync. Loaded by background.js (importScripts) before its own code;
// everything here runs later, from events, so it can use background.js functions freely.

// ======================= Chrome tab groups =======================
const HAS_GROUPS = !!(chrome.tabGroups && chrome.tabs.group);

// { realGroupId -> { title, color, collapsed } } for the groups used by these windows.
async function groupInfo(wins) {
  const info = new Map();
  if (!HAS_GROUPS) return info;
  const ids = new Set();
  wins.forEach(w => w.tabs.forEach(t => { if (typeof t.groupId === "number" && t.groupId >= 0) ids.add(t.groupId); }));
  await Promise.all([...ids].map(async id => {
    try {
      const g = await chrome.tabGroups.get(id);
      info.set(id, { title: g.title || "", color: g.color || "grey", collapsed: !!g.collapsed });
    } catch (_) {}
  }));
  return info;
}

// Re-create a saved window's groups on freshly opened tabs (same order as sw.tabs).
async function applyGroups(tabs, sw, activeTab) {
  if (!HAS_GROUPS || !sw.groups) return;
  const byKey = new Map();
  sw.tabs.forEach((t, i) => {
    if (!t.group || !sw.groups[t.group] || !tabs[i] || t.pinned) return;
    if (!byKey.has(t.group)) byKey.set(t.group, []);
    byKey.get(t.group).push(tabs[i]);
  });
  for (const [key, list] of byKey) {
    try {
      const gid = await chrome.tabs.group({ tabIds: list.map(t => t.id), createProperties: { windowId: list[0].windowId } });
      const g = sw.groups[key];
      const holdsActive = activeTab && list.some(t => t.id === activeTab.id);
      await chrome.tabGroups.update(gid, { title: g.title || "", color: g.color || "grey", collapsed: !!g.collapsed && !holdsActive });
    } catch (_) {}
  }
}

// Put tabs (given in the saved window's order) back into their groups, with name/colour/collapsed.
async function regroup(placed, sw, windowId) {
  if (!HAS_GROUPS || !sw.groups) return;
  const byKey = new Map();
  sw.tabs.forEach((t, i) => {
    if (!t.group || !sw.groups[t.group] || !placed[i] || t.pinned) return;
    if (!byKey.has(t.group)) byKey.set(t.group, []);
    byKey.get(t.group).push(placed[i]);
  });
  for (const [key, list] of byKey) {
    const g = sw.groups[key];
    const together = list.every(t => typeof t.groupId === "number" && t.groupId >= 0 && t.groupId === list[0].groupId);
    try {
      const gid = together ? list[0].groupId
        : await chrome.tabs.group({ tabIds: list.map(t => t.id), createProperties: { windowId } });
      await chrome.tabGroups.update(gid, { title: g.title || "", color: g.color || "grey",
                                          collapsed: !!g.collapsed && !list.some(t => t.active) });
    } catch (_) {}
  }
}

// Closing a whole tab group in Chrome becomes an undoable History entry ("Close group …").
// The workflow's last save still has the group at this moment, so that's what Undo goes back to.
async function onGroupRemoved(group) {
  if (switching) return;
  const key = "g" + group.id;
  const { workflows = {}, looseTabs = [] } = await chrome.storage.local.get(["workflows", "looseTabs"]);
  let found = null;
  for (const wf of Object.values(workflows)) {
    for (const w of wf.windows || []) {
      if (w.groups && w.groups[key]) { found = { wf, g: w.groups[key], tabs: w.tabs.filter(t => t.group === key) }; break; }
    }
    if (found) break;
  }
  if (!found || !found.tabs.length) return;
  const before = JSON.parse(JSON.stringify({ workflows, looseTabs }));
  // Was the group closed, or were its tabs just ungrouped / was the whole window closed?
  await new Promise(r => setTimeout(r, 350));
  if (switching) return;
  const win = await chrome.windows.get(group.windowId, { populate: true }).catch(() => null);
  if (!win) return;                                                  // window closed: not a group close
  const open = new Set((win.tabs || []).map(t => t.url || t.pendingUrl));
  if (found.tabs.filter(t => open.has(t.url)).length >= Math.ceil(found.tabs.length / 2)) return;  // only ungrouped
  const label = `Close group “${found.g.title || "Unnamed group"}” (${found.tabs.length} tab${found.tabs.length === 1 ? "" : "s"}) in “${found.wf.name}”`;
  await enqueue(async () => {
    const { history = [] } = await chrome.storage.local.get("history");
    history.unshift({ at: Date.now(), label, workflows: before.workflows, looseTabs: before.looseTabs });
    await chrome.storage.local.set({ history: history.slice(0, await historyMax()) });
  });
}

if (HAS_GROUPS) {
  const onGroupChange = () => scheduleSave();
  chrome.tabGroups.onCreated.addListener(onGroupChange);
  chrome.tabGroups.onUpdated.addListener(onGroupChange);
  chrome.tabGroups.onRemoved.addListener(g => { onGroupChange(); onGroupRemoved(g); });
}

// ======================= Undo history =======================
const HISTORY_MAX = 25;   // default; Settings → Data → "Undo steps" changes it
async function historyMax() {
  const n = Number((await getSettings()).historyMax);
  return n > 0 ? n : HISTORY_MAX;
}

// Things the Session Manager and the popup can undo, with a readable label.
const UNDOABLE = new Set([
  "deleteWorkflow", "removeTab", "removeTabs", "moveTab", "moveTabs", "setTabPinned", "clearWorkflow", "dedupeWorkflow",
  "sortWorkflow", "editTab", "editWorkflow", "addTab", "createEmptyWorkflow", "importWorkflows",
  "clearAllData", "restoreFromTrash", "restoreBackup", "addDivider", "editDivider", "removeLabel", "restoreWorkflowCopy"
]);

async function undoLabel(type, p) {
  const { workflows } = await loadState();
  const n = id => (workflows[id] ? `“${workflows[id].name}”` : "a workflow");
  const k = (x, w) => `${x} ${w}${x === 1 ? "" : "s"}`;
  switch (type) {
    case "deleteWorkflow": return `Delete ${n(p.id)}`;
    case "removeTab": return `Remove a tab from ${n(p.id)}`;
    case "removeTabs": return `Remove ${k((p.items || []).length, "tab")} from ${n(p.id)}`;
    case "moveTab":
      if (p.copy) return `Copy a tab to ${n(p.to.id)}`;
      return p.from.id === p.to.id ? `Reorder tabs in ${n(p.from.id)}` : `Move a tab to ${n(p.to.id)}`;
    case "moveTabs": return `${p.copy ? "Copy" : "Move"} ${k((p.items || []).length, "tab")} to ${n(p.toId)}`;
    case "clearWorkflow": return `Remove all tabs from ${n(p.id)}`;
    case "dedupeWorkflow": return `Remove duplicates in ${n(p.id)}`;
    case "sortWorkflow": return `Sort ${n(p.id)}`;
    case "editTab": return `Edit a tab in ${n(p.id)}`;
    case "setTabPinned": return `${p.pinned ? "Pin" : "Unpin"} a tab in ${n(p.id)}`;
    case "editWorkflow": return `Edit ${n(p.id)}`;
    case "addTab": return `Add a tab to ${n(p.id)}`;
    case "createEmptyWorkflow": return `Create “${p.name || "Untitled"}”`;
    case "importWorkflows": return "Import workflows";
    case "clearAllData": return "Delete everything";
    case "restoreFromTrash": return "Restore from trash";
    case "restoreBackup": return "Restore a backup";
    case "addDivider": return `Add a divider to ${n(p.id)}`;
    case "editDivider": return `Edit a divider in ${n(p.id)}`;
    case "removeLabel": return `Remove a divider from ${n(p.id)}`;
    case "restoreWorkflowCopy": return `Restore a backup copy of ${n(p.id)}`;
    default: return "Change";
  }
}

async function pushHistory(label) {
  const { workflows = {}, looseTabs = [], history = [] } = await chrome.storage.local.get(["workflows", "looseTabs", "history"]);
  history.unshift({ at: Date.now(), label, workflows, looseTabs });
  await chrome.storage.local.set({ history: history.slice(0, await historyMax()) });
}

// Put workflows back to an earlier state; open (live) workflows get their real tabs fixed up too.
async function restoreState(workflows, looseTabs) {
  const { tombstones = {} } = await chrome.storage.local.get("tombstones");
  let tombChanged = false;
  for (const id of Object.keys(workflows)) {
    if (tombstones[id]) { delete tombstones[id]; workflows[id] = { ...workflows[id], savedAt: Date.now() }; tombChanged = true; }
  }
  if (tombChanged) await chrome.storage.local.set({ tombstones });
  const live = [];
  for (const id of Object.keys(workflows)) if (await liveLayoutFor(id)) live.push(id);
  await chrome.storage.local.set({ workflows, looseTabs: looseTabs || [] });
  for (const id of live) if (workflows[id]) await syncLiveTo(id, workflows[id].windows || []);
}

// Make an open workflow's real tabs match `savedWindows`: reopen missing ones, close extra ones, fix the order.
async function syncLiveTo(id, savedWindows) {
  const layout = await liveLayoutFor(id);
  if (!layout) return;
  pauseAutosave();
  try {
    for (let wi = 0; wi < savedWindows.length; wi++) {
      const sw = savedWindows[wi];
      const lw = layout[wi];
      if (!lw) {
        const win = await openSavedWindow(sw, { focused: false }).catch(() => null);
        if (win) await mapWindow(win.id, id);
        continue;
      }
      const pool = lw.tabs.slice();
      const ids = [];
      const placed = [];                                   // real tab for each saved tab, in order
      for (const t of sw.tabs) {
        const i = pool.findIndex(x => x.url === t.url);
        if (i >= 0) { ids.push(pool[i].id); placed.push(pool[i]); pool.splice(i, 1); continue; }
        const nt = await chrome.tabs.create({ windowId: lw.windowId, url: t.url, active: false }).catch(() => null);
        if (nt) ids.push(nt.id);
        placed.push(nt);
      }
      if (ids.length) await chrome.tabs.move(ids, { windowId: lw.windowId, index: 0 }).catch(() => {});
      if (pool.length) await closeLiveTabs(pool.map(t => t.id), layout);
      await regroup(placed, sw, lw.windowId);              // tab groups come back as groups
    }
  } finally {
    resumeAutosave();
    setTimeout(() => enqueue(saveNow), 800);
  }
}

async function undo() {
  return undoTo({ index: 0 });
}

// Go back to how things were before history entry `index` (newer entries are dropped).
async function undoTo({ index = 0 }) {
  const { history = [] } = await chrome.storage.local.get("history");
  const h = history[index];
  if (!h) return null;
  await restoreState(h.workflows, h.looseTabs);
  // A workflow that's back no longer belongs in the trash.
  const { trash = [] } = await chrome.storage.local.get("trash");
  const keepTrash = trash.filter(e => !(e.kind === "workflow" && h.workflows[e.workflow.id]));
  await chrome.storage.local.set({ history: history.slice(index + 1), trash: keepTrash });
  return h.label;
}

// ======================= Trash =======================
const TRASH_MAX = 60;
const TRASH_DAYS = 30;   // default; Settings → Data → "Keep deleted items" changes it (0 = no time limit)

async function addToTrash(entry) {
  const { trash = [] } = await chrome.storage.local.get("trash");
  trash.unshift({ id: newId(), at: Date.now(), ...entry });
  await chrome.storage.local.set({ trash: trash.slice(0, TRASH_MAX) });
}

async function restoreFromTrash({ id }) {
  const { trash = [] } = await chrome.storage.local.get("trash");
  const entry = trash.find(e => e.id === id);
  if (!entry) return null;
  const { workflows } = await loadState();
  let where = "";
  if (entry.kind === "workflow") {
    const wf = JSON.parse(JSON.stringify(entry.workflow));
    if (workflows[wf.id]) wf.id = newId();
    wf.savedAt = Date.now();
    workflows[wf.id] = wf;
    where = wf.name;
  } else if (entry.kind === "tabs") {
    const target = workflows[entry.fromId] && entry.fromId !== LOOSE ? workflows[entry.fromId] : workflows[LOOSE];
    target.windows = target.windows && target.windows.length ? target.windows : [{ tabs: [], activeIndex: 0 }];
    target.windows[target.windows.length - 1].tabs.push(...entry.tabs.map(cleanTab));
    target.savedAt = Date.now();
    where = target.name;
    // the target may be open: its real tabs get added too
    const layout = await liveLayoutFor(target.id);
    if (layout && layout.length) {
      const lw = layout[layout.length - 1];
      for (const t of entry.tabs) await chrome.tabs.create({ windowId: lw.windowId, url: t.url, active: false }).catch(() => {});
    }
  }
  await persist({ workflows, trash: trash.filter(e => e.id !== id) });
  return where;
}

async function deleteFromTrash({ id }) {
  const { trash = [] } = await chrome.storage.local.get("trash");
  await chrome.storage.local.set({ trash: trash.filter(e => e.id !== id) });
}

async function emptyTrash() {
  await chrome.storage.local.set({ trash: [] });
}

async function purgeOldTrash() {
  const { trash = [] } = await chrome.storage.local.get("trash");
  const raw = (await getSettings()).trashDays;
  const days = raw === undefined || raw === null ? TRASH_DAYS : Number(raw);
  if (!(days > 0)) return;                                    // "Until the trash is full"
  const keep = trash.filter(e => Date.now() - e.at < days * 864e5);
  if (keep.length !== trash.length) await chrome.storage.local.set({ trash: keep });
}

// ======================= Backups =======================
const BACKUPS_MAX = 10;

function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64utf8 = str => bytesToB64(new TextEncoder().encode(str));

async function makeBackup({ auto = false, download = false } = {}) {
  const { workflows = {}, looseTabs = [], settings: st = {}, backups = [] } =
    await chrome.storage.local.get(["workflows", "looseTabs", "settings", "backups"]);
  const createdAt = new Date().toISOString();
  const data = { app: "tab-workflows", version: 1, kind: "backup", createdAt, workflows: Object.values(workflows), looseTabs, settings: st };
  const json = JSON.stringify(data);
  backups.unshift({ id: newId(), at: Date.now(), auto, size: json.length, count: Object.keys(workflows).length, data });
  await chrome.storage.local.set({ backups: backups.slice(0, BACKUPS_MAX), lastBackupAt: Date.now() });
  const s = await getSettings();
  if (download || (auto && s.backupMode === "file")) await downloadBackup(json, createdAt);
  return true;
}

async function downloadBackup(json, iso) {
  if (!chrome.downloads) return false;
  await chrome.downloads.download({
    url: "data:application/json;base64," + b64utf8(json),
    filename: `Tab Workflows backups/backup-${iso.slice(0, 10)}.json`,
    conflictAction: "overwrite",
    saveAs: false
  }).catch(() => {});
  return true;
}

async function restoreBackup({ id }) {
  const { backups = [] } = await chrome.storage.local.get("backups");
  const b = backups.find(x => x.id === id);
  if (!b) throw new Error("Backup not found");
  const workflows = {};
  for (const wf of b.data.workflows || []) workflows[wf.id || newId()] = wf;
  await restoreState(workflows, b.data.looseTabs || []);
  return Object.keys(workflows).length;
}

async function deleteBackup({ id }) {
  const { backups = [] } = await chrome.storage.local.get("backups");
  await chrome.storage.local.set({ backups: backups.filter(x => x.id !== id) });
}

// Checked every hour; makes one automatic backup per day.
async function autoBackup() {
  await purgeOldTrash();
  const s = await getSettings();
  if (s.backupMode === "off") return;
  const { lastBackupAt = 0, workflows = {} } = await chrome.storage.local.get(["lastBackupAt", "workflows"]);
  if (!Object.keys(workflows).length) return;
  if (Date.now() - lastBackupAt < 20 * 3600e3) return;
  await makeBackup({ auto: true });
}

function ensureAlarms() {
  chrome.alarms.create("daily-backup", { delayInMinutes: 1, periodInMinutes: 60 });
  scheduleMultiSync();
}

// Multi-browser sync runs every `syncInterval` minutes (Chrome allows at least 30 seconds).
async function scheduleMultiSync() {
  const s = await getSettings();
  const every = Math.max(0.5, Number(s.syncInterval) || DEFAULT_SETTINGS.syncInterval);
  const cur = await chrome.alarms.get("msync");
  if (cur && cur.periodInMinutes === every) return;
  chrome.alarms.create("msync", { delayInMinutes: Math.min(1, every), periodInMinutes: every });
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !ch.settings) return;
  const a = ch.settings.oldValue || {}, b = ch.settings.newValue || {};
  if (a.syncInterval !== b.syncInterval) scheduleMultiSync();
  if (a.dividerTabWidth !== b.dividerTabWidth) refitSleepingDividers();
  if (a.trashDays !== b.trashDays) purgeOldTrash();
  if (a.historyMax !== b.historyMax) enqueue(async () => {           // fewer undo steps: drop the oldest now
    const { history = [] } = await chrome.storage.local.get("history");
    const max = await historyMax();
    if (history.length > max) await chrome.storage.local.set({ history: history.slice(0, max) });
  });
  if (a.skipDuplicateTabs !== b.skipDuplicateTabs || a.skipNewTabs !== b.skipNewTabs) scheduleSave();
  if (!a.syncSettings && b.syncSettings && AUTO_SYNC_METHODS.includes(b.syncMethod)) enqueue(() => multiSyncNow());   // pick up the synced settings now
});

// ======================= Sync with your Chrome profile =======================
// Workflows are gzipped and split into small pieces in chrome.storage.sync (Chrome allows ~100 KB in total).
const SYNC_CHUNK = 7000;
const SYNC_LIMIT = 90000;

async function getDeviceId() {
  let { deviceId } = await chrome.storage.local.get("deviceId");
  if (!deviceId) { deviceId = newId(); await chrome.storage.local.set({ deviceId }); }
  return deviceId;
}

async function gzipB64(str) {
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream("gzip"));
  return bytesToB64(new Uint8Array(await new Response(stream).arrayBuffer()));
}

async function gunzipB64(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

async function syncNow() {
  const s = await getSettings();
  if (s.syncMethod !== "chrome" || !chrome.storage.sync) return null;
  const { workflows = {}, looseTabs = [], tombstones = {}, pinnedTabs = null } =
    await chrome.storage.local.get(["workflows", "looseTabs", "tombstones", "pinnedTabs"]);
  const device = await getDeviceId();
  const at = Date.now();
  // Tombstones: so a workflow deleted here is also deleted in the other profiles when they merge.
  const b64 = await gzipB64(JSON.stringify({ v: 1, at, device, workflows, looseTabs, tombstones, ...(pinnedTabs ? { pinnedTabs } : {}) }));
  if (b64.length > SYNC_LIMIT) {
    const status = { ok: false, at, size: b64.length,
      error: "Your workflows are too big for Chrome sync (about 90 KB after compression). Daily backup files still work." };
    await chrome.storage.local.set({ syncStatus: status });
    return status;
  }
  const old = (await chrome.storage.sync.get("sync_meta")).sync_meta;
  const chunks = Math.ceil(b64.length / SYNC_CHUNK);
  const items = { sync_meta: { v: 1, at, device, chunks, size: b64.length, count: Object.keys(workflows).length } };
  for (let i = 0; i < chunks; i++) items["sync_" + i] = b64.slice(i * SYNC_CHUNK, (i + 1) * SYNC_CHUNK);
  try {
    await chrome.storage.sync.set(items);
    if (old && old.chunks > chunks) {
      await chrome.storage.sync.remove(Array.from({ length: old.chunks - chunks }, (_, i) => "sync_" + (chunks + i)));
    }
    const status = { ok: true, at, size: b64.length };
    await chrome.storage.local.set({ syncStatus: status });
    return status;
  } catch (e) {
    const status = { ok: false, at, size: b64.length, error: "Chrome refused the sync: " + (e && e.message || e) };
    await chrome.storage.local.set({ syncStatus: status });
    return status;
  }
}

async function syncInfo() {
  if (!chrome.storage.sync) return null;
  const meta = (await chrome.storage.sync.get("sync_meta")).sync_meta || null;
  if (!meta) return null;
  const device = await getDeviceId();
  return { at: meta.at, size: meta.size, count: meta.count, fromOtherDevice: meta.device !== device };
}

// The synced copy in the Chrome profile. Throws while Chrome hasn't received all of its pieces yet.
async function readChromeSyncCopy(meta) {
  const keys = Array.from({ length: meta.chunks }, (_, i) => "sync_" + i);
  const got = await chrome.storage.sync.get(keys);
  const b64 = keys.map(k => got[k] || "").join("");
  if (meta.size && b64.length !== meta.size) throw new Error("The synced copy hasn't fully arrived yet");
  return JSON.parse(await gunzipB64(b64));
}

// Bring workflows from the synced copy: "merge" adds/updates, "replace" swaps everything.
async function syncPull({ mode = "merge" }) {
  const meta = (await chrome.storage.sync.get("sync_meta")).sync_meta;
  if (!meta) throw new Error("Nothing has been synced yet");
  const remote = await readChromeSyncCopy(meta);
  await pushHistory(mode === "replace" ? "Replace with synced workflows" : "Merge synced workflows");

  const { workflows: localAll } = await loadState();
  const local = { ...localAll };
  const localLoose = (local[LOOSE] && local[LOOSE].windows[0].tabs) || [];
  delete local[LOOSE];
  let workflows, looseTabs;
  if (mode === "replace") {
    workflows = remote.workflows || {};
    looseTabs = remote.looseTabs || [];
  } else {
    workflows = { ...local };
    for (const [id, wf] of Object.entries(remote.workflows || {})) {
      const mine = workflows[id];
      if (!mine) workflows[id] = wf;
      else if ((wf.savedAt || 0) > (mine.savedAt || 0) && !(await liveLayoutFor(id))) workflows[id] = wf;
    }
    looseTabs = [...localLoose, ...(remote.looseTabs || []).filter(t => !localLoose.some(x => x.url === t.url))];
  }
  await restoreState(workflows, looseTabs);
  return Object.keys(remote.workflows || {}).length;
}

// Push changes to sync about a minute after they happen (Chrome limits how often sync may be written).
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !(ch.workflows || ch.looseTabs || ch.pinnedTabs)) return;
  if (settings.syncMethod === "chrome") chrome.alarms.create("sync-push", { delayInMinutes: 1 });
});

// When another profile's copy arrives, merge it in by itself (the same merge as the other sync methods:
// the newest version of each workflow wins, deletions are kept). If that changed anything here, the
// "sync-push" above sends the combined result back a minute later; the other profile then has nothing
// new to merge, so it stops there.
async function mergeChromeSyncCopy() {
  const s = await getSettings();
  if (s.syncMethod !== "chrome" || !chrome.storage.sync) return false;
  const meta = (await chrome.storage.sync.get("sync_meta")).sync_meta;
  if (!meta || meta.device === await getDeviceId()) return false;      // nothing, or our own upload
  const { chromeSyncMergedAt = 0 } = await chrome.storage.local.get("chromeSyncMergedAt");
  if ((meta.at || 0) <= chromeSyncMergedAt) return false;                // merged that one already
  let remote;
  try { remote = await readChromeSyncCopy(meta); }
  catch (_) { chrome.alarms.create("sync-merge", { delayInMinutes: 1 }); return false; }   // pieces still arriving
  await mergeRemote(remote);
  await chrome.storage.local.set({ chromeSyncMergedAt: meta.at || Date.now() });
  return true;
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "sync" && Object.keys(ch).some(k => k === "sync_meta" || k.startsWith("sync_"))) enqueue(mergeChromeSyncCopy);
  if (area === "local" && ch.settings && (ch.settings.newValue || {}).syncMethod === "chrome"
      && (ch.settings.oldValue || {}).syncMethod !== "chrome") enqueue(mergeChromeSyncCopy);   // just switched to it
});
// Anything that arrived while the browser was closed. setTimeout: this file is loaded before background.js
// has set up enqueue's queue.
setTimeout(() => enqueue(mergeChromeSyncCopy), 0);

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === "daily-backup") enqueue(autoBackup);
  if (a.name === "sync-push") enqueue(syncNow);
  if (a.name === "sync-merge") enqueue(mergeChromeSyncCopy);
});

// ======================= Opening a workflow's tabs (Close & reopen) =======================
// Open a saved window's tabs at the end of an existing window: grouped and pinned *before* the
// first one is shown, so you never see them pop in ungrouped.
// With { groupsLater: true } the tabs are shown right away and the caller creates the groups afterwards
// (the active tab is returned as `created.active`).
async function appendSavedWindow(windowId, sw, lazy, { groupsLater = false } = {}) {
  const created = await Promise.all(sw.tabs.map(t =>
    chrome.tabs.create({ windowId, url: t.url, active: false })
      .catch(() => chrome.tabs.create({ windowId, active: false }))
      .catch(() => null)));
  const ids = created.filter(Boolean).map(t => t.id);
  if (!ids.length) return [];
  watchTabs(ids);
  await chrome.tabs.move(ids, { windowId, index: -1 }).catch(() => {});
  for (let i = 0; i < sw.tabs.length; i++) {
    if (sw.tabs[i].pinned && created[i]) await chrome.tabs.update(created[i].id, { pinned: true }).catch(() => {});
  }
  const active = created[sw.activeIndex] || created.find(Boolean);
  if (!groupsLater) await applyGroups(created, sw, active);
  await chrome.tabs.update(active.id, { active: true }).catch(() => {});
  if (lazy) lazyLoad(created, sw.tabs, active);
  created.active = active;
  return created;
}

// ======================= Multi-browser sync (Chrome, Brave, Helium, …) =======================
// Four ways to share workflows between browsers, all encrypted with your passphrase (sync-core.js):
//   folder  – a shared folder; runs in the Session Manager page (folders need a page)
//   gist    – a private GitHub Gist (automatic)
//   server  – your own tiny Cloudflare Worker (automatic, see sync-server/)
//   webdav  – Nextcloud, Koofr, … (automatic)
// Each run: download the synced copy, merge it with this browser (newest version of each workflow wins,
// deletions are remembered as "tombstones"), save the result here and upload it if anything changed.
const AUTO_SYNC_METHODS = ["gist", "server", "webdav"];
let syncApplying = false;

getSyncConfig().then(protectSyncConfig).catch(() => {});   // older versions stored the passphrase, logins and addresses as text

async function getSyncConfig() {
  const { syncConfig = {} } = await chrome.storage.local.get("syncConfig");
  return syncConfig;
}
async function saveSyncConfig(patch) {
  return saveSyncFields(patch);            // encrypts sensitive fields (e.g. the gist id)
}
async function setMultiSyncStatus(st) {
  const status = { at: Date.now(), ...st };
  await chrome.storage.local.set({ multiSyncStatus: status });
  return status;
}

// Settings that travel with the sync (everything except LOCAL_ONLY_SETTINGS).
const sharedSettings = s => Object.fromEntries(Object.entries(s).filter(([k]) => !LOCAL_ONLY_SETTINGS.includes(k)));

async function buildSyncPayload() {
  const { workflows = {}, looseTabs = [], tombstones = {}, settingsAt = 0, pinnedTabs = null } =
    await chrome.storage.local.get(["workflows", "looseTabs", "tombstones", "settingsAt", "pinnedTabs"]);
  const payload = { v: 2, at: Date.now(), device: await getDeviceId(), workflows, looseTabs, tombstones };
  if (pinnedTabs) payload.pinnedTabs = pinnedTabs;
  await addVersionInfo(payload);
  const s = await getSettings();
  if (s.syncSettings) { payload.settings = sharedSettings(s); payload.settingsAt = settingsAt; }
  else if (lastRemoteSettings) { payload.settings = lastRemoteSettings.settings; payload.settingsAt = lastRemoteSettings.settingsAt; }
  return payload;
}
// Synced settings seen in the last download: kept in the file even by a browser that doesn't sync settings.
let lastRemoteSettings = null;

// "Sync settings" is on: take the other browsers' settings if they were changed more recently.
async function mergeRemoteSettings(remote) {
  lastRemoteSettings = remote && remote.settings ? { settings: remote.settings, settingsAt: remote.settingsAt || 0 } : null;
  const s = await getSettings();
  if (!s.syncSettings || !lastRemoteSettings) return;
  const { settingsAt = 0 } = await chrome.storage.local.get("settingsAt");
  if (lastRemoteSettings.settingsAt <= settingsAt) return;
  const next = { ...s, ...sharedSettings(lastRemoteSettings.settings) };
  for (const k of LOCAL_ONLY_SETTINGS) next[k] = s[k];
  syncApplying = true;
  try { await chrome.storage.local.set({ settings: next, settingsAt: lastRemoteSettings.settingsAt }); }
  finally { setTimeout(() => { syncApplying = false; }, 200); }
}

// What a workflow's tabs are, ignoring things that change on their own (active tab, page titles, icons,
// Chrome's group ids). Two versions with the same shape are the same for sync.
function tabShape(windows) {
  return scCanon((windows || []).map(w => (w.tabs || []).map(t => {
    const g = t.group && w.groups && w.groups[t.group];
    return [t.url, !!t.pinned, t.name || "", g ? [g.title || "", g.color || ""] : null,
            t.section ? [t.section.text || "", t.section.color || ""] : null];
  })));
}

// Merge the synced copy into this browser and return what should be synced back.
// A workflow that's open here and was changed more recently in another browser gets its real tabs
// updated (tabs closed, opened, moved), so the change isn't undone by this browser's next autosave.
async function mergeRemote(remote) {
  await mergeRemoteSettings(remote);
  await checkVersions(remote);
  await mergeRemotePins(remote);
  if (remote && remote.workflows) {
    const { workflows = {}, looseTabs = [], tombstones = {}, activeWorkflowId = null } =
      await chrome.storage.local.get(["workflows", "looseTabs", "tombstones", "activeWorkflowId"]);
    const tomb = { ...tombstones };
    for (const [id, at] of Object.entries(remote.tombstones || {})) tomb[id] = Math.max(tomb[id] || 0, at || 0);
    for (const wf of Object.values(remote.workflows)) localizeDividers(wf.windows);
    const merged = {};
    const applyLive = [];
    for (const id of new Set([...Object.keys(workflows), ...Object.keys(remote.workflows)])) {
      const l = workflows[id], r = remote.workflows[id];
      const pick = !l ? r : !r ? l : ((r.savedAt || 0) > (l.savedAt || 0) ? r : l);
      if (tomb[id] && tomb[id] >= (pick.savedAt || 0)) continue;     // deleted somewhere, after its last change
      if (l && pick === r && tabShape(l.windows) !== tabShape(r.windows) && (await liveLayoutFor(id))) applyLive.push(id);
      merged[id] = pick;
    }
    const loose = [...looseTabs, ...(remote.looseTabs || []).filter(t => !looseTabs.some(x => x.url === t.url))];
    const update = {};
    if (scCanon(merged) !== scCanon(workflows)) update.workflows = merged;
    if (loose.length !== looseTabs.length) update.looseTabs = loose;
    if (scCanon(tomb) !== scCanon(tombstones)) update.tombstones = tomb;
    if (activeWorkflowId && !merged[activeWorkflowId]) update.activeWorkflowId = null;
    if (Object.keys(update).length) {
      syncApplying = true;
      try { await chrome.storage.local.set(update); } finally { setTimeout(() => { syncApplying = false; }, 200); }
    }
    for (const id of applyLive) {
      try { await syncLiveTo(id, merged[id].windows || []); } catch (_) {}
    }
  }
  return buildSyncPayload();
}

// Shared pinned tabs ("Keep pinned tabs open"): the newest set wins. It's always kept in the synced copy;
// with "Every window, on all your browsers" a newer set from another browser also changes the pinned tabs
// open here: missing ones open pinned in every window, ones unpinned or closed there close here.
async function mergeRemotePins(remote) {
  const r = remote && remote.pinnedTabs;
  if (!r || !Array.isArray(r.tabs)) return;
  const { pinnedTabs: l = null } = await chrome.storage.local.get("pinnedTabs");
  if (l && (l.at || 0) >= (r.at || 0)) return;
  syncApplying = true;
  try { await chrome.storage.local.set({ pinnedTabs: { at: r.at || Date.now(), tabs: r.tabs } }); }
  finally { setTimeout(() => { syncApplying = false; }, 200); }
  const s = await getSettings();
  if (!s.keepPinnedTabs || s.pinnedScope !== "sync") return;
  const want = new Set(r.tabs.map(t => t.url));
  const before = new Set(((l && l.tabs) || []).map(t => t.url));
  pauseAutosave();
  try {
    const wins = (await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] })).filter(w => !w.incognito);
    const close = [];
    for (const w of wins) {
      const mine = (w.tabs || []).filter(t => {
        const url = t.url || t.pendingUrl;
        // Only close what was in the old shared set (so a tab you pinned here just now isn't lost).
        return t.pinned && before.has(url) && !want.has(url);
      });
      await addPinnedTabs(w.id, r.tabs);
      // Never leave a window with nothing in it (closing its last tab would close the window).
      if (mine.length && mine.length === (w.tabs || []).length && !r.tabs.length) {
        await chrome.tabs.create({ windowId: w.id, active: true }).catch(() => {});
      }
      close.push(...mine.map(t => t.id));
    }
    if (close.length) await chrome.tabs.remove(close).catch(() => {});
  } finally {
    resumeAutosave();
    setTimeout(() => enqueue(saveNow), 800);
  }
}

// ---- where the encrypted file lives ----
const GH_API = "https://api.github.com";
const ghHeaders = cfg => ({ Authorization: `Bearer ${cfg.gistToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });
const httpError = async (who, r) => {
  const hint = r.status === 401 || r.status === 403 ? " – check the token / password." : r.status === 404 ? " – check the address." : "";
  return new Error(`${who} answered ${r.status} ${r.statusText || ""}${hint}`.trim());
};
const SYNC_PROVIDERS = {
  gist: {
    async get(cfg) {
      if (!cfg.gistToken) throw new Error("Add your GitHub token first.");
      let id = cfg.gistId;
      if (!id) {   // another browser may have created the sync gist already: look for it
        for (let page = 1; page <= 5 && !id; page++) {
          const r = await fetch(`${GH_API}/gists?per_page=100&page=${page}`, { headers: ghHeaders(cfg), cache: "no-store" });
          if (!r.ok) throw await httpError("GitHub", r);
          const list = await r.json();
          const hit = list.find(g => g.files && g.files[SYNC_FILE]);
          if (hit) id = hit.id;
          if (list.length < 100) break;
        }
        if (id) await saveSyncConfig({ gistId: id });
      }
      if (!id) return null;
      const r = await fetch(`${GH_API}/gists/${id}`, { headers: ghHeaders(cfg), cache: "no-store" });
      if (r.status === 404) { await saveSyncConfig({ gistId: null }); return null; }
      if (!r.ok) throw await httpError("GitHub", r);
      const f = (await r.json()).files[SYNC_FILE];
      if (!f) return null;
      return f.truncated ? (await fetch(f.raw_url, { cache: "no-store" })).text() : f.content;
    },
    async put(cfg, text) {
      const gistId = await decryptSecret((await getSyncConfig()).gistIdEnc);
      const body = { files: { [SYNC_FILE]: { content: text } } };
      if (gistId) {
        const r = await fetch(`${GH_API}/gists/${gistId}`, { method: "PATCH", headers: ghHeaders(cfg), body: JSON.stringify(body) });
        if (!r.ok) throw await httpError("GitHub", r);
      } else {
        const r = await fetch(`${GH_API}/gists`, { method: "POST", headers: ghHeaders(cfg),
          body: JSON.stringify({ description: "Tab Workflows sync (encrypted)", public: false, ...body }) });
        if (!r.ok) throw await httpError("GitHub", r);
        await saveSyncConfig({ gistId: (await r.json()).id });
      }
    }
  },
  server: {
    async url(cfg) {
      if (!cfg.serverUrl) throw new Error("Add your server address first.");
      if (!cfg.syncId) throw new Error("Set a passphrase first.");
      return `${cfg.serverUrl.replace(/\/+$/, "")}/v1/${cfg.syncId}`;
    },
    async get(cfg) {
      const r = await fetch(await this.url(cfg), { cache: "no-store" });
      if (r.status === 404) return null;
      if (!r.ok) throw await httpError("Your server", r);
      return r.text();
    },
    async put(cfg, text) {
      const r = await fetch(await this.url(cfg), { method: "PUT", headers: { "Content-Type": "application/json" }, body: text });
      if (!r.ok) throw await httpError("Your server", r);
    }
  },
  // WebDAV: through webdav.js – the same client the Sync page's Connect uses.
  webdav: {
    async get(cfg) {
      if (!cfg.webdavUrl) throw new Error("Add your WebDAV folder address first.");
      return WebDAV.read({ url: cfg.webdavUrl, user: cfg.webdavUser, pass: cfg.webdavPass });
    },
    async put(cfg, text) {
      await WebDAV.write({ url: cfg.webdavUrl, user: cfg.webdavUser, pass: cfg.webdavPass }, text);
    }
  }
};

// One sync run for gist / server / webdav. `force`: skip the download and overwrite the synced copy
// with this browser's workflows (used after changing the passphrase).
// `passphrase`: only passed right after you typed it (to read a file an older version wrote, once).
async function multiSyncNow({ force = false, passphrase = "" } = {}) {
  const s = await getSettings();
  const method = s.syncMethod;
  if (!AUTO_SYNC_METHODS.includes(method)) return null;
  const stored = await protectSyncConfig(await getSyncConfig());
  if (!stored.hasPassphrase) return setMultiSyncStatus({ ok: false, method, error: "Set a passphrase first." });
  const cfg = await unlockSyncConfig(stored);     // logins decrypted in memory, only for this run
  const provider = SYNC_PROVIDERS[method];
  try {
    const text = force ? null : await provider.get(cfg);
    const remote = text ? await openSyncStored(text, cfg, passphrase) : null;
    const payload = force ? await buildSyncPayload() : await mergeRemote(remote);
    let uploaded = false;
    if (force || !remote || !sameSyncContent(remote, payload)) {
      await provider.put(cfg, await sealSyncStored(payload, cfg));
      uploaded = true;
    }
    return setMultiSyncStatus({ ok: true, method, uploaded, workflows: Object.keys(payload.workflows || {}).length,
                                fromOther: !!(remote && remote.device && remote.device !== payload.device),
                                newSpace: !force && !text });   // nothing was synced yet (with this passphrase)
  } catch (e) {
    return setMultiSyncStatus({ ok: false, method, error: String((e && e.message) || e) });
  }
}

// For the shared folder (done by the Session Manager page): merge what it read, return what to write.
async function syncMergeRemote({ remote = null } = {}) {
  return mergeRemote(remote);
}

// Sync shortly after changes (`syncDelay`), and every `syncInterval` minutes.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || syncApplying) return;
  if (!(ch.workflows || ch.looseTabs || ch.tombstones || ch.pinnedTabs || (ch.settingsAt && settings.syncSettings))) return;
  if (AUTO_SYNC_METHODS.includes(settings.syncMethod)) {
    chrome.alarms.create("msync-soon", { delayInMinutes: Math.max(0.5, Number(settings.syncDelay) || DEFAULT_SETTINGS.syncDelay) });
  }
});
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === "msync" || a.name === "msync-soon") enqueue(() => multiSyncNow());
});

// ======================= Dividers =======================
// Two kinds:
//   divider tab – a tiny page of this extension (divider.html#t=Text&c=colour) that shows in the tab strip.
//                 All extension pages share one process, and it's put to sleep (discarded) whenever you're
//                 not on it, so it costs next to no memory.
//   label       – shown only in the Session Manager, above a tab (stored as `section` on that tab).
const DIVIDER_PAGE = chrome.runtime.getURL("divider.html");
const DIVIDER_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const DIVIDER_ANY = /^chrome-extension:\/\/[a-z]{32}\/divider\.html/i;
const isDividerUrl = url => DIVIDER_ANY.test(url || "");
const cleanColor = c => (DIVIDER_COLORS.includes(c) ? c : "grey");

function dividerUrl(text, color, icon = "") {
  const p = new URLSearchParams();
  if (text) p.set("t", String(text).slice(0, 80));
  p.set("c", cleanColor(color));
  if (icon) p.set("i", String(icon).slice(0, 24));
  return DIVIDER_PAGE + "#" + p.toString();
}
function dividerInfo(url) {
  const p = new URLSearchParams(String(url || "").split("#")[1] || "");
  return { text: p.get("t") || "", color: cleanColor(p.get("c")), icon: p.get("i") || "" };
}
function dividerTitle(text) { return text ? `── ${text} ──` : "────────"; }

// Dividers made in another browser (where the extension has another id) point at this one.
function localizeDividers(windows) {
  (windows || []).forEach(w => (w.tabs || []).forEach(t => {
    if (isDividerUrl(t.url) && !t.url.startsWith(DIVIDER_PAGE)) t.url = t.url.replace(DIVIDER_ANY, DIVIDER_PAGE);
  }));
}

function sleepDivider(tab) {
  if (settings.dividerSleep === false || !tab || tab.active || tab.discarded || tab.status !== "complete") return;
  if (!(tab.url || "").startsWith(DIVIDER_PAGE)) return;
  chrome.tabs.discard(tab.id).catch(() => {});
}
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === "complete" && (tab.url || "").startsWith(DIVIDER_PAGE)) {
    setTimeout(() => chrome.tabs.get(tabId).then(sleepDivider, () => {}), 400);
  }
});
// Leaving a divider puts it back to sleep.
chrome.tabs.onActivated.addListener(({ windowId }) => {
  if (settings.dividerSleep === false) return;
  chrome.tabs.query({ windowId, discarded: false }).then(tabs => tabs.forEach(sleepDivider), () => {});
});

// Add a divider before tab `idx` of window `win` (at the end when idx is missing).
async function addDivider({ id, win = 0, idx, text = "", color = "grey", kind = "tab" }) {
  const { workflows } = await loadState();
  const wf = workflows[id];
  if (!wf) throw new Error("Workflow not found");
  text = String(text || "").trim().slice(0, 80);
  color = cleanColor(color);
  wf.windows = wf.windows || [];
  if (kind === "label") {
    const t = wf.windows[win] && wf.windows[win].tabs[idx];
    if (!t) throw new Error("A label needs a tab below it");
    t.section = { text, color };
    wf.savedAt = Date.now();
    await persist({ workflows });
    return true;
  }
  const wi = Math.min(win, wf.windows.length);
  if (!wf.windows[wi]) wf.windows[wi] = { tabs: [], activeIndex: 0 };
  const w = wf.windows[wi];
  const at = idx === undefined || idx === null ? w.tabs.length : Math.max(0, Math.min(idx, w.tabs.length));
  const url = dividerUrl(text, color);
  const layout = await liveLayoutFor(id);
  const lw = layout && layout[wi];
  w.tabs.splice(at, 0, { url, title: dividerTitle(text), pinned: false, favIconUrl: "" });
  if (at <= (w.activeIndex || 0) && w.tabs.length > 1) w.activeIndex = (w.activeIndex || 0) + 1;
  wf.savedAt = Date.now();
  await persist({ workflows });
  if (lw) {
    const ref = lw.tabs[at];
    const index = ref ? ref.index : (lw.tabs.length ? lw.tabs[lw.tabs.length - 1].index + 1 : undefined);
    await chrome.tabs.create({ windowId: lw.windowId, url, active: false, ...(index !== undefined ? { index } : {}) }).catch(() => {});
  } else if (layout && !lw) {
    const w2 = await chrome.windows.create({ url, focused: false }).catch(() => null);
    if (w2) await mapWindow(w2.id, id);
  }
  return true;
}

// Change a divider's text / colour (a divider tab or a label).
async function editDivider({ id, win, idx, text = "", color = "grey", kind = "tab" }) {
  const { workflows } = await loadState();
  const t = workflows[id] && workflows[id].windows[win] && workflows[id].windows[win].tabs[idx];
  if (!t) return;
  text = String(text || "").trim().slice(0, 80);
  color = cleanColor(color);
  if (kind === "label") {
    t.section = { text, color };
    workflows[id].savedAt = Date.now();
    await persist({ workflows });
    return;
  }
  const layout = await liveLayoutFor(id);
  const live = layout && layout[win] ? layout[win].tabs[idx] : null;
  t.url = dividerUrl(text, color, dividerInfo(t.url).icon);   // keep the icon picked on the tab
  t.title = dividerTitle(text);
  workflows[id].savedAt = Date.now();
  await persist({ workflows });
  if (live) await chrome.tabs.update(live.id, { url: t.url }).catch(() => {});
}

async function removeLabel({ id, win, idx }) {
  const { workflows } = await loadState();
  const t = workflows[id] && workflows[id].windows[win] && workflows[id].windows[win].tabs[idx];
  if (!t || !t.section) return;
  delete t.section;
  workflows[id].savedAt = Date.now();
  await persist({ workflows });
}

// Popup / keyboard shortcut: open a divider tab right after the tab you're on (it opens so you can name it).
async function insertDividerTab({ text = "", color = "grey" } = {}) {
  const [cur] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const opts = { url: dividerUrl(text, color), active: true };
  if (cur && cur.windowId !== undefined) { opts.windowId = cur.windowId; opts.index = cur.index + 1; }
  await chrome.tabs.create(opts).catch(() => chrome.tabs.create({ url: opts.url, active: true }));
  return true;
}

chrome.commands && chrome.commands.onCommand.addListener(cmd => {
  if (cmd === "insert-divider") enqueue(() => insertDividerTab());
  if (cmd === "open-manager") focusOrOpenManager().catch(() => {});
});

// Shortcut: bring the Session Manager to the front (without reloading it), or open it in a new tab.
async function focusOrOpenManager() {
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(t => (t.url || t.pendingUrl || "").startsWith(MANAGER_URL));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: MANAGER_URL });
  }
}

// ======================= Backup copies of each workflow =======================
// Every workflow keeps its last 3 earlier versions (in this browser only, not synced).
// A copy is taken when the tabs change and the newest copy is at least 30 minutes old –
// or right away when a change removes half of the tabs or more.
const WF_COPIES = 3;
const WF_COPY_GAP = 30 * 60e3;
let copiesQueue = Promise.resolve();
const tabCount = wf => (wf && wf.windows || []).reduce((n, w) => n + (w.tabs || []).length, 0);

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !ch.workflows) return;
  const before = ch.workflows.oldValue || {}, after = ch.workflows.newValue || {};
  copiesQueue = copiesQueue.then(() => keepWorkflowCopies(before, after)).catch(() => {});
});

async function keepWorkflowCopies(before, after) {
  const { wfCopies = {} } = await chrome.storage.local.get("wfCopies");
  let changed = false;
  for (const [id, old] of Object.entries(before)) {
    const now = after[id];
    if (!old || !tabCount(old)) continue;
    if (now && tabShape(now.windows) === tabShape(old.windows)) continue;
    const list = wfCopies[id] || [];
    const newest = list[0];
    if (newest && tabShape(newest.windows) === tabShape(old.windows)) continue;
    const bigDrop = !now || (tabCount(old) >= 4 && tabCount(now) <= tabCount(old) / 2);
    if (newest && Date.now() - newest.at < WF_COPY_GAP && !bigDrop) continue;
    list.unshift({ at: old.savedAt || Date.now(), takenAt: Date.now(), name: old.name, icon: old.icon,
                   windows: JSON.parse(JSON.stringify(old.windows || [])) });
    wfCopies[id] = list.slice(0, WF_COPIES);
    changed = true;
  }
  // Forget copies of workflows that are gone for more than 30 days.
  for (const id of Object.keys(wfCopies)) {
    if (!after[id] && wfCopies[id][0] && Date.now() - (wfCopies[id][0].takenAt || 0) > 30 * 86400e3) { delete wfCopies[id]; changed = true; }
  }
  if (changed) await chrome.storage.local.set({ wfCopies });
}

// Put a workflow's tabs back to one of its backup copies (the current tabs become a copy themselves).
async function restoreWorkflowCopy({ id, index = 0 }) {
  const { wfCopies = {} } = await chrome.storage.local.get("wfCopies");
  const copy = (wfCopies[id] || [])[index];
  const { workflows } = await loadState();
  if (!copy || !workflows[id]) throw new Error("Backup copy not found");
  const windows = JSON.parse(JSON.stringify(copy.windows || []));
  localizeDividers(windows);
  // The version being replaced is always kept as a copy, even if one was taken a moment ago.
  const cur = workflows[id];
  if (tabCount(cur)) {
    const list = (wfCopies[id] || []).filter((_, i) => i !== index);
    list.unshift({ at: cur.savedAt || Date.now(), takenAt: Date.now(), name: cur.name, icon: cur.icon,
                   windows: JSON.parse(JSON.stringify(cur.windows || [])) });
    wfCopies[id] = list.slice(0, WF_COPIES);
    await chrome.storage.local.set({ wfCopies });
  }
  cur.windows = windows;
  cur.savedAt = Date.now();
  const live = await liveLayoutFor(id);
  await persist({ workflows });
  if (live) await syncLiveTo(id, windows);
  return tabCount(cur);
}

// ======================= Versions across synced browsers =======================
// Each browser writes its version into the sync file; the newest one also adds its changelog.
// A browser that finds a newer version elsewhere shows an "Update available" screen with what changed.
const MY_VERSION = chrome.runtime.getManifest().version;
let lastRemoteVersions = { devices: {}, notes: null };

function cmpVersion(a, b) {
  const pa = String(a || "0").split(".").map(Number), pb = String(b || "0").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function browserName() {
  try {
    const brands = (navigator.userAgentData && navigator.userAgentData.brands || []).map(b => b.brand)
      .filter(b => !/not.?a.?brand/i.test(b));
    return brands.find(b => !/^chromium$/i.test(b)) || brands[0] || "Chromium browser";
  } catch (_) { return "Chromium browser"; }
}

let changelogText = null;
async function myChangelog() {
  if (changelogText === null) {
    try { changelogText = await (await fetch(chrome.runtime.getURL("CHANGELOG.md"))).text(); } catch (_) { changelogText = ""; }
  }
  return changelogText;
}

async function addVersionInfo(payload) {
  const me = await getDeviceId();
  const devices = { ...(lastRemoteVersions.devices || {}) };
  const prev = devices[me];
  devices[me] = prev && prev.version === MY_VERSION ? prev : { version: MY_VERSION, browser: browserName(), at: Date.now() };
  payload.devices = devices;
  const notes = lastRemoteVersions.notes;
  if (!notes || cmpVersion(MY_VERSION, notes.version) > 0) {
    const text = await myChangelog();
    payload.notes = text ? { version: MY_VERSION, text } : notes || undefined;
  } else payload.notes = notes;
  if (!payload.notes) delete payload.notes;
}

async function checkVersions(remote) {
  lastRemoteVersions = { devices: (remote && remote.devices) || {}, notes: (remote && remote.notes) || null };
  const me = await getDeviceId();
  let newest = null;
  for (const [id, d] of Object.entries(lastRemoteVersions.devices)) {
    if (id === me || !d || !d.version) continue;
    if (cmpVersion(d.version, MY_VERSION) > 0 && (!newest || cmpVersion(d.version, newest.version) > 0)) newest = d;
  }
  const { updateNotice = null } = await chrome.storage.local.get("updateNotice");
  if (!newest) {
    if (updateNotice) await chrome.storage.local.remove("updateNotice");
    return;
  }
  const notes = lastRemoteVersions.notes && cmpVersion(lastRemoteVersions.notes.version, MY_VERSION) > 0 ? lastRemoteVersions.notes.text : "";
  const next = { mine: MY_VERSION, latest: newest.version, browser: newest.browser || "another browser", notes,
                 dismissed: updateNotice && updateNotice.latest === newest.version ? !!updateNotice.dismissed : false };
  if (scCanon(next) !== scCanon(updateNotice)) await chrome.storage.local.set({ updateNotice: next });
}

// You moved the name with ◀ ▶ on a divider: the other dividers refit too (they wake for a moment and
// go back to sleep). The one you're on refits by itself.
let refitAllTimer = null;
function refitSleepingDividers() {
  clearTimeout(refitAllTimer);
  refitAllTimer = setTimeout(async () => {
    const tabs = await chrome.tabs.query({}).catch(() => []);
    for (const t of tabs) if ((t.url || "").startsWith(DIVIDER_PAGE) && !t.active) chrome.tabs.reload(t.id).catch(() => {});
  }, 1200);
}
