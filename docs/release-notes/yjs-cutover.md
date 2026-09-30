# Development release: Yjs cutover (MIN-43)

Mindgrab now uses Yjs for editing, undo, automatic browser saving and cloud
synchronization. The old name-keyed snapshot implementation is removed.

On first opening with obsolete development snapshots, the app asks you to close
other tabs on the same site if needed, then removes only the known old project
localStorage keys. Existing Yjs projects, sign-in data, preferences and unrelated
browser storage remain. There is no conversion/backfill. If offline or tab
coordination fails, reconnect and use **Retry opening**. Wait for **Saved locally**
before closing tabs with Yjs edits. Do not clear site data.

Operators explicitly remove only the old `project`/`pnode` tables with
`mise run server:reset-legacy-projects` after stopping old backend builds.
This retains users, sessions and all Yjs data, and can be repeated. Old clients
receive an upgrade response and cannot write snapshots. A rollback must preserve
binary Yjs data and use a compatible build.

See [cutover and operations](../yjs-cutover.md) for deployment, resets, compatibility,
save-state guarantees and recovery.
