// Tab Workflows – WebDAV client. Shared by the Session Manager page (setup and Connect) and the background
// (syncing), so checking a connection and syncing talk to your storage in exactly the same way.
// Needs sync-core.js (SYNC_FILE) loaded first.
//
// A connection is { url, user, pass }:
//   url        – the folder address as you typed it. It's never changed. An address ending in .json is the sync file.
//   user, pass – sent with HTTP Basic auth on every request (many servers only take an app password here).
//
// Redirects: a NAS or proxy often sends http:// on to https://. The browser follows that but drops the login on
// the way, so the request is sent again at the new address with the login. Where an address went is remembered
// while this page / the background runs, so later requests go there directly.

const WEBDAV_CHECK_FILE = "tab-workflows-check.tmp";

const WebDAV = (() => {
  const moved = new Map();   // address as typed → address it redirected to

  const clean = url => String(url || "").trim();
  const isFileUrl = url => /\.json$/i.test(clean(url));
  const folderOf = url => isFileUrl(url) ? clean(url).replace(/[^/]*$/, "") : clean(url).replace(/\/?$/, "/");
  const fileOf = url => isFileUrl(url) ? clean(url) : folderOf(url) + SYNC_FILE;
  const originOf = url => { try { return new URL(url).origin; } catch (_) { return clean(url); } };

  function basicAuth(user, pass) {
    const bytes = new TextEncoder().encode(`${user || ""}:${pass || ""}`);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return "Basic " + btoa(s);
  }

  // The access to ask the browser for, for an address: exactly it (port included, e.g. :8086) and its host on any
  // port – and for http:// also https://, where a redirect would go.
  function accessPatterns(urls) {
    const out = new Set();
    for (const u of [].concat(urls)) {
      try {
        const x = new URL(u);
        out.add(`${x.protocol}//${x.host}/*`);
        out.add(`${x.protocol}//${x.hostname}/*`);
        if (x.protocol === "http:") { out.add(`https://${x.host}/*`); out.add(`https://${x.hostname}/*`); }
      } catch (_) {}
    }
    return [...out];
  }

  async function hasAccess(url) {
    try { return await chrome.permissions.contains({ origins: accessPatterns([url]) }); } catch (_) { return true; }
  }

  // The server's own words for an error, shortened (e.g. "The plain HTTP request was sent to HTTPS port").
  async function reasonOf(r) {
    const t = await r.clone().text().catch(() => "");
    const s = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
    return s ? ` (“${s}”)` : "";
  }

  async function unreachable(url) {
    const origin = originOf(url);
    if (!(await hasAccess(url))) return new Error(`Tab Workflows has no access to ${origin} yet – press Next on the Sync page and allow it.`);
    return new Error(`Couldn’t reach ${origin} – the request was stopped before your storage answered. Check that the address opens in a browser tab. ` +
      "If it’s https:// with the server’s own (self-signed) certificate, as home servers often have, the browser refuses it: use the http:// address on your home network, or give the server a valid certificate.");
  }

  // One request with the login. Follows a redirect with the login (see above).
  async function request(conn, url, method, { body, headers = {} } = {}) {
    const init = { method, body, cache: "no-store", credentials: "omit",
      headers: { Authorization: basicAuth(conn.user, conn.pass), ...headers } };
    let at = moved.get(url) || url;
    let r;
    try { r = await fetch(at, init); } catch (_) { throw await unreachable(at); }
    if (r.redirected && r.url && r.url !== at) {
      at = r.url;
      moved.set(url, at);
      try { r = await fetch(at, init); } catch (_) { throw await unreachable(at); }
    }
    return { r, at };
  }

  // What a status means, in words. `doing` e.g. "saving the sync file"; `at` the address that answered; `typed`
  // the address as typed – named too when the storage redirected it somewhere else.
  async function explain(r, at, doing, typed = at) {
    const here = at.replace(/[^/]*$/, ""), there = typed.replace(/[^/]*$/, "");
    const where = here === there ? here : `${here} (where ${there} redirects to)`;
    switch (r.status) {
      case 401: return "The username or app password isn’t right. (Some storage, like OxiCloud or Nextcloud with two-step login, only takes an app password here.)";
      case 403: return `The login works, but may not save files in ${where} – check the folder’s permissions on your storage.`;
      case 404: case 409: return `There’s no WebDAV folder at ${where} (${doing} answered ${r.status}). Check the address: it must be the WebDAV address of a folder.`;
      case 405: case 501: return `${where} doesn’t take files (${doing} answered ${r.status}) – it doesn’t look like a WebDAV address. Check your storage’s WebDAV settings.`;
      case 507: return `Your storage is full (${doing} answered 507).`;
      default: return `Your storage answered ${r.status} when ${doing}${await reasonOf(r)}.`;
    }
  }

  async function createFolder(conn) {
    const { r } = await request(conn, folderOf(conn.url), "MKCOL");
    return r.status === 201 || r.status === 405;   // 405: it's there already
  }

  // Connect: check the address and the login by doing what syncing does – save a small file and delete it again.
  // A missing folder is created. Returns { ok: true, created } or { ok: false, message }.
  async function check(conn) {
    try {
      if (!/^https?:\/\//i.test(clean(conn.url))) return { ok: false, message: "Enter the full folder address, starting with http:// or https://" };
      const folder = folderOf(conn.url);
      // Is the folder there? (Servers that don't answer this properly are checked by the save below.)
      const { r: p, at: pAt } = await request(conn, folder, "PROPFIND", {
        headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
        body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>' });
      if (p.status === 401) return { ok: false, message: await explain(p, pAt, "checking the folder", folder) };
      let created = false;
      if (p.status === 404) {
        created = await createFolder(conn).catch(() => false);
        if (!created) return { ok: false, message: await explain(p, pAt, "checking the folder", folder) };
      }
      const probe = folder + WEBDAV_CHECK_FILE;
      const { r: w, at } = await request(conn, probe, "PUT", { headers: { "Content-Type": "text/plain" }, body: "Tab Workflows connection check" });
      if (!w.ok) return { ok: false, message: await explain(w, at, "saving a test file", probe) };
      await request(conn, probe, "DELETE").catch(() => {});
      return { ok: true, created };
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e) };
    }
  }

  // The sync file's text, or null when there isn't one yet.
  async function read(conn) {
    const { r, at } = await request(conn, fileOf(conn.url), "GET");
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(await explain(r, at, "reading the sync file", fileOf(conn.url)));
    return r.text();
  }

  // Save the sync file. If the folder has gone, it's created again once.
  async function write(conn, text) {
    const put = () => request(conn, fileOf(conn.url), "PUT", { headers: { "Content-Type": "application/json" }, body: text });
    let { r, at } = await put();
    if ((r.status === 404 || r.status === 409) && !isFileUrl(conn.url) && await createFolder(conn).catch(() => false)) ({ r, at } = await put());
    if (!r.ok) throw new Error(await explain(r, at, "saving the sync file", fileOf(conn.url)));
  }

  return { folderOf, fileOf, accessPatterns, check, read, write };
})();
