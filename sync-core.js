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

// Same workflows/tabs/deletions/settings? (ignores the time stamp and which device wrote it)
function scCanon(x) {
  if (Array.isArray(x)) return "[" + x.map(scCanon).join(",") + "]";
  if (x && typeof x === "object") return "{" + Object.keys(x).sort().map(k => JSON.stringify(k) + ":" + scCanon(x[k])).join(",") + "}";
  return JSON.stringify(x === undefined ? null : x);
}
function sameSyncContent(a, b) {
  if (!a || !b) return false;
  const pick = d => ({ w: d.workflows || {}, l: d.looseTabs || [], t: d.tombstones || {},
                       s: d.settings || null, sa: d.settingsAt || 0, dv: d.devices || null, n: d.notes ? d.notes.version : null });
  return scCanon(pick(a)) === scCanon(pick(b));
}

// ======================= The passphrase is never stored =======================
// When you save it, it's turned (PBKDF2-SHA256, 210 000 rounds) into the encryption key, which is kept as a
// non-exportable key in this browser's IndexedDB. Only hashes of the passphrase are kept: the salt and
// the server id. Neither can be turned back into the passphrase.
const SECRET_DB = "tab-workflows-secrets";

function secretDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(SECRET_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("keys");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function secretKeyGet(name) {
  const db = await secretDb();
  return new Promise((resolve, reject) => {
    const q = db.transaction("keys").objectStore("keys").get(name);
    q.onsuccess = () => resolve(q.result || null);
    q.onerror = () => reject(q.error);
  });
}
async function secretKeyPut(name, value) {
  const db = await secretDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("keys", "readwrite");
    tx.objectStore("keys").put(value, name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Same passphrase -> same salt in every browser, so they read each other's files with the stored key.
async function passphraseSalt(passphrase) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("tab-workflows-salt:" + passphrase));
  return new Uint8Array(h).slice(0, 16);
}
// Keep the key, forget the passphrase. Returns what goes into syncConfig.
async function rememberPassphrase(passphrase) {
  const salt = await passphraseSalt(passphrase);
  await secretKeyPut("sync", await scKey(passphrase, salt));
  return { keySalt: scB64(salt), syncId: await syncIdFor(passphrase), hasPassphrase: true };
}

// ======================= Sensitive sync data is encrypted =======================
// Logins (GitHub token, WebDAV username / app password), addresses (WebDAV folder, your own server) and
// identifiers (the gist's id, the shared folder's name) have to be used as they are, so they can't be
// hashed. They're encrypted (AES-256-GCM) with a random key made in this browser, kept in IndexedDB as a
// non-exportable key – storage only ever holds "enc1:…". They're decrypted in memory, only when needed.
const SECRET_FIELDS = ["gistToken", "webdavUser", "webdavPass", "webdavUrl", "serverUrl", "gistId", "folderName"];

async function deviceKey() {
  let k = await secretKeyGet("device");
  if (!k) {
    k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await secretKeyPut("device", k);
  }
  return k;
}
async function encryptSecret(text) {
  if (!text) return "";
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await deviceKey(), new TextEncoder().encode(text));
  return "enc1:" + scB64(iv) + ":" + scB64(new Uint8Array(ct));
}
async function decryptSecret(value) {
  if (!value || !String(value).startsWith("enc1:")) return "";
  try {
    const [, iv, ct] = String(value).split(":");
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: scUnB64(iv) }, await deviceKey(), scUnB64(ct));
    return new TextDecoder().decode(plain);
  } catch (_) { return ""; }
}

// Older versions stored the passphrase and the logins as text: replace them (runs once).
async function protectSyncConfig(cfg) {
  cfg = cfg || {};
  const plain = SECRET_FIELDS.filter(f => cfg[f]);
  if (!cfg.passphrase && !plain.length) return cfg;
  const patch = cfg.passphrase ? await rememberPassphrase(cfg.passphrase) : {};
  for (const f of plain) patch[f + "Enc"] = await encryptSecret(cfg[f]);
  const { syncConfig: cur = {} } = await chrome.storage.local.get("syncConfig");
  const next = { ...cur, ...patch };
  delete next.passphrase;
  for (const f of SECRET_FIELDS) delete next[f];
  await chrome.storage.local.set({ syncConfig: next });
  return next;
}

// Store a change to syncConfig: sensitive fields are encrypted, `null` removes a field.
async function saveSyncFields(patch) {
  const { syncConfig: cur = {} } = await chrome.storage.local.get("syncConfig");
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    const base = k.endsWith("Enc") && SECRET_FIELDS.includes(k.slice(0, -3)) ? k.slice(0, -3) : null;
    if (SECRET_FIELDS.includes(k)) {
      delete next[k];
      if (v) next[k + "Enc"] = await encryptSecret(String(v)); else delete next[k + "Enc"];
    } else if (base) {                       // already encrypted by the caller
      delete next[base];
      if (v) next[k] = v; else delete next[k];
    } else if (v === null) delete next[k];
    else next[k] = v;
  }
  await chrome.storage.local.set({ syncConfig: next });
  return next;
}

// The config with the sensitive fields decrypted – in memory only, never written back.
async function unlockSyncConfig(cfg) {
  const out = { ...cfg };
  for (const f of SECRET_FIELDS) out[f] = await decryptSecret(cfg[f + "Enc"]);
  return out;
}

// Encrypt / decrypt the sync file with the stored key (same file format as before).
async function sealSyncStored(data, cfg) {
  const key = await secretKeyGet("sync");
  if (!key || !cfg.keySalt) throw new Error("Set a passphrase first.");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, await scGzip(JSON.stringify(data)));
  return JSON.stringify({ app: SYNC_APP, v: 1, kdf: `PBKDF2-SHA256-${SYNC_ITERATIONS}`, cipher: "AES-256-GCM",
                          salt: cfg.keySalt, iv: scB64(iv), data: scB64(new Uint8Array(ct)) });
}
// `passphrase` (optional): only right after you typed it, to read a file an older version wrote.
async function openSyncStored(text, cfg, passphrase = "") {
  let env;
  try { env = JSON.parse(text); } catch (_) { throw new Error("The synced file isn’t a Tab Workflows sync file."); }
  if (!env || env.app !== SYNC_APP) throw new Error("The synced file isn’t a Tab Workflows sync file.");
  let key;
  if (env.salt === cfg.keySalt) key = await secretKeyGet("sync");
  else if (passphrase) key = await scKey(passphrase, scUnB64(env.salt));
  else throw new Error("Can’t read the synced copy: it was written with another passphrase, or by an older version of Tab Workflows. Update every browser, or type your passphrase again here and save.");
  if (!key) throw new Error("Set a passphrase first.");
  let plain;
  try { plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: scUnB64(env.iv) }, key, scUnB64(env.data)); }
  catch (_) { throw new Error("Wrong passphrase – it has to be the same in every browser."); }
  return JSON.parse(await scGunzip(new Uint8Array(plain)));
}
