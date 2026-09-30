// Persistent real Yjs replicas/UndoManager driven by the Rust maintenance suite.
import { Y } from "./fixtures";
import {
  addNode,
  createUndoManager,
  materialize,
  nodeMap,
  ORIGIN,
  placeNode,
  present,
} from "./fixtures";
import { base, capture, fork, ID, node, text } from "./scenarios";

const active = base();
const offline = fork(active, 22);
const undo = createUndoManager(active);

function request(input: { command: string; checkpoint?: number[] }) {
  if (input.command === "start") {
    const initial = Y.encodeStateAsUpdate(active);
    const updates = capture(active, () => {
      active.transact(() => text(active).delete(0, 3), ORIGIN.local);
    });
    undo.stopCapturing();
    return { initial: [...initial], updates: updates.map((u) => [...u]) };
  }
  if (input.command === "reconnect") {
    const updates = capture(offline, () => {
      offline.transact(() => {
        text(offline).insert(2, "offline ✨");
        placeNode(offline, ID(3), ID(2), 0);
        present(nodeMap(offline).get(ID(2))).set("deleted", true);
      }, ORIGIN.local);
    });
    Y.applyUpdate(
      active,
      new Uint8Array(input.checkpoint ?? []),
      ORIGIN.remote,
    );
    for (const update of updates) Y.applyUpdate(active, update, ORIGIN.remote);
    const undone = capture(active, () => undo.undo());
    return {
      updates: [...updates, ...undone].map((u) => [...u]),
      expected: materialize(active),
      undoCount: undone.length,
    };
  }
  if (input.command === "redo") {
    Y.applyUpdate(
      active,
      new Uint8Array(input.checkpoint ?? []),
      ORIGIN.remote,
    );
    const updates = capture(active, () => undo.redo());
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(active), ORIGIN.remote);
    return {
      updates: updates.map((u) => [...u]),
      expected: materialize(active),
      offline: materialize(offline),
    };
  }
  if (input.command === "byte-trigger") {
    const doc = base();
    for (let i = 10; i < 74; i++) addNode(doc, ID(i), node("x".repeat(10_000)));
    const initial = [...Y.encodeStateAsUpdate(doc)];
    doc.destroy();
    return { initial };
  }
  if (input.command === "benchmark") {
    const doc = base();
    for (let i = 10; i < 138; i++)
      addNode(doc, ID(i), node("Idea 🌍 ".repeat(32)));
    const initial = Y.encodeStateAsUpdate(doc);
    const updates = capture(doc, () => {
      for (let i = 0; i < 1_200; i++) {
        const id = ID(10 + (i % 128));
        doc.transact(() => {
          if (i % 3 === 0) text(doc, id).insert(0, "edit ✨ ");
          else if (i % 3 === 1) text(doc, id).delete(0, 2);
          else placeNode(doc, id, i % 2 ? ID(1) : null, 0);
        }, ORIGIN.local);
      }
    });
    const result = {
      initial: [...initial],
      updates: updates.map((u) => [...u]),
      expected: materialize(doc),
    };
    doc.destroy();
    return result;
  }
  throw Error("Unknown command");
}

let pending = "";
for await (const chunk of Bun.stdin.stream()) {
  pending += new TextDecoder().decode(chunk);
  let newline = pending.indexOf("\n");
  while (newline !== -1) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    console.log(JSON.stringify(request(JSON.parse(line))));
    newline = pending.indexOf("\n");
  }
}
undo.destroy();
active.destroy();
offline.destroy();
