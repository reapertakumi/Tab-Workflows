// Shared settings (used by background, popup and manager). No DOM access here.
const DEFAULT_SETTINGS = {
  // appearance
  theme: "system",          // "system" | "light" | "dark"
  accent: "mono",           // "mono" | "blue" | "violet" | "green" | "orange" | "rose"
  background: "plain",      // manager background: "plain" | "dots" | "gradient"
  density: "comfortable",   // "comfortable" | "compact"
  display: "board",         // manager layout: "board" | "list" | "canvas"
  boardWidth: 320,          // column width in Board layout (px)
  boardZoom: 1,             // Ctrl + scroll zoom for Board / List layouts
  // backups
  backupMode: "local",      // "off" | "local" (keep last backups inside Tab Workflows) | "file" (also save to Downloads)
  syncMethod: "off",        // "off" | "chrome" (Chrome profile) | "folder" | "gist" | "server" | "webdav"
  // saving
  autosaveEnabled: true,    // master switch for all autosaving
  autosaveDelay: 400,       // ms to wait after the last tab change
  newWorkflowAutosave: true,
  skipNewTabs: false,       // don't store empty New Tab pages
  // switching
  switchMode: "replace",    // "replace" = swap tabs in the current window | "windows" = each workflow in its own window
  lazyLoad: true,          // only the visible tab loads; others load when clicked
  confirmSwitch: false,
  keepManagerOpen: true
};

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const out = { ...DEFAULT_SETTINGS, ...settings };
  if (!settings.syncMethod && settings.syncEnabled) out.syncMethod = "chrome";   // older "Sync with Chrome" switch
  return out;
}

// Workflows that are open in a browser window right now.
function openWorkflowIds({ activeWorkflowId = null, openWindows = {} }) {
  const ids = new Set(Object.values(openWindows || {}));
  if (activeWorkflowId) ids.add(activeWorkflowId);
  return ids;
}

// What to tell the user before switching from what's open now to `target`.
// risky = something would be lost, so always confirm (even when "Ask before switching" is off).
function switchNotice({ workflows = {}, activeWorkflowId = null }, s, target) {
  if (s.switchMode === "windows") {
    return { risky: false, text: `“${target.name}” will be opened in a new window. Your current workflow stays open.` };
  }
  const active = workflows[activeWorkflowId];
  if (active && active.autosave !== false && s.autosaveEnabled) {
    return { risky: false, text: `Your current workflow will be closed and “${target.name}” will be opened.` };
  }
  if (active) {
    return { risky: true, saveId: active.id,
      text: `Your current workflow will be closed and “${target.name}” will be opened. Autosave is ${s.autosaveEnabled ? "off" : "paused"} for “${active.name}”, so changes since its last save would be lost.` };
  }
  return { risky: true, saveAsNew: true,
    text: `Your current tabs aren’t in a workflow. They’ll be closed and “${target.name}” will be opened.` };
}

// Serialized so quick successive changes (e.g. theme then accent) never overwrite each other.
let settingsWriteQueue = Promise.resolve();
function setSetting(key, value) {
  const run = settingsWriteQueue.then(async () => {
    const s = await getSettings();
    s[key] = value;
    await chrome.storage.local.set({ settings: s });
    return s;
  });
  settingsWriteQueue = run.catch(() => {});
  return run;
}
