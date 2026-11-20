# Privacy Policy – Tab Workflows

**Effective date:** November 20, 2026

Tab Workflows ("the extension") is a browser extension that saves your tabs as named workflows and lets
you switch between them. This policy explains what data the extension handles, where it is kept, and the
choices you have. In short: **your data stays in your browser. The developer does not collect, receive,
sell or share any of it.**

## 1. What the extension handles

To do its job, the extension reads and stores the following **on your device**:

- **Tabs and windows:** the web addresses (URLs), titles and site icons of your open tabs, their order,
  which tabs are pinned, and how they are arranged in windows.
- **Chrome tab groups:** group names, colours and which tabs belong to them.
- **What you create in the extension:** workflow names, icons, colours, notes and tags; tab names you
  edit; tabs you add to "Unsorted tabs".
- **Extension records:** your settings, a list of recent changes (for Undo), the trash (deleted
  workflows and removed tabs), saved copies of deleted tab groups, and automatic backups.
- **Sync details (only if you turn sync on):** your sync passphrase and, depending on the method you
  choose, a GitHub token, a server address, or a WebDAV address, username and password.

The extension does **not** read the content of the pages you visit, your form entries, passwords,
cookies or browsing history beyond the tabs that are open.

## 2. Where your data is kept

All of the above is stored in the extension's local storage inside your browser profile
(`chrome.storage.local`). It never leaves your device unless you use one of the optional features below.

The extension has **no servers of its own**, and it contains **no analytics, tracking, advertising or
third-party code**. Site icons are shown using the browser's built-in icon service, without contacting
any website.

## 3. Optional features that move data

These features are all **off until you turn them on or use them**:

- **Export / import and backup files.** When you export, or choose "Also save a file to Downloads" for
  daily backups, a file is saved to your computer. You decide what happens to it.
- **Sync with your Chrome profile.** Your workflows are compressed and stored in the browser's own sync
  storage, which your browser vendor (Google, for Chrome) syncs to your other devices signed in to the
  same account. This is handled under that vendor's privacy policy. This method is not encrypted by the
  extension itself.
- **Sync between browsers (shared folder, GitHub Gist, your own server, WebDAV).** Before anything leaves
  your browser, it is **encrypted with your passphrase** (AES-256-GCM, with the key derived from your
  passphrase using PBKDF2-SHA-256). Only the encrypted file is stored, and only in the place **you**
  choose:
  - a folder you pick on your computer or in your own cloud-drive folder;
  - a private gist in **your** GitHub account, accessed with the token you provide;
  - a server **you** set up (for example, your own Cloudflare Worker);
  - a WebDAV storage **you** use (for example, Nextcloud).

  The developer has no access to any of these places and cannot read the encrypted data. Your
  passphrase is never sent anywhere. The provider you choose (for example GitHub, Cloudflare or your
  WebDAV host) handles the encrypted file under its own privacy policy.

When you connect GitHub, a server or WebDAV, the browser asks for your permission to contact that
specific address. The extension contacts it only to read and write the encrypted sync file.

## 4. Permissions and why they are needed

| Permission | Why |
|---|---|
| Tabs | Read open tabs (address, title, order) to save, restore and switch workflows. |
| Tab groups | Save, restore and remove Chrome tab groups as part of a workflow. |
| Storage, Unlimited storage | Keep workflows, settings, history and backups on your device. |
| Favicon | Show site icons using the browser's built-in icon service. |
| Alarms | Run the daily backup and sync in the background at set times. |
| Downloads (optional) | Only if you choose to save daily backup files to your Downloads folder. |
| Access to websites (optional) | Only the GitHub, server or WebDAV address you connect for sync, to read and write the encrypted sync file. |

## 5. How long data is kept

- Workflows, settings and Unsorted tabs: until you delete them or remove the extension.
- Recent changes: the last 25; you can clear them at any time (History → Clear).
- Trash: 30 days, or until you empty it.
- Copies of deleted tab groups: the newest copy of each group, up to 100; you can clear them at any time.
- Automatic backups: the last 10.

Removing the extension deletes everything it stored in your browser. Copies you exported, or synced
files stored at a provider you chose, stay there until you delete them.

## 6. Your choices

You can delete individual workflows, tabs, backups and group copies; clear recent changes; empty the
trash; use **Settings → Data → Delete everything**; turn sync off at any time; and remove the extension.

## 7. Sharing and sale of data

The developer does not collect your data, so it is never sold, rented, shared with third parties, used
for advertising, used to determine creditworthiness, or used for any purpose other than the features
described above.

The use of information received through browser extension APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements.

## 8. Children

The extension is not directed at children under 13 and does not knowingly collect information from them.

## 9. Changes to this policy

If this policy changes, the updated version will be published at this address with a new effective
date. Significant changes will also be mentioned in the extension's release notes.

## 10. Contact

Questions about this policy: **[your contact email]**
