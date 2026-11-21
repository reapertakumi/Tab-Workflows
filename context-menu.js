// Right-click menu (Chrome groups these under "Tab Workflows"):
//   on a page:  "Send to ▸ <workflow>"      – saves the page into the workflow and closes the tab
//               "Copy to ▸ <workflow>"      – saves the page into the workflow, the tab stays open
//   on a link:  "Save link to ▸ <workflow>" – saves the link into the workflow
// Each lists every workflow plus Unsorted tabs. The page / link is added at the end of the workflow's
// first window. Undo works like any other change.
// Loaded by background.js (uses loadState, addTab, pushHistory, enqueue, ownerOf, settings, LOOSE …).

const MENU_SEND = "tw-send";
const MENU_COPY = "tw-copy";
const MENU_LINK = "tw-link";
const MENU_URLS = ["http://*/*", "https://*/*", "file:///*"];

let menuTimer = null;
let menuBuilding = Promise.resolve();

function scheduleMenuRebuild() {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(() => { menuBuilding = menuBuilding.then(buildContextMenus, buildContextMenus); }, 150);
}

const removeAllMenus = () => new Promise(r => chrome.contextMenus.removeAll(() => { void chrome.runtime.lastError; r(); }));
const createMenu = props => chrome.contextMenus.create(props, () => void chrome.runtime.lastError);

async function buildContextMenus() {
  if (!chrome.contextMenus) return;
  const { workflows = {} } = await chrome.storage.local.get("workflows");
  const list = Object.values(workflows).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  await removeAllMenus();

  for (const [parent, title, ctx, pattern] of [
    [MENU_SEND, "Send to", ["page"], "documentUrlPatterns"],
    [MENU_COPY, "Copy to", ["page"], "documentUrlPatterns"],
    [MENU_LINK, "Save link to", ["link"], "targetUrlPatterns"]
  ]) {
    createMenu({ id: parent, title, contexts: ctx, [pattern]: MENU_URLS });
    for (const wf of list) {
      // "&" marks an access key in menu titles – double it so names show as typed.
      createMenu({ id: `${parent}:${wf.id}`, parentId: parent, title: String(wf.name || "Untitled").replace(/&/g, "&&"), contexts: ctx });
    }
    if (list.length) createMenu({ id: `${parent}:sep`, parentId: parent, type: "separator", contexts: ctx });
    createMenu({ id: `${parent}:${LOOSE}`, parentId: parent, title: "Unsorted tabs", contexts: ctx });
  }
}

// A short ✓ (or •) on the toolbar icon so you know it worked without opening anything.
let badgeTimer = null;
function flashBadge(text, color, tabId) {
  const a = chrome.action;
  if (!a) return;
  const opts = tabId !== undefined ? { tabId } : {};
  a.setBadgeBackgroundColor({ ...opts, color }).catch(() => {});
  a.setBadgeText({ ...opts, text }).catch(() => {});
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => a.setBadgeText({ ...opts, text: "" }).catch(() => {}), 1800);
}

// Close the tab you sent away. If it's the last tab of its window, a New Tab takes its place first,
// so the window (and the workflow open in it) stays open.
async function closeSentTab(tab) {
  const siblings = await chrome.tabs.query({ windowId: tab.windowId }).catch(() => []);
  if (siblings.length <= 1) await chrome.tabs.create({ windowId: tab.windowId, active: true }).catch(() => {});
  await chrome.tabs.remove(tab.id).catch(() => {});
}

async function sendToWorkflow(info, tab) {
  const [parent, id] = String(info.menuItemId).split(/:(.+)/);
  if (!id || id === "sep") return;
  const isLink = parent === MENU_LINK;
  const move = parent === MENU_SEND;
  const url = isLink ? info.linkUrl : (info.pageUrl || (tab && tab.url));
  if (!url || !/^(https?:|file:)/i.test(url)) return;

  const { workflows } = await loadState();
  const wf = workflows[id];
  if (!wf) return;
  const tabId = tab && tab.id >= 0 ? tab.id : undefined;

  // The page is already in the workflow that's autosaving this window: copying would only add a duplicate,
  // and sending would close it and open it again in the same place – so do nothing.
  if (!isLink && tab && id !== LOOSE && wf.autosave !== false && settings.autosaveEnabled) {
    const { openWindows = {}, activeWorkflowId = null } = await chrome.storage.local.get(["openWindows", "activeWorkflowId"]);
    if (ownerOf(tab.windowId, openWindows, activeWorkflowId) === id) return flashBadge("•", "#8b8d98", tabId);
  }

  await pushHistory(`${isLink ? "Save a link" : move ? "Send a tab" : "Copy a tab"} to “${wf.name}”`);
  await addTab({
    id, win: 0, url,
    title: isLink ? (info.linkText || info.selectionText || "") : (tab && tab.title) || "",
    favIconUrl: !isLink && tab ? tab.favIconUrl || "" : ""
  });
  if (move && tabId !== undefined) {
    await closeSentTab(tab);
    flashBadge("✓", "#1f9d55");            // the tab is gone, so show it on every tab
  } else flashBadge("✓", "#1f9d55", tabId);
}

chrome.contextMenus && chrome.contextMenus.onClicked.addListener((info, tab) => {
  enqueue(() => sendToWorkflow(info, tab)).catch(() => flashBadge("!", "#d4372c"));
});

// Keep the list in step with your workflows (created, renamed, deleted, synced in).
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !ch.workflows) return;
  const names = v => JSON.stringify(Object.values(v || {}).map(w => [w.id, w.name, w.createdAt]));
  if (names(ch.workflows.oldValue) !== names(ch.workflows.newValue)) scheduleMenuRebuild();
});
chrome.runtime.onInstalled.addListener(scheduleMenuRebuild);
chrome.runtime.onStartup.addListener(scheduleMenuRebuild);
