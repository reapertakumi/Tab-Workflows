// Applies theme/accent/background/density to <html> and builds the theme toggle.
// Needs settings.js (and icons.js for themeToggle) loaded first.
const THEME_CACHE_KEY = "tm-settings";

function applyAppearance(s) {
  const r = document.documentElement;
  if (s.theme === "light" || s.theme === "dark") r.dataset.theme = s.theme;
  else delete r.dataset.theme;
  r.dataset.accent = s.accent || "mono";
  r.dataset.bg = s.background || "plain";
  r.dataset.density = s.density || "comfortable";
}

// Fast path: apply the cached settings synchronously to avoid a flash of the wrong theme.
try {
  const cached = JSON.parse(localStorage.getItem(THEME_CACHE_KEY) || "null");
  if (cached) applyAppearance({ ...DEFAULT_SETTINGS, ...cached });
} catch (_) {}

const settingsListeners = [];
let lastSettings = null;
// Listeners registered after settings already arrived get them immediately.
function onSettings(fn) {
  settingsListeners.push(fn);
  if (lastSettings) fn(lastSettings);
}

function publishSettings(s) {
  lastSettings = s;
  applyAppearance(s);
  try { localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(s)); } catch (_) {}
  settingsListeners.forEach(fn => fn(s));
}

getSettings().then(publishSettings);
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.settings) publishSettings({ ...DEFAULT_SETTINGS, ...(ch.settings.newValue || {}) });
});

// One button that cycles System → Light → Dark; its icon shows the current choice.
const THEME_CYCLE = [
  ["system", "monitor", "System"],
  ["light", "sun", "Light"],
  ["dark", "moon", "Dark"]
];

function themeToggle() {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "iconbtn theme-btn";
  let current = "system";
  const paint = s => {
    current = s.theme || "system";
    const i = Math.max(0, THEME_CYCLE.findIndex(([v]) => v === current));
    const [, icon, label] = THEME_CYCLE[i];
    const next = THEME_CYCLE[(i + 1) % THEME_CYCLE.length][2];
    b.innerHTML = svgIcon(icon, 16);
    b.title = `Theme: ${label} (click for ${next})`;
    b.setAttribute("aria-label", b.title);
  };
  b.addEventListener("click", () => {
    const i = Math.max(0, THEME_CYCLE.findIndex(([v]) => v === current));
    const next = THEME_CYCLE[(i + 1) % THEME_CYCLE.length][0];
    paint({ theme: next });          // instant feedback
    setSetting("theme", next);
  });
  onSettings(paint);
  try { paint({ ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(THEME_CACHE_KEY) || "{}") }); } catch (_) { paint(DEFAULT_SETTINGS); }
  return b;
}
