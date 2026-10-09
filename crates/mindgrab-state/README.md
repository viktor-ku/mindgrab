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
    color: Color::Blue,
})?.created_node.unwrap();
project.apply(Command::SetText { id: root, text: "A better idea 🦀".into() })?;
let bytes = project.snapshot()?;
let mut other_replica = Project::from_snapshot(&bytes)?;
other_replica.merge(&project.snapshot()?)?;
let view = other_replica.view()?;
# Ok::<(), mindgrab_state::StateError>(())
```

Commands cover naming, node and sibling creation, ordered moves, subtree
deletion, text replacement and UTF-16 edits, branch coloring, subtree positioning,
saving preferences and undo/redo. Preferences are excluded from edit undo.
Typing can group into one undo step; structural commands form independent steps.
Undo is local and transformed over remote edits, with a 100-step history bound.

Application node IDs are stored in node metadata and remain stable when Loro
undo recreates an internal tree node. Concurrent undo can recreate the same
application node twice; the projection chooses the first visible branch in
Loro's deterministic order. This also keeps rendered hierarchies acyclic.
Tree deletion hides descendants, and Loro resolves concurrent move conflicts.

The flat Rust view contains ordered nodes, parents, children, depth, colors and
positions. JSON projections serve rendering and inspection. Sync and browser
persistence use complete binary snapshots containing CRDT history, including
deletes. Version comparison uses a canonical sorted vector, independent of
hash-map insertion order. Snapshots merge in any order, including duplicates.

Remote imports are validated on a disposable replica before accepted state or
undo history changes. Malformed data, unexpected fields, invalid hidden nodes,
unsupported schemas and causal gaps are rejected. Sending full history avoids
pending-dependency transport state. Snapshot size is capped at 10 MiB, total
tree entries (including deleted entries) at 10,000, node text at 65,536 UTF-16
units, and project names at 200 UTF-8 bytes. These are application limits; large
history compaction and incremental transport can be added separately.

Run `mise run state:test`, `mise run state:check` and `mise run state:interop`.
The interoperability suite opens the main app with the real Rust backend and
Postgres, not a separate playground. See the [root README](../../README.md) to
run the complete application.
