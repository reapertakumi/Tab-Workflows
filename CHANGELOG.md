# Changelog

## 1.0.3

### Added
* **Chrome profile sync merges automatically.** When a copy from another Chrome profile or computer arrives, it's merged in right away (the newest version of each workflow wins), and the combined result is sent back a minute later. Deleted workflows are removed everywhere too. Before, each profile just overwrote the other's copy unless you pressed Merge in quickly enough. Merge in and Replace are still there.

### Changed
* **Simpler sync setup.** Every method is set up one step at a time, and each step stays on the page once it's done. WebDAV: folder address → Next (asks for permission to reach it right away), username and app password → Connect (tells you if the folder doesn't exist or the login is wrong), then your passphrase → Save. Shared folder: Choose folder (access is asked for right then), then your passphrase → Save. The address and username stay in their fields, stored encrypted.
* **Rebuilt WebDAV sync.** Connect and the background syncing now use the same WebDAV code, so "Connected" means syncing will work. Connect really tests the folder by saving a small test file there (and deleting it), and creates the folder if it's missing. If it fails, the reason stays in red under the login, naming the address that answered and the storage's own words. Example address for OxiCloud: http://<server>:8086/webdav/.
* **Every connection needs its own passphrase.** A passphrase saved for one sync method is no longer carried over when you switch to another, and Disconnect forgets it, so connecting always means creating a passphrase first. Nothing syncs until it's there. Once saved, its field says "Type to change". The passphrase itself is never stored.
* **Your WebDAV app password stays hidden.** Once you've connected, it never comes back into the page: the field just says "Saved", the eye button only shows what you're typing right now, and Connect uses the saved password when the field is empty. A password that fails Connect isn't stored.
* **Reconnect button.** When a sync connection shows red ("Disconnected"), the button next to it is now Reconnect, which tries again right away. Disconnect shows while it's connected.
* **Clearer WebDAV access.** Next asks for access to the exact address, port included (e.g. :8086), and tells you when access was already allowed instead of looking like nothing happened.

### Fixed
* **Shared folder in Brave and Helium.** Choose folder did nothing when the browser's "File editing" setting is "Don't allow sites to edit files". It now explains what's blocking it, copies the extension's address for you and opens the File editing settings page, where you can allow it.
* **WebDAV redirects.** WebDAV didn't connect when the storage sends http:// on to https:// (common on home NAS boxes). Next now asks for access to both, and your login is sent again to the new address (the browser drops it on a redirect). If the request is still blocked, the message says why (no access yet, or a self-signed certificate) instead of only "check your internet connection".
* **WebDAV "error 400" and "404".** Some NAS storage answered Connect with "error 400"; the check now sends a standard WebDAV request. An address with no WebDAV folder could also pass Connect and then fail every sync with "404 Not Found" – the test file now catches that.
* **"Wrong passphrase" after changing it.** The synced copy is now first updated with the old passphrase, then written again with the new one. If a copy made with another passphrase is still there, the message says to press Overwrite synced copy when this browser has your newest workflows.
* **Old synced copy blocking the first sync.** When the folder or storage still holds a copy made with another passphrase (e.g. from an earlier setup), you're now asked right away whether to replace it with this browser's workflows.
* **Connect doing nothing.** Clicking Connect right after typing your password or token lost the click (and could empty the field). The page now waits until the click is done.