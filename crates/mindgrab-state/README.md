# Shared Rust state

`mindgrab-state` owns the Loro document, editing commands, validation, ordered
tree projection, Unicode text diffing, stable cursors, IME rebasing and local
undo/redo. The Rust backend and the browser WASM use this same crate. TypeScript
state and command types are generated from the Rust model during `state:build`.
The browser adapter handles notifications, storage lifetimes and DOM bindings.

```rust
use mindgrab_state::{Color, Command, Project};

let mut project = Project::new("My mind map")?;
let root = project.apply(Command::CreateNode {
    parent: None,
    index: None,
    text: "An idea 🦀".into(),
    color: Color::shade("sky", 400).unwrap(),
    fill: None,
})?.created_node.unwrap();
project.apply(Command::SetText { id: root, text: "A better idea 🦀".into() })?;
let bytes = project.snapshot()?;
let mut other_replica = Project::from_snapshot(&bytes)?;
other_replica.merge(&project.snapshot()?)?;
let view = other_replica.view()?;
# Ok::<(), mindgrab_state::StateError>(())
```

Commands cover naming, node and sibling creation, ordered moves, subtree
deletion, text replacement and UTF-16 edits, branch coloring, subtree positioning
and undo/redo.
Typing can group into one undo step; structural commands form independent steps.
Undo is local and transformed over remote edits, with a 100-step history bound.

Application node IDs are stored in node metadata and remain stable when Loro
undo recreates an internal tree node. Concurrent undo can recreate the same
application node twice; the projection chooses the first visible branch in
Loro's deterministic order. This also keeps rendered hierarchies acyclic.
Tree deletion hides descendants, and Loro resolves concurrent move conflicts.

A node's color is stored as text: one of Tailwind's shades, such as `sky-400`
(26 hue families × 11 shades, `COLOR_FAMILIES` and `COLOR_SHADES`), or one of
the eight named colors from before shades (`NAMED_COLORS`), which keep their own
look. Any other text makes the document invalid, so clients older than a new
color reject maps that use it.

How a map looks and where it is saved are not part of its document.
`Preference` types each of an account's preferences by name: `quickColors` (the
colors the style panel offers, in order), `newIdeaColor` (the color new ideas
start with), `linkStyle` (how lines run to children: `freeform` curves, or a tree
with `rounded` or `square` corners), `saveLocally` and `saveInCloud` (whether the
browser and the account keep a copy) and `analyticsConsent` (`granted` or
`denied`). Colors are white (`slate`) or shades, and quick colors appear once
each. A `PreferenceRow` sets one for all of an account's maps (`global`) or for
one map (`map`, with its project id); a map's own value wins. Consent is only
ever global. The backend stores them in Postgres, and the webapp keeps them in
the browser too.

Older maps kept colors, a connection style and where they were saved in the
document's metadata (`colors`, `links` and `saving`). The view reports any of
them as `legacy`, so the webapp can make the colors and connection style the
map's own preferences; where a map was saved is not carried over. Then
`ForgetLegacyPreferences` removes all three. It is excluded from undo.

Deleting an idea never moves another one. `DeleteNode { id, gap }` takes the
layout space the branch took (the client measures it) and keeps it empty with
the idea's own gap: as `gap` (space above) on the next sibling, else as
`endGap` (space after the last child) on the parent. A last top-level idea
leaves nothing, since nothing is below it. `MoveNode` leaves the moved idea's
own gap behind the same way. `CreateNode` and `CreateSibling` take an optional
`fill`: the space the new idea needs, taken first from the gap where it goes,
so adding where an idea was deleted fills its place. `SetGaps` sets or clears
both on one idea, for import and for returning a branch to automatic layout.
Gaps are non-negative layout units of at most `MAX_GAP`; gaps that add up past
it are capped, so a sum can never overflow. Clients older than gaps reject
documents that have them.

The flat Rust view contains ordered nodes, parents, children, depth, colors and
positions. JSON projections serve rendering and inspection. Browser persistence, and the
first exchange with a replica, use complete binary snapshots containing CRDT
history, including deletes. Later exchanges carry only the changes beyond a
version (`updates_since`) or a head (`outgoing`). Version comparison uses a canonical sorted vector, independent of
hash-map insertion order. Snapshots merge in any order, including duplicates.

Remote imports are validated on a disposable replica before accepted state or
undo history changes. Malformed data, unexpected fields, invalid hidden nodes,
unsupported schemas and causal gaps are rejected. Changes whose dependencies
are missing are refused, not kept pending; the sender then sends the complete
snapshot. Snapshot size is capped at 10 MiB, total
tree entries (including deleted entries) at 10,000, node text at 65,536 UTF-16
units, and project names at 200 UTF-8 bytes. These are application limits; large
history compaction can be added separately.

`head` names a document's version by its latest changes: `counter@peer` ids,
sorted by peer and joined by commas, in at most `MAX_HEAD_BYTES`. It stays a few
bytes where the version vector grows with every peer that has edited the map.
`version_at` gives the version a head names, when the document holds every
change in it. `outgoing` reads a stored snapshot and answers a replica at a
given head with what it lacks: nothing, the changes since, or the instruction
to send the complete snapshot, when the head is not held or the changes would
be no smaller. Browser bindings expose `head` and `versionAt`.

Run `mise run state:test`, `mise run state:check` and `mise run state:interop`.
The interoperability suite opens the main app with the real Rust backend and
Postgres, not a separate playground. See the [root README](../../README.md) to
run the complete application.

Each node also exposes a `note` string (empty when absent). `SetNote { id, note }`
and `EditNote { id, index, delete_count, insert }` share the text limit and UTF-16
indexing rules. The optional `note` metadata key is activated on the first
non-empty edit using a deterministic LoroText container, so concurrent first
edits merge and old snapshots need no migration. Activation is excluded from
undo; undo/redo applies to note content and preserves remote edits.

`note_cursor`, `resolve_note_cursor` and `edit_note_draft` mirror the existing
text APIs, including read-only cursors for absent notes. Browser bindings expose
these as `noteCursor`, `resolveNoteCursor` and `editNoteDraft`. Use
`bindTextarea(input, doc, id, onValue, "note")` in the webapp, and dispose the
returned binding when the editor closes. Existing callers default to `"text"`.
