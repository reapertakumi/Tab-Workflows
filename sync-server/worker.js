// Tab Workflows – tiny sync server (Cloudflare Worker + Workers KV).
//
// It only stores and returns one encrypted file per passphrase. The data is encrypted in your browser
// before it's sent, so this server (and Cloudflare) can't read your workflows.
//
// Setup: see README.md in this folder. Needs a KV namespace bound to this Worker as  TABSYNC.

const MAX_BYTES = 5 * 1024 * 1024;   // 5 MB per sync file

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

const reply = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { ...CORS, "Cache-Control": "no-store", ...extra } });

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return reply(null, 204);

    const match = new URL(request.url).pathname.match(/^\/v1\/([a-f0-9]{32,64})$/);
    if (!match) return reply("Tab Workflows sync server is running.", 200, { "Content-Type": "text/plain" });
    if (!env.TABSYNC) return reply("KV namespace TABSYNC is not bound to this Worker.", 500);
    const key = match[1];

    if (request.method === "GET") {
      const value = await env.TABSYNC.get(key);
      return value === null ? reply("", 404) : reply(value, 200, { "Content-Type": "application/json" });
    }

    if (request.method === "PUT") {
      const body = await request.text();
      if (body.length > MAX_BYTES) return reply("Too large", 413);
      try {
        const parsed = JSON.parse(body);
        if (parsed.app !== "tab-workflows-sync" || !parsed.data) throw new Error("not a sync file");
      } catch (_) {
        return reply("Not a Tab Workflows sync file", 400);
      }
      await env.TABSYNC.put(key, body);
      return reply("ok");
    }

    return reply("Method not allowed", 405);
  }
};
