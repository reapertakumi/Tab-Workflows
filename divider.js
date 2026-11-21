// Divider tab: everything lives in the address (#t=Text&c=colour&i=icon), so it needs no storage and
// survives being put to sleep. Kept tiny on purpose.
const COLORS = { grey: "#8b8d98", blue: "#1a73e8", red: "#d93025", yellow: "#f9ab00", green: "#188038",
                 pink: "#d01884", purple: "#a142f4", cyan: "#007b83", orange: "#fa903e" };
const input = document.getElementById("text");
const colors = document.getElementById("colors");

function read() {
  const p = new URLSearchParams(location.hash.slice(1));
  const c = p.get("c");
  const i = p.get("i");
  return { text: p.get("t") || "", color: COLORS[c] ? c : "grey", icon: ICON_PATHS[i] ? i : "" };
}

function write(text, color, icon = read().icon) {
  const p = new URLSearchParams();
  if (text) p.set("t", text);
  p.set("c", color);
  if (icon) p.set("i", icon);
  location.replace("#" + p.toString());   // no extra history entry
}

// The tab's icon: the picked icon in the divider's colour, or a coloured bar. It's a tiny inline SVG,
// so it costs nothing extra (and a sleeping tab keeps showing it).
function faviconSvg(icon, hex) {
  if (!icon) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1" y="6" width="14" height="4" rx="2" fill="${hex}"/></svg>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${hex}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON_PATHS[icon]}"/></svg>`;
}

function paint() {
  const { text, color, icon } = read();
  const hex = COLORS[color];
  fitTitle(text);
  document.documentElement.style.setProperty("--line", hex);
  document.getElementById("icon").href = "data:image/svg+xml," + encodeURIComponent(faviconSvg(icon, hex));
  for (const b of icons.children) b.classList.toggle("on", b.dataset.i === icon);
  if (document.activeElement !== input) input.value = text;
  for (const b of colors.children) b.classList.toggle("on", b.dataset.c === color);
}

// Icon picker above the name: the first one is the plain coloured bar.
const icons = document.getElementById("icons");
for (const name of ["", ...Object.keys(ICON_PATHS)]) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.i = name;
  b.title = name ? name[0].toUpperCase() + name.slice(1) : "Line (no icon)";
  b.innerHTML = name
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON_PATHS[name]}"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 16 16"><rect x="1" y="6" width="14" height="4" rx="2" fill="currentColor"/></svg>`;
  b.addEventListener("click", () => write(input.value.trim(), read().color, name));
  icons.append(b);
}

for (const [name, hex] of Object.entries(COLORS)) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.c = name;
  b.title = name[0].toUpperCase() + name.slice(1);
  b.style.background = hex;
  b.addEventListener("click", () => write(input.value.trim(), name));
  colors.append(b);
}

// The tab title is a line of dashes with the name in the middle. Letters and dashes have different widths,
// so the name is placed by its measured width (in the tab's font), not by counting characters:
// its middle always lands where the middle of "Work" lands with 10 dashes in front (which looks centred).
// Dashes do the coarse spacing, hair spaces (in front of the line) the last few pixels.
const DASH = "─", HAIR = " ", ZWSP = "​";
const TITLE_CHARS = 32;   // length of a title without a name
let measureCtx = null;
function textWidth(s) {
  if (!measureCtx) {
    measureCtx = document.createElement("canvas").getContext("2d");
    measureCtx.font = "12px 'Segoe UI', system-ui, -apple-system, sans-serif";   // the browser's tab font
  }
  return measureCtx.measureText(s).width;
}
function fitTitle(text) {
  if (!text) { document.title = DASH.repeat(TITLE_CHARS); return; }
  const dash = textWidth(DASH) || 8, space = textWidth(" ") || 3, hair = textWidth(HAIR) || 1;
  const center = 10 * dash + space + textWidth("Work") / 2;          // where the name's middle goes
  const name = textWidth(text);
  const room = Math.max(0, center - space - name / 2);               // pixels before the space in front of the name
  const before = Math.max(1, Math.floor(room / dash));
  const pads = Math.min(12, Math.max(0, Math.round((room - before * dash) / hair)));   // hair spaces close the rest
  const used = before * dash + pads * hair + space + name + space;
  const after = Math.max(2, Math.ceil((2 * center - used) / dash) + 6);   // to the edge and a bit past it
  // The hair spaces go first (next to the tab icon), so there's no visible gap next to the name. The browser
  // trims spaces (hair spaces too) off the ends of a tab title, so an invisible zero-width character
  // (not a space) goes in front of them.
  document.title = (pads ? ZWSP + HAIR.repeat(pads) : "") + DASH.repeat(before) + " " + text + " " + DASH.repeat(after);
}

let timer;
input.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(() => write(input.value.trim(), read().color), 500);
});
input.addEventListener("keydown", e => { if (e.key === "Enter") { clearTimeout(timer); write(input.value.trim(), read().color); input.blur(); } });
window.addEventListener("hashchange", paint);
paint();
if (!read().text) input.focus();
