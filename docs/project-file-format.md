# Portable Mindgrab project files (version 2)

**Export** downloads the active in-memory document as readable UTF-8 JSON named
`<project name>.mindgrab.json`. It includes offline edits and edits that browser
storage has not saved. A synchronous Yjs transaction captures a detached,
consistent view; export does not flush storage, contact the server, or change
undo history. Export remains available if local persistence fails to open.

**Import** accepts `.mindgrab.json` or `.json` files in the following format.
Version 2 is the supported portable format. Binary backup archives use the
separate operational recovery format.

```json
{
  "format": "mindgrab-project",
  "version": 2,
  "project": {
    "name": "Planning",
    "nodes": [
      {
        "id": "root",
        "text": "Ideas\nNext steps 😀",
        "color": "teal",
        "position": { "x": -20, "y": 14 },
        "children": [
          {
            "id": "child",
            "text": "Keep this",
            "color": "blue",
            "children": []
          }
        ]
      }
    ]
  },
  "preferences": {
    "viewport": { "left": 10, "top": -12, "zoom": 1.25 },
    "anchor": { "id": "root", "centerY": 30 }
  }
}
```

`project.nodes` is an ordered forest. Every node requires `id`, `text`, `color`,
and an ordered `children` array; `position` is optional. The exported hierarchy
and sibling order come from the canonical visible projection, including its
handling of missing/deleted parents and cycles. Deleted nodes are omitted.
Explicit manual positions, plain text (including whitespace, newlines, and
Unicode), colors, and the name are preserved. Empty forests are supported.
The node IDs in the file identify its nodes; they are not imported identities.

Unknown properties are rejected at every level. The file has no project UUID,
owner/account IDs, credentials, sync state, update clocks, tombstones,
awareness, or undo/redo history. Yjs binary backups belong to the separate
recovery flow.

## Validation limits

| Value | Limit |
| --- | --- |
| Complete file | 10 MiB of UTF-8 bytes, checked before JSON parsing (and before reading an oversized upload) |
| Nodes | 10,000 across the whole forest |
| Nesting | 100 node levels; a root is level 1 |
| Text | 65,536 UTF-16 code units per node, matching the editor/document limit |
| Project name | Nonblank and at most 200 UTF-8 bytes; imported text is preserved |
| File node IDs | Unique, nonempty strings of at most 128 UTF-16 code units |
| Positions | Finite numeric `x` and `y` |
| Color | `blue`, `teal`, `green`, `amber`, `orange`, `rose`, `violet`, or `slate` |

The format marker must match exactly and `version` must be the number `2`.
Malformed/truncated JSON, unsupported formats/versions, duplicates, invalid
coordinates, and limits produce a file error before project creation. Node and
depth limits are checked with bounded iterative traversal before recursive
schema validation.

## Optional local preferences

`preferences` is separate from semantic project content and may be omitted.
`viewport` accepts finite `left`/`top` and a `zoom` between 0.25 and 2.5.
`anchor` accepts a file node ID and finite `centerY`; its ID must reference a
node in this file. Export omits a stale anchor for a deleted node. Import
remaps the anchor to the regenerated node ID and stores preferences only in
the local catalog. Preference write failure does not invalidate a successfully
persisted project.

## Import identity and persistence

Validation first produces a temporary representation. Import regenerates every
node UUID and parent reference, regenerates sibling ranks from array order, and
creates a fresh project UUID and new Yjs history. Importing the same file twice
produces independent documents. Existing projects are never selected, merged,
or overwritten by matching names or file IDs. Duplicate names are retained;
the Load menu distinguishes them by UUID.

The complete initial document update must commit before hydration and catalog
registration. A local pending-import marker prevents another repository or tab
from discovering an unfinished import through catalog recovery. If document or
catalog persistence fails, the import closes its handles and removes its seed
and catalog entry. If cleanup is interrupted, the marker keeps the seed out of
catalog recovery. The active document and latest-project preference remain
unchanged on failure. The app flushes the previous document before creating
an import, then activates the new document only after successful persistence,
with an empty session undo/redo stack. The latest-project preference is updated
after activation.

## Verification

`webapp/tests/project-import-export.test.ts` covers format validation, limits,
canonical content, Unicode, identity/reference regeneration, undo isolation,
and in-memory exports. The existing browser suites exercise real file
upload/download, offline usage, duplicate names and repeated imports, failed
IndexedDB document/catalog commits, rollback after reload, and exporting with
unavailable storage. Run:

```sh
cd webapp
bun --bun run check
bun --bun run test
bun --bun test ./tests/browser/editor.browser.ts ./tests/browser/project-repository.browser.ts
bun --bun run build
```
