# Changelog

## 1.0.2

* Many smaller changes

### Added
* Added a right-click menu, each item listing your workflows and Unsorted tabs: on a web page, "Send to" saves the page into that workflow and closes the tab (if it's the last tab of its window, a New Tab takes its place so the window stays open), and "Copy to" saves it and keeps the tab open; on a link, "Save link to" saves the link without opening it. The page or link is added at the end of the workflow with its title and icon. A green ✓ on the toolbar icon shows it worked, and Undo takes it out again. Sending or copying a page to the workflow that is already autosaving it does nothing (a grey dot shows instead). The list follows your workflows as you create, rename, delete or sync them. Needs the new "contextMenus" permission.
* Added divider tabs: a real tab in the tab strip with your own text and colour (9 colours, the same as Chrome's tab groups). The title is a line of dashes with the name in the middle, placed by the name's measured width so short and long names ("Work", "testing") line up the same. It's a tiny page that is put to sleep whenever you're on another tab, so it uses almost no memory. You can rename it or change its colour right on the tab.
* Added icons for divider tabs: pick one of the workflow icons above the name on the divider tab, and it becomes the tab's icon in the divider's colour (or keep the plain coloured line). It costs no extra memory, and editing the divider from the Session Manager keeps the icon.
* Added labels: dividers that only show in the Session Manager, above a tab. They aren't tabs, so they use no memory, and they stay put when the workflow autosaves (if their tab is closed, the label moves to the next tab).
* Added "Add divider tab…" to each workflow's ⋯ menu, and an "Add a divider above this tab" button on every tab (choose divider tab or label).
* Added a divider button to the popup and a browser shortcut (suggested: Alt+Shift+D) that inserts a divider tab right after the tab you're on, in any tab.
* Added a "Dividers" section to Settings → Switching with "Put divider tabs to sleep" (on by default).
* Added backup copies: every workflow keeps its last 3 earlier versions in this browser. Open them with "Backup copies…" in the workflow's ⋯ menu and restore one (undo works too). A copy is taken when the tabs change, at most every 30 minutes, and right away when half the tabs or more disappear at once.
* Added a welcome screen: one sheet that explains workflows, autosave, switching, dividers, sync and shortcuts. It shows after installing, and you can open it again from Settings → About.
* Added an "Update available" screen: when a synced browser runs a newer version of Tab Workflows, the older one shows both version numbers and the changes since its version, taken from CHANGELOG.md on GitHub (or, if GitHub can't be reached or has nothing newer, the copy the newer browser shared through sync), with a link to the changelog on GitHub and a button to the extensions page. "Later" hides it until the next version.
* Added middle-button panning: hold the mouse wheel and drag anywhere in the Session Manager, even over a workflow, to move around. On the Canvas it moves the canvas, in Board and List it scrolls the page.
* Added editable Session Manager shortcuts (command palette, undo, search) in Settings → About: click a shortcut and press the new keys (Esc cancels, Reset puts the default back; a shortcut that's already used swaps with it). A note says they only work in the Session Manager, except Alt Shift D.
* Added the insert-divider shortcut to Settings → About: it shows the shortcut the browser really uses (or "Not set") with a Change button that opens the browser's shortcuts page.
* Added a connection indicator to Sync: a green dot and "Connected" when the last sync worked, a red dot and "Disconnected" with the reason when it failed, for WebDAV, GitHub Gist, your own server, the shared folder and the Chrome profile.
* Added a Disconnect button next to the connection indicator in Sync: this browser stops syncing and forgets the login, token, address or folder it used (your workflows, the passphrase and the synced copy stay).
* Added animations when switching between Settings pages: the page slides in and its sections follow one after another.
* The highlight of the Workflows / History / Settings tabs, the Board / List / Canvas switch and the Settings menu now slides over to the one you click.
* Added a "Beta" label to Sync: in the Settings menu, on the page title and as a note at the top of the Sync page.
* Added "Reduce motion" to Settings → Appearance: turns off animations, sliding highlights and page transitions in the Session Manager and the popup.
* Added "Skip duplicate tabs" to Settings → Saving: a link is stored only once per window (the tab you're on and pinned tabs are always kept, and no open tab is closed).
* Added a "Deleting \& undo" section to Settings → Data: "Ask before deleting" (confirm before deleting a workflow or removing tabs), "Keep deleted items" (7, 30 or 90 days, or until the trash is full) and "Undo steps" (10, 25, 50 or 100). Lowering them trims the trash and the undo list right away.

### Fixed

* Fixed the popup showing a green "Autosaved · … tabs" when autosave is off for the workflow you're in (or paused in Settings): it now shows "Autosave off for “…” · saved …" (or "Autosave paused") with a grey dot.
* Fixed a few tabs of the workflow you switched away from staying open (and being saved into the new workflow) when it had many tabs, e.g. more than 25: tabs are no longer put to sleep in the middle of a switch, tabs that got a new id while asleep are still found, and after the switch the window is checked and any leftover old tab is closed.
* Fixed the popup jumping back to the top while you scroll through a workflow's tabs whenever a tab loads or something is saved: it now stays where you were.
* Fixed the app password (or GitHub token) field staying on "Saved (encrypted)" after pressing Connect instead of showing dots.
* Fixed workflows overlapping on the Canvas after creating a new one: a new workflow now goes to the free spot nearest to where you're looking, measured with every workflow's real size. If two workflows still overlap (one grew, or one arrived through sync), the newer one moves to the nearest free spot.
* Fixed renaming a workflow, changing its icon, colour, note, tags or autosave not reaching your other browsers.
* Fixed divider tabs and labels being lost when a workflow is synced to a browser where the extension has a different id.
* Fixed the mouse wheel doing nothing over a workflow on the Canvas when that workflow has nothing to scroll: it now moves the canvas. A workflow only keeps the wheel when its tabs can actually scroll (then it also scrolls when you're over its header).
* Fixed autosave running in the middle of switching workflows: it's now paused from the moment a switch starts until every new tab has its address, and the result is saved once afterwards. A sync that updates open tabs pauses it the same way.
* Fixed the sync passphrase being stored as readable text. It's no longer stored at all: only hashes of it (a salt and the server id) and the encryption key made from it, kept so it can't be exported. Existing setups are converted automatically, without typing the passphrase again.
* Fixed sensitive sync data being stored as readable text: the GitHub token and gist id, the WebDAV folder address, username and app password, your own server's address and the shared folder's name are now encrypted (AES-256-GCM) with a key made in this browser that can't be exported. They have to be used as they are, so they can't be hashed; they're only decrypted in memory while syncing or to fill in the Sync page. The password and token fields show "Saved (encrypted)" instead of the value. Existing settings are converted automatically.

### Changed

* WebDAV sync is now set up one step at a time: enter the folder address and press Next, enter your username and app password and press Connect (it asks for permission to reach your storage and checks the login right away, telling you if the folder doesn't exist or the login is wrong), then choose your passphrase and press Save. After that the Sync page shows all the WebDAV settings as before, in the same order (the passphrase below the login).
* The shared folder, GitHub Gist and your own server are set up the same way: first choose the folder, connect your GitHub token (it's checked right away) or enter your server's address, and only then the passphrase appears below it. The other sync settings show once both are done, and the passphrase stays below the folder, token or address.
* The GitHub token, WebDAV username and app password are saved (encrypted) as soon as you leave their field. The token and app password then show "Saved (encrypted)" for 5 seconds and dots afterwards; the username shows only its first 3 letters and up to 5 stars (like ale\*\*\*\*\*).
* The passphrase field says "Enter / Create passphrase". After you save one it shows "Saved (encrypted)" for 5 seconds, then "Type for new passphrase"; the show/hide button is hidden until you start typing a new one.
* The save button on a workflow with autosave off (in the popup) now confirms it worked: it turns into a green "Saved" that fades in and out again (hover to see how many tabs were saved), or "Nothing to save" if none of its tabs are open.
* New installs now start with the Dots background in the Session Manager and with "Ask before switching" turned on. Your current choices stay as they are.
* "Save current" in the popup now saves your open tabs into the workflow you're in, instead of creating a new workflow. If you're not in a workflow, it still asks for a name and saves them as a new one.
* The passphrase field no longer shows your passphrase; it says "Saved" instead. Type a new one only to change it.
* Sync files are now written with a salt made from the passphrase, so browsers can read them without the passphrase being stored. Version 1.0.1 can still read them, but 1.0.2 can't read files that 1.0.1 writes, so update every synced browser.

## 1.0.1

### Added

* Added a "Sync settings" option (Settings → Sync), off by default: your settings sync between browsers along with your workflows, still encrypted with your passphrase. How each browser syncs, board zoom and column width stay per browser.
* Added a "Sync every" setting: choose how often automatic sync runs, from 1 minute to 1 hour (default 5 minutes).
* Added an "After a change" setting: choose how long to wait after a change before syncing it, from 30 seconds to 5 minutes (default 30 seconds).
* Added "Apply changes when the browser starts" (on by default): when a browser opens, it first checks what your other browsers changed while it was closed and applies it to the open tabs. With it off, the tabs the browser opens with win.
* Added a note to the Sync page's "Good to know" list explaining that open workflows follow changes from other browsers.

### Fixed

* Fixed cross-browser changes being undone: removing, adding, editing or moving a tab of a workflow in one browser (for example Helium) now updates that workflow's open tabs in the other browser (for example Chrome) instead of being reverted by the next sync.
* Fixed workflows counting as "changed" when you only switched tabs or a page finished loading, which made the open browser's copy win every sync. Only real changes (tabs added, removed, moved, pinned, renamed or regrouped) count now.
* Fixed a restarted browser overwriting changes made elsewhere while it was closed: it now waits for its tabs to be restored and syncs before saving.

### Changed

* The Sync status line now shows your chosen sync interval and delay instead of a fixed "every 5 minutes and about 30 seconds after a change".
* Workflows open in any browser window now follow synced changes, not only the active workflow.

### Removed

* Removed the rule that a workflow open in this browser always kept its local version during sync.
* Removed the fixed 5-minute sync interval and 30-second delay after a change (both are now settings).

