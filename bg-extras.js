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
    await chrome.storage.local.set({ history: history.slice(0, HISTORY_MAX) });
  });
}

if (HAS_GROUPS) {
  const onGroupChange = () => scheduleSave();
  chrome.tabGroups.onCreated.addListener(onGroupChange);
  chrome.tabGroups.onUpdated.addListener(onGroupChange);
  chrome.tabGroups.onRemoved.addListener(g => { onGroupChange(); onGroupRemoved(g); });
}

// ======================= Undo history =======================
const HISTORY_MAX = 25;

// Things the Session Manager and the popup can undo, with a readable label.
const UNDOABLE = new Set([
  "deleteWorkflow", "removeTab", "removeTabs", "moveTab", "moveTabs", "clearWorkflow", "dedupeWorkflow",
  "sortWorkflow", "editTab", "editWorkflow", "addTab", "createEmptyWorkflow", "importWorkflows",
  "clearAllData", "restoreFromTrash", "restoreBackup"
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
    case "editWorkflow": return `Edit ${n(p.id)}`;
    case "addTab": return `Add a tab to ${n(p.id)}`;
    case "createEmptyWorkflow": return `Create “${p.name || "Untitled"}”`;
    case "importWorkflows": return "Import workflows";
    case "clearAllData": return "Delete everything";
    case "restoreFromTrash": return "Restore from trash";
    case "restoreBackup": return "Restore a backup";
    default: return "Change";
  }
}

async function pushHistory(label) {
  const { workflows = {}, looseTabs = [], history = [] } = await chrome.storage.local.get(["workflows", "looseTabs", "history"]);
  history.unshift({ at: Date.now(), label, workflows, looseTabs });
  await chrome.storage.local.set({ history: history.slice(0, HISTORY_MAX) });
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
  clearTimeout(saveTimer);
  switching = true;
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
    switching = false;
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
const TRASH_DAYS = 30;

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
  const keep = trash.filter(e => Date.now() - e.at < TRASH_DAYS * 864e5);
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
  chrome.alarms.create("msync", { delayInMinutes: 1, periodInMinutes: 5 });      // multi-browser sync
}

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
  const { workflows = {}, looseTabs = [] } = await chrome.storage.local.get(["workflows", "looseTabs"]);
  const device = await getDeviceId();
  const at = Date.now();
  const b64 = await gzipB64(JSON.stringify({ v: 1, at, device, workflows, looseTabs }));
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

// Bring workflows from the synced copy: "merge" adds/updates, "replace" swaps everything.
async function syncPull({ mode = "merge" }) {
  const meta = (await chrome.storage.sync.get("sync_meta")).sync_meta;
  if (!meta) throw new Error("Nothing has been synced yet");
  const keys = Array.from({ length: meta.chunks }, (_, i) => "sync_" + i);
  const got = await chrome.storage.sync.get(keys);
  const remote = JSON.parse(await gunzipB64(keys.map(k => got[k] || "").join("")));
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
  if (area !== "local" || !(ch.workflows || ch.looseTabs)) return;
  if (settings.syncMethod === "chrome") chrome.alarms.create("sync-push", { delayInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === "daily-backup") enqueue(autoBackup);
  if (a.name === "sync-push") enqueue(syncNow);
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

async function getSyncConfig() {
  const { syncConfig = {} } = await chrome.storage.local.get("syncConfig");
  return syncConfig;
}
async function saveSyncConfig(patch) {
  const cfg = await getSyncConfig();
  await chrome.storage.local.set({ syncConfig: { ...cfg, ...patch } });
}
async function setMultiSyncStatus(st) {
  const status = { at: Date.now(), ...st };
  await chrome.storage.local.set({ multiSyncStatus: status });
  return status;
}

async function buildSyncPayload() {
  const { workflows = {}, looseTabs = [], tombstones = {} } = await chrome.storage.local.get(["workflows", "looseTabs", "tombstones"]);
  return { v: 2, at: Date.now(), device: await getDeviceId(), workflows, looseTabs, tombstones };
}

// Merge the synced copy into this browser and return what should be synced back.
async function mergeRemote(remote) {
  if (remote && remote.workflows) {
    const { workflows = {}, looseTabs = [], tombstones = {}, activeWorkflowId = null } =
      await chrome.storage.local.get(["workflows", "looseTabs", "tombstones", "activeWorkflowId"]);
    const tomb = { ...tombstones };
    for (const [id, at] of Object.entries(remote.tombstones || {})) tomb[id] = Math.max(tomb[id] || 0, at || 0);
    const merged = {};
    for (const id of new Set([...Object.keys(workflows), ...Object.keys(remote.workflows)])) {
      const l = workflows[id], r = remote.workflows[id];
      let pick = !l ? r : !r ? l : ((r.savedAt || 0) > (l.savedAt || 0) ? r : l);
      // The workflow that's open here keeps what's open here (it'll be synced from this browser).
      if (l && pick === r && id === activeWorkflowId && (await liveLayoutFor(id))) pick = l;
      if (tomb[id] && tomb[id] >= (pick.savedAt || 0)) continue;     // deleted somewhere, after its last change
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
  }
  return buildSyncPayload();
}

// ---- where the encrypted file lives ----
const GH_API = "https://api.github.com";
const ghHeaders = cfg => ({ Authorization: `Bearer ${cfg.gistToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });
const httpError = async (who, r) => {
  const hint = r.status === 401 || r.status === 403 ? " – check the token / password." : r.status === 404 ? " – check the address." : "";
  return new Error(`${who} answered ${r.status} ${r.statusText || ""}${hint}`.trim());
};
const webdavFileUrl = cfg => /\.json$/i.test(cfg.webdavUrl || "") ? cfg.webdavUrl : String(cfg.webdavUrl || "").replace(/\/?$/, "/") + SYNC_FILE;
const webdavAuth = cfg => ({ Authorization: "Basic " + b64utf8(`${cfg.webdavUser || ""}:${cfg.webdavPass || ""}`) });

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
      const { gistId } = await getSyncConfig();
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
      return `${cfg.serverUrl.replace(/\/+$/, "")}/v1/${await syncIdFor(cfg.passphrase)}`;
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
  webdav: {
    async get(cfg) {
      if (!cfg.webdavUrl) throw new Error("Add your WebDAV folder address first.");
      const r = await fetch(webdavFileUrl(cfg), { headers: webdavAuth(cfg), cache: "no-store" });
      if (r.status === 404) return null;
      if (!r.ok) throw await httpError("WebDAV", r);
      return r.text();
    },
    async put(cfg, text) {
      const r = await fetch(webdavFileUrl(cfg), { method: "PUT", headers: { ...webdavAuth(cfg), "Content-Type": "application/json" }, body: text });
      if (!r.ok) throw await httpError("WebDAV", r);
    }
  }
};

// One sync run for gist / server / webdav. `force`: skip the download and overwrite the synced copy
// with this browser's workflows (used after changing the passphrase).
async function multiSyncNow({ force = false } = {}) {
  const s = await getSettings();
  const method = s.syncMethod;
  if (!AUTO_SYNC_METHODS.includes(method)) return null;
  const cfg = await getSyncConfig();
  if (!cfg.passphrase) return setMultiSyncStatus({ ok: false, method, error: "Set a passphrase first." });
  const provider = SYNC_PROVIDERS[method];
  try {
    const text = force ? null : await provider.get(cfg);
    const remote = text ? await openSync(text, cfg.passphrase) : null;
    const payload = force ? await buildSyncPayload() : await mergeRemote(remote);
    let uploaded = false;
    if (force || !remote || !sameSyncContent(remote, payload)) {
      await provider.put(cfg, await sealSync(payload, cfg.passphrase));
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

// Sync shortly after changes, and every 5 minutes.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || syncApplying || !(ch.workflows || ch.looseTabs || ch.tombstones)) return;
  if (AUTO_SYNC_METHODS.includes(settings.syncMethod)) chrome.alarms.create("msync-soon", { delayInMinutes: 0.5 });
});
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === "msync" || a.name === "msync-soon") enqueue(() => multiSyncNow());
});
