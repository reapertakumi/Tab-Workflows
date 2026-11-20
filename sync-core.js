// Tab Workflows – encrypted sync files, shared by the background and the Session Manager page.
// Everything is compressed and encrypted with your passphrase (AES-256-GCM, key from PBKDF2-SHA256)
// before it leaves the browser, so the place it's stored (a folder, GitHub, your server, WebDAV)
// only ever sees unreadable data.

const SYNC_FILE = "tab-workflows-sync.json";
const SYNC_APP = "tab-workflows-sync";
const SYNC_ITERATIONS = 210000;

function scB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function scUnB64(str) {
  const bin = atob(str);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
async function scGzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function scGunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}
async function scKey(passphrase, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: SYNC_ITERATIONS, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// Data -> encrypted text (the sync file's content).
async function sealSync(data, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await scKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, await scGzip(JSON.stringify(data)));
  return JSON.stringify({ app: SYNC_APP, v: 1, kdf: `PBKDF2-SHA256-${SYNC_ITERATIONS}`, cipher: "AES-256-GCM",
                          salt: scB64(salt), iv: scB64(iv), data: scB64(new Uint8Array(ct)) });
}

// Encrypted text -> data. Throws a readable error for a wrong passphrase or a foreign file.
async function openSync(text, passphrase) {
  let env;
  try { env = JSON.parse(text); } catch (_) { throw new Error("The synced file isn’t a Tab Workflows sync file."); }
  if (!env || env.app !== SYNC_APP) throw new Error("The synced file isn’t a Tab Workflows sync file.");
  const key = await scKey(passphrase, scUnB64(env.salt));
  let plain;
  try { plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: scUnB64(env.iv) }, key, scUnB64(env.data)); }
  catch (_) { throw new Error("Wrong passphrase – it has to be the same in every browser."); }
  return JSON.parse(await scGunzip(new Uint8Array(plain)));
}

// Name used on your own server: derived from the passphrase, so browsers with the same passphrase
// find the same data without any account.
async function syncIdFor(passphrase) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("tab-workflows-sync:" + passphrase));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

// Same workflows/tabs/deletions? (ignores the time stamp and which device wrote it)
function scCanon(x) {
  if (Array.isArray(x)) return "[" + x.map(scCanon).join(",") + "]";
  if (x && typeof x === "object") return "{" + Object.keys(x).sort().map(k => JSON.stringify(k) + ":" + scCanon(x[k])).join(",") + "}";
  return JSON.stringify(x === undefined ? null : x);
}
function sameSyncContent(a, b) {
  if (!a || !b) return false;
  const pick = d => ({ w: d.workflows || {}, l: d.looseTabs || [], t: d.tombstones || {} });
  return scCanon(pick(a)) === scCanon(pick(b));
}
