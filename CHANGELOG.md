# Changelog

## 1.0.4

### Added
* **Select tabs by hovering.** Hover a tab and its site icon turns into a checkbox. Once one tab is ticked, every tab shows a checkbox, and clicking a row ticks it too. Shift+click ticks a range, Ctrl+click ticks a tab straight away, and Esc clears the selection. You can tick tabs in several workflows at once.
* **Selection bar.** While tabs are ticked, a bar at the bottom of the page shows how many are selected, with Move to…, Copy to…, Open, Copy links, Trash, Select all / Deselect all and ✕ to close it.
* **Drag several tabs at once.** Dragging one of the ticked tabs takes all of them along, shown as a stack with a count, and drops them exactly where you let go – also inside the same workflow. Hold Ctrl while dropping to copy them.
* **Right-click menu on tabs.** Open, Edit name and link, Copy link, Move to…, Copy to…, Duplicate, Add a divider above, Pin tab / Unpin tab, Select and Remove. Right-click a ticked tab to act on every ticked tab.
* **Keep pinned tabs open** (Settings → Switching, off by default). Pinned tabs belong to no workflow: switching only closes and opens your normal tabs, and pinned tabs stay. Unpin a tab to make it part of the workflow you're in. Pinned tabs can stay in their window, be copied into every workflow you open, be copied into every new browser window (also ones you open yourself), or do that and stay the same on all your browsers through sync.
* **Pinned tabs show in every workflow.** With Keep pinned tabs open on, each workflow lists your pinned tabs at the top. Double-click one to go to it, or right-click to unpin or close it.
* **Older workflows with pinned tabs saved in them.** When you open one, you're asked whether to pin those tabs, open them as normal tabs or remove them from the workflow. Tick "Do this every time", or set it in Settings → Switching.

### Changed
* **Collapsing and expanding a workflow is animated.** The workflow glides open and closed instead of jumping.
* The "Select tabs" checkbox above the first tab and the buttons that replaced a workflow's header while selecting are gone – the checkboxes and the selection bar do this now.

### Fixed
* **Empty space after moving tabs out of a workflow.** On the canvas, a workflow you had resized kept its height after tabs were moved out, leaving a big gap. It now shrinks to fit its tabs; the size you dragged it to is the most it grows to.
