# Your own sync server (free, ~10 minutes, one time)

This is option 3 for syncing Tab Workflows between Chrome, Brave, Helium and other computers.
It's a tiny Cloudflare Worker on **your own** free Cloudflare account – only your browsers use it.
Your workflows are encrypted with your passphrase *before* they're sent, so neither the server nor
Cloudflare can read them.

## 1. Create the storage
1. Sign up / log in at https://dash.cloudflare.com (free plan is enough).
2. Left menu: **Storage & Databases → KV** → **Create a namespace** → name it `tabsync` → **Add**.

## 2. Create the Worker
1. Left menu: **Compute (Workers) → Workers & Pages** → **Create** → **Create Worker**.
2. Give it a name, e.g. `tab-workflows-sync` → **Deploy** (deploys a "Hello world" for now).
3. Click **Edit code**, delete everything, paste the whole content of `worker.js` from this folder
   (or use **Copy server code** in Tab Workflows → Settings → Sync), then **Deploy**.

## 3. Connect the storage to the Worker
1. Open the Worker → **Settings → Bindings** → **Add** → **KV namespace**.
2. Variable name: `TABSYNC` (exactly like that). KV namespace: `tabsync`. → **Deploy / Save**.

## 4. Use it
1. Copy the Worker's address, e.g. `https://tab-workflows-sync.yourname.workers.dev`.
   Opening it in a tab should say "Tab Workflows sync server is running."
2. In every browser: Tab Workflows → Settings → **Sync** → **Your own server** → paste the address,
   enter the **same passphrase** → **Connect**.

That's it – browsers with the same passphrase share the same (encrypted) workflows.

### Limits (free plan)
Workers KV allows about 1,000 writes and 100,000 reads a day. Tab Workflows syncs at most every few
minutes and only uploads when something changed, so one person's browsers stay far below that.
