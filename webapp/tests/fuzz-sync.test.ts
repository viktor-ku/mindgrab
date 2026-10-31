// Multi-replica convergence fuzzing of the collaborative document. Replicas
// edit, undo and redo locally and exchange snapshots in random directions and
// orders (including stale snapshots and long partitions). After every merge
// the receiver must hold a valid tree; after a full exchange every replica
// must show the same document, whatever order the snapshots arrived in.
//
// Loro picks random peer ids and fractional-index jitter, so a seed replays
// the same choices but not always the same node ids. Failures therefore print
// the recent command trace (node ids shortened to n0, n1, …) instead.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createChild,
  createProjectDocument,
  deleteSubtree,
  editNodeNote,
  editNodeText,
  moveNode,
  openProjectDocument,
  reorderNode,
  setNodeColor,
  setNodeNote,
} from "../src/project-document";
import type { Command } from "../src/generated/mindgrab-state/model";
import type { DocumentView, ProjectDocument } from "../src/project-document";
import { EditHistory } from "../src/undo-history";
import {
  canonical,
  checkView,
  FIRST_SEED,
  random,
  randomText,
  SEEDS,
  tryEdit,
} from "./fuzz-helpers";
import type { Random } from "./fuzz-helpers";

const COLORS = ["blue", "teal", "green", "amber"] as const;
// Merges validate on a disposable copy, so cost grows with history. Shorter
// runs than the single-document fuzzer keep the default under a few seconds.
const STEPS = Number(process.env.FUZZ_STEPS ?? 100);

// ---------------------------------------------------------------- tracing --

// Everything that changes replica state, with raw ids, so a failure can be
// dumped (FUZZ_DUMP=dir) and replayed and minimized (FUZZ_REPLAY=file).
type FuzzEvent =
  | { t: "cmd"; r: string; command: Command; created?: string | null }
  | { t: "group" | "reload"; r: string }
  | { t: "undo"; r: string; redo: boolean; roundTrip: boolean }
  | { t: "merge"; to: string; from: string }
  | { t: "save"; r: string; slot: number }
  | { t: "mergeSaved"; to: string; slot: number }
  | { t: "fullSync" };

class Trace {
  lines: string[] = [];
  events: FuzzEvent[] = [];
  #labels = new Map<string, string>();
  label(id: string) {
    let label = this.#labels.get(id);
    if (!label) {
      label = `n${this.#labels.size}`;
      this.#labels.set(id, label);
    }
    return label;
  }
  short(text: string) {
    return text.replace(/\d+@\d+/g, (id) => this.label(id));
  }
  push(line: string) {
    this.lines.push(this.short(line));
  }
  // FUZZ_TRACE=n prints the last n trace lines on failure (default 40).
  tail(count = Number(process.env.FUZZ_TRACE ?? 40)) {
    return this.lines.slice(-count).join("\n  ");
  }
}

// What a replica has edited itself since its history began. Undo may only
// change these nodes (and their branches) and the name if it renamed.
interface Touched {
  nodes: Set<string>;
  name: boolean;
  // Whether this replica deleted a branch, and whether it has undone since,
  // which can recreate the branch from its old data.
  deleted?: boolean;
  recreated?: boolean;
}

// Records every command a replica dispatches, with shortened node ids, and
// which nodes it touched.
function instrument(
  doc: ProjectDocument,
  name: string,
  trace: Trace,
  touched: Touched,
) {
  const dispatch = doc.dispatch.bind(doc);
  doc.dispatch = (command) => {
    const { type, ...rest } = command;
    // Branch commands touch every node in the branch as it is now.
    if (command.type === "deleteNode") touched.deleted = true;
    if (
      command.type === "colorBranch" ||
      command.type === "deleteNode" ||
      command.type === "translateSubtree"
    ) {
      const view = doc.view();
      const pending = [command.id];
      while (pending.length) {
        const id = pending.pop()!;
        touched.nodes.add(id);
        pending.push(
          ...(view.nodes.find((node) => node.id === id)?.children ?? []),
        );
      }
    }
    const result = dispatch(command);
    if (result.createdNode) touched.nodes.add(result.createdNode);
    if ("id" in command) touched.nodes.add(command.id);
    if (command.type === "translateSubtree")
      for (const id of Object.keys(command.positions)) touched.nodes.add(id);
    if (command.type === "rename") touched.name = true;
    if (type !== "undo" && type !== "redo")
      trace.events.push({
        t: "cmd",
        r: name,
        command,
        created: result.createdNode,
      });
    if (type !== "undo" && type !== "redo")
      trace.push(
        `${name} ${type} ${JSON.stringify(rest)}${result.createdNode ? ` -> ${result.createdNode}` : ""}${result.changed ? "" : " (unchanged)"}`,
      );
    return result;
  };
}

// ------------------------------------------------------------ versioning --

// ProjectDocument.version() is the JSON of the peer → counter map, as bytes.
type Version = Map<string, number>;
function versionOf(doc: ProjectDocument): Version {
  const raw = doc.version();
  const json = String.fromCharCode(...raw.split(",").map(Number));
  return new Map(Object.entries(JSON.parse(json) as Record<string, number>));
}
const includes = (outer: Version, inner: Version) =>
  [...inner].every(([peer, counter]) => (outer.get(peer) ?? 0) >= counter);

// --------------------------------------------------------------- replicas --

interface Replica {
  name: string;
  doc: ProjectDocument;
  history: EditHistory<unknown>;
  touched: Touched;
}
interface Saved {
  slot: number;
  owner: string;
  bytes: Uint8Array;
  version: Version;
}

function openReplica(
  id: string,
  name: string,
  snapshot: Uint8Array,
  trace: Trace,
): Replica {
  const doc = openProjectDocument(id, [snapshot]);
  const touched: Touched = { nodes: new Set(), name: false };
  instrument(doc, name, trace, touched);
  return { name, doc, history: new EditHistory(doc), touched };
}
function closeReplica(replica: Replica) {
  replica.history.destroy();
  replica.doc.destroy();
}

function valid(doc: ProjectDocument, context: string) {
  let view: DocumentView;
  try {
    view = doc.view();
  } catch (error) {
    throw new Error(`${context}: view() failed: ${String(error)}`);
  }
  try {
    checkView(view);
    for (const node of view.nodes)
      if (!node.text.isWellFormed() || !node.note.isWellFormed())
        throw new Error(`node ${node.id} has a split surrogate pair`);
  } catch (error) {
    throw new Error(`${context}: ${String(error)}`);
  }
}

// One-directional sync. The merged document must stay valid, merging the same
// bytes again must change nothing, and bytes already contained in the
// receiver must not change it at all.
function mergeInto(
  receiver: Replica,
  bytes: Uint8Array,
  bytesVersion: Version | undefined,
  context: string,
  rng?: Random,
) {
  const beforeView = canonical(receiver.doc);
  const beforeVersion = versionOf(receiver.doc);
  const beforeRaw = receiver.doc.version();
  try {
    receiver.doc.merge(bytes);
  } catch (error) {
    throw new Error(`${context}: merge was rejected: ${String(error)}`);
  }
  valid(receiver.doc, context);
  if (bytesVersion && includes(beforeVersion, bytesVersion)) {
    expect(
      canonical(receiver.doc),
      `${context}: known bytes changed view`,
    ).toBe(beforeView);
    expect(
      receiver.doc.version(),
      `${context}: known bytes changed version`,
    ).toBe(beforeRaw);
  }
  if (rng?.chance(0.25)) {
    const after = canonical(receiver.doc);
    const version = receiver.doc.version();
    receiver.doc.merge(bytes);
    expect(canonical(receiver.doc), `${context}: merge not idempotent`).toBe(
      after,
    );
    expect(receiver.doc.version()).toBe(version);
  }
}

function fullSync(replicas: Replica[], context: string) {
  for (let round = 0; round < 2; round++)
    for (const receiver of replicas)
      for (const sender of replicas)
        if (sender !== receiver)
          mergeInto(
            receiver,
            sender.doc.snapshot(),
            undefined,
            `${context}: ${receiver.name} <- ${sender.name}`,
          );
  const expected = canonical(replicas[0]!.doc);
  for (const replica of replicas) {
    expect(
      canonical(replica.doc),
      `${context}: ${replica.name} diverged from ${replicas[0]!.name}`,
    ).toBe(expected);
    expect(replica.doc.version()).toBe(replicas[0]!.doc.version());
  }
  return expected;
}

function shuffled<T>(rng: Random, items: readonly T[]) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

// Fresh replicas built from the same snapshots in different orders agree.
function orderIndependent(
  rng: Random,
  id: string,
  snapshots: Uint8Array[],
  context: string,
) {
  const views = [0, 1].map(() => {
    const doc = openProjectDocument(id, shuffled(rng, snapshots));
    try {
      valid(doc, context);
      return canonical(doc);
    } finally {
      doc.destroy();
    }
  });
  expect(views[1], `${context}: merge order changed the result`).toBe(views[0]);
  return views[0]!;
}

// -------------------------------------------------------- adversarial ops --

// Edits aimed at a few shared ("hot") nodes so replicas collide often: moves
// that form cycles across replicas, deletes racing edits, overlapping text
// ranges, first note edits, reorders and branch recolors.
function hotEdit(rng: Random, doc: ProjectDocument, hot: string[]): string {
  const view = doc.view();
  const present = hot.filter((id) => view.nodes.some((n) => n.id === id));
  const a = rng.pick(present);
  const b = rng.pick(present);
  if (!a || !b) return tryEdit(rng, doc);
  const before = canonical(doc);
  const node = view.nodes.find((n) => n.id === a)!;
  try {
    switch (rng.int(10)) {
      case 0:
      case 1:
        moveNode(doc, a, b, rng.int(2));
        return "hot:moveUnder";
      case 2:
        deleteSubtree(doc, a);
        return "hot:delete";
      case 3:
      case 4: {
        // Overlapping ranges near the start of the text.
        const index = Math.min(node.text.length, rng.int(2));
        const remove = Math.min(node.text.length - index, rng.int(3));
        editNodeText(doc, a, index, remove, randomText(rng, 2) || "x");
        return "hot:editText";
      }
      case 5:
        if (rng.chance(0.5)) setNodeNote(doc, a, randomText(rng, 3) || "n");
        else
          editNodeNote(
            doc,
            a,
            Math.min(node.note.length, rng.int(2)),
            0,
            randomText(rng, 2) || "n",
          );
        return "hot:note";
      case 6:
        createChild(doc, a, { text: randomText(rng, 2) });
        return "hot:child";
      case 7:
        reorderNode(doc, a, rng.chance(0.5) ? -1 : 1);
        return "hot:reorder";
      case 8:
        setNodeColor(doc, a, rng.pick(COLORS)!, rng.chance(0.5));
        return "hot:color";
      default:
        moveNode(doc, a, rng.chance(0.3) ? null : (node.parent ?? null), 0);
        return "hot:moveUp";
    }
  } catch (error) {
    const after = canonical(doc);
    if (after !== before)
      throw new Error(
        `A rejected edit changed the document: ${String(error)}\nbefore ${before}\nafter  ${after}`,
      );
    return `hot:rejected ${String(error).slice(0, 50)}`;
  }
}

// ------------------------------------------------------------- the fuzzer --

// Undo and redo revert only this replica's own edits: a node it never
// touched, with no touched ancestor before or after, keeps its content and
// place, and does not appear or disappear.
function onlyLocalChanges(
  touched: Touched,
  before: DocumentView,
  after: DocumentView,
  context: string,
  trace: Trace,
) {
  const exempt = (view: DocumentView, id: string) => {
    const byId = new Map(view.nodes.map((node) => [node.id, node]));
    for (
      let node = byId.get(id);
      node;
      node = node.parent ? byId.get(node.parent) : undefined
    )
      if (touched.nodes.has(node.id)) return true;
    return false;
  };
  const isRemote = (id: string) => !exempt(before, id) && !exempt(after, id);
  const pick = (view: DocumentView, id: string) => {
    const node = view.nodes.find((candidate) => candidate.id === id);
    return (
      node &&
      JSON.stringify([
        node.parent,
        node.text,
        node.note,
        node.color,
        node.position,
      ])
    );
  };
  const ids = new Set([...before.nodes, ...after.nodes].map((node) => node.id));
  for (const id of ids)
    if (isRemote(id) && pick(before, id) !== pick(after, id))
      throw new Error(
        trace.short(
          `${context} changed a node it never edited: ${id}\n  before ${pick(before, id)}\n  after  ${pick(after, id)}`,
        ),
      );
  if (!touched.name && before.name !== after.name)
    throw new Error(`${context} changed the name it never edited`);
}

// Known bugs the fuzzer reports but tolerates unless FUZZ_STRICT is set, so it
// can keep searching for new ones. Each has a skipped `repro:` test below;
// delete its entry here once the repro passes.
const STRICT = !!process.env.FUZZ_STRICT;
const KNOWN_BUGS: { name: string; matches: (message: string) => boolean }[] = [
  {
    // repro: undoing a delete drops concurrent remote edits to the branch
    name: "redo/undo round trips are inexact once undo can recreate a deleted branch (Loro)",
    matches: (message) =>
      message.includes("[after a delete that undo can recreate]"),
  },
];
const knownHits = new Map<string, number>();
const SIBLING_ORDER =
  "undo then redo of a create or move can change sibling order after concurrent inserts";

// Views that differ only in sibling order count as the known sibling-order
// bug (repro below); any other difference fails.
function sameView(actual: string, expected: string, message: string) {
  if (actual === expected) return;
  const unordered = (json: string) => {
    const view = JSON.parse(json) as Pick<
      DocumentView,
      "name" | "roots" | "nodes"
    >;
    return JSON.stringify({
      name: view.name,
      roots: [...view.roots].sort(),
      nodes: view.nodes
        .map((node) => ({ ...node, children: [...node.children].sort() }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    });
  };
  if (!STRICT && unordered(actual) === unordered(expected)) {
    knownHits.set(SIBLING_ORDER, (knownHits.get(SIBLING_ORDER) ?? 0) + 1);
    return;
  }
  throw new Error(`${message}\n${viewDiff(expected, actual)}`);
}

// Field-level differences between two canonical views, readable even when
// the views are too large to print.
function viewDiff(expected: string, actual: string) {
  type View = Pick<DocumentView, "name" | "roots" | "nodes">;
  const [e, a] = [JSON.parse(expected) as View, JSON.parse(actual) as View];
  const out: string[] = [];
  if (e.name !== a.name) out.push(`name ${e.name} -> ${a.name}`);
  if (JSON.stringify(e.roots) !== JSON.stringify(a.roots))
    out.push(`roots ${JSON.stringify(e.roots)} -> ${JSON.stringify(a.roots)}`);
  for (const id of new Set([...e.nodes, ...a.nodes].map((node) => node.id))) {
    const x = e.nodes.find((node) => node.id === id);
    const y = a.nodes.find((node) => node.id === id);
    if (!x || !y) {
      out.push(`${id} ${x ? "missing" : "extra"}: ${JSON.stringify(x ?? y)}`);
      continue;
    }
    for (const key of Object.keys(x) as (keyof typeof x)[])
      if (JSON.stringify(x[key]) !== JSON.stringify(y[key]))
        out.push(
          `${id}.${key}: ${JSON.stringify(x[key])} -> ${JSON.stringify(y[key])}`,
        );
  }
  return out.join("\n");
}
const totals = {
  operations: 0,
  merges: 0,
  undos: 0,
  emptySteps: 0,
  seeds: 0,
};

// Undo or redo on one replica. If it hits a tolerated known bug, the replica
// is rolled back to its state before the undo (reloaded, so with a fresh
// history) and the hit is counted.
function undoStep(
  replicas: Replica[],
  index: number,
  redo: boolean,
  id: string,
  trace: Trace,
  context: string,
  wantRoundTrip: boolean,
) {
  const replica = replicas[index]!;
  trace.events.push({
    t: "undo",
    r: replica.name,
    redo,
    roundTrip: wantRoundTrip,
  });
  if (!redo && replica.touched.deleted) replica.touched.recreated = true;
  const bytes = replica.doc.snapshot();
  const before = replica.doc.view();
  const canUndo = replica.history.canUndo();
  const canRedo = replica.history.canRedo();
  const roundTrip = (redo ? canRedo : canUndo) && wantRoundTrip;
  const action = redo ? "redo" : "undo";
  trace.push(`${replica.name} ${action}`);
  try {
    try {
      if (redo) replica.history.redo();
      else replica.history.undo();
    } catch (error) {
      throw new Error(
        `${context}: ${action} on ${replica.name} threw: ${String(error)}`,
      );
    }
    valid(replica.doc, `${context} after ${action} on ${replica.name}`);
    onlyLocalChanges(
      replica.touched,
      before,
      replica.doc.view(),
      `${context}: ${action} on ${replica.name}`,
      trace,
    );
    // Undo then redo (or redo then undo) with nothing in between is a no-op,
    // but only for steps with a visible effect. A step superseded by remote
    // edits (its nodes deleted, its value since overwritten or cleared)
    // changes nothing visible; Loro may then drop it or its reverse from the
    // stacks, and the next undo or redo jumps to an older step.
    const after = canonical(replica.doc);
    const visible =
      after !==
      JSON.stringify({
        name: before.name,
        roots: before.roots,
        nodes: before.nodes,
      });
    if (!visible && (redo ? canRedo : canUndo)) totals.emptySteps++;
    // Undoing a delete recreates the branch from its old data, possibly as
    // a second copy that redo/undo can swap with the first, so exact round
    // trips are not guaranteed once a replica has deleted a branch.
    const recreated = replicas.some((other) => other.touched.recreated)
      ? " [after a delete that undo can recreate]"
      : "";
    if (roundTrip && visible) {
      if (redo) replica.history.undo();
      else replica.history.redo();
      valid(replica.doc, `${context} after ${action} round trip`);
      sameView(
        canonical(replica.doc),
        JSON.stringify({
          name: before.name,
          roots: before.roots,
          nodes: before.nodes,
        }),
        `${context}: ${action} then reverse on ${replica.name} did not restore the view${recreated}`,
      );
      if (redo) replica.history.redo();
      else replica.history.undo();
      sameView(
        canonical(replica.doc),
        after,
        `${context}: repeating ${action} on ${replica.name} differs${recreated}`,
      );
    }
  } catch (error) {
    const known = KNOWN_BUGS.find((bug) => bug.matches(String(error)));
    if (STRICT || !known) throw error;
    knownHits.set(known.name, (knownHits.get(known.name) ?? 0) + 1);
    trace.push(`${replica.name} known bug, rolled back`);
    closeReplica(replica);
    replicas[index] = openReplica(id, replica.name, bytes, trace);
  }
}

function run(seed: number) {
  const rng = random(seed);
  const trace = new Trace();
  const id = crypto.randomUUID();
  const base = createProjectDocument(id, "Fuzz", { text: "root" });
  for (let i = 4 + rng.int(8); i > 0; i--) tryEdit(rng, base);
  const hot = base.view().nodes.map((node) => node.id);
  const baseSnapshot = base.snapshot();
  base.destroy();
  trace.push(`base ${hot.join(" ")}`);

  const count = 2 + rng.int(3);
  const replicas = Array.from({ length: count }, (_, i) =>
    openReplica(id, `r${i}`, baseSnapshot, trace),
  );
  const saved: Saved[] = [];
  let nextSlot = 0;
  // Replicas in different groups cannot reach each other during a partition.
  let groups: number[] | null = null;
  let partitionLeft = 0;
  let step = 0;
  const context = () => `seed ${seed} step ${step}`;
  try {
    for (; step < STEPS; step++) {
      totals.operations++;
      if (partitionLeft > 0 && --partitionLeft === 0) {
        groups = null;
        trace.push("heal partition");
      }
      const replica = rng.pick(replicas)!;
      const roll = rng.next();
      if (roll < 0.42) {
        // One to three edits form one undo step.
        const edits = 1 + (rng.chance(0.25) ? rng.int(3) : 0);
        for (let i = 0; i < edits; i++) {
          const kind = rng.chance(0.4)
            ? hotEdit(rng, replica.doc, hot)
            : tryEdit(rng, replica.doc);
          if (kind.includes("rejected")) trace.push(`${replica.name} ${kind}`);
        }
        replica.history.finishGroup();
        trace.events.push({ t: "group", r: replica.name });
        valid(replica.doc, `${context()} after edit on ${replica.name}`);
      } else if (roll < 0.52) {
        totals.undos++;
        undoStep(
          replicas,
          replicas.indexOf(replica),
          rng.chance(0.35),
          id,
          trace,
          context(),
          rng.chance(0.3),
        );
      } else if (roll < 0.86) {
        // One-directional merge, possibly of a stale snapshot.
        const peers = replicas.filter(
          (other) =>
            other !== replica &&
            (!groups ||
              groups[replicas.indexOf(other)] ===
                groups[replicas.indexOf(replica)]),
        );
        const sender = rng.pick(peers);
        const stale = rng.chance(0.2) ? rng.pick(saved) : undefined;
        if (stale && (!groups || stale.owner === replica.name || !sender)) {
          // Stale bytes may come from any replica once delivered late.
          totals.merges++;
          trace.push(`${replica.name} <- stale ${stale.owner}`);
          trace.events.push({
            t: "mergeSaved",
            to: replica.name,
            slot: stale.slot,
          });
          mergeInto(
            replica,
            stale.bytes,
            stale.version,
            `${context()}: ${replica.name} <- stale ${stale.owner}`,
            rng,
          );
        } else if (sender) {
          totals.merges++;
          trace.push(`${replica.name} <- ${sender.name}`);
          trace.events.push({
            t: "merge",
            to: replica.name,
            from: sender.name,
          });
          const bytes = sender.doc.snapshot();
          const version = versionOf(sender.doc);
          mergeInto(
            replica,
            bytes,
            version,
            `${context()}: ${replica.name} <- ${sender.name}`,
            rng,
          );
          // Sometimes complete the exchange; the pair must then agree.
          if (rng.chance(0.3)) {
            totals.merges++;
            trace.push(`${sender.name} <- ${replica.name}`);
            trace.events.push({
              t: "merge",
              to: sender.name,
              from: replica.name,
            });
            mergeInto(
              sender,
              replica.doc.snapshot(),
              versionOf(replica.doc),
              `${context()}: ${sender.name} <- ${replica.name}`,
              rng,
            );
            expect(
              canonical(sender.doc),
              `${context()}: pair ${replica.name}/${sender.name} diverged`,
            ).toBe(canonical(replica.doc));
          }
        }
      } else if (roll < 0.9) {
        // Remember a snapshot to deliver late.
        const slot = nextSlot++;
        trace.events.push({ t: "save", r: replica.name, slot });
        saved.push({
          slot,
          owner: replica.name,
          bytes: replica.doc.snapshot(),
          version: versionOf(replica.doc),
        });
        if (saved.length > 12) saved.splice(rng.int(saved.length), 1);
      } else if (roll < 0.93) {
        // Merging your own snapshot is a no-op.
        const before = canonical(replica.doc);
        const version = replica.doc.version();
        replica.doc.merge(replica.doc.snapshot());
        expect(canonical(replica.doc), `${context()}: self merge`).toBe(before);
        expect(replica.doc.version()).toBe(version);
      } else if (roll < 0.96) {
        if (!groups) {
          // Split, often isolating one replica for a long time.
          groups = replicas.map(() => rng.int(2));
          if (rng.chance(0.5)) {
            groups = replicas.map(() => 0);
            groups[rng.int(count)] = 1;
          }
          partitionLeft = 10 + rng.int(Math.max(10, STEPS / 3));
          trace.push(`partition ${groups.join("")} for ${partitionLeft}`);
        }
      } else if (roll < 0.975) {
        // Reload from its own snapshot: same content, fresh peer and history.
        trace.push(`${replica.name} reload`);
        trace.events.push({ t: "reload", r: replica.name });
        const bytes = replica.doc.snapshot();
        const before = canonical(replica.doc);
        closeReplica(replica);
        const reopened = openReplica(id, replica.name, bytes, trace);
        replicas[replicas.indexOf(replica)] = reopened;
        expect(canonical(reopened.doc), `${context()}: reload`).toBe(before);
      } else {
        // Mid-run order independence over current and stale snapshots.
        const snapshots = [
          ...replicas.map((r) => r.doc.snapshot()),
          ...saved.filter(() => rng.chance(0.5)).map((s) => s.bytes),
        ];
        orderIndependent(rng, id, snapshots, `${context()} order check`);
      }
    }

    step = STEPS;
    const latest = replicas.map((r) => r.doc.snapshot());
    trace.events.push({ t: "fullSync" });
    const synced = fullSync(replicas, `${context()} final sync`);
    totals.merges += 2 * count * (count - 1);
    for (const replica of replicas) {
      const version = replica.doc.version();
      replica.doc.merge(replica.doc.snapshot());
      expect(canonical(replica.doc), "self merge after sync").toBe(synced);
      expect(replica.doc.version()).toBe(version);
    }
    // Pre-sync snapshots (plus stale ones) in any order give the synced view.
    const fresh = orderIndependent(
      rng,
      id,
      [...latest, ...saved.map((s) => s.bytes)],
      `${context()} final order check`,
    );
    expect(fresh, `${context()}: fresh replica differs from synced`).toBe(
      synced,
    );
    // Undo after everything arrived remotely, then redo; still converges.
    for (let index = 0; index < count; index++)
      for (let i = rng.int(4); i > 0; i--) {
        undoStep(
          replicas,
          index,
          false,
          id,
          trace,
          `${context()} final`,
          rng.chance(0.3),
        );
        totals.undos++;
      }
    trace.events.push({ t: "fullSync" });
    fullSync(replicas, `${context()} sync after undo`);
    for (let index = 0; index < count; index++)
      for (let i = rng.int(3); i > 0; i--) {
        undoStep(
          replicas,
          index,
          true,
          id,
          trace,
          `${context()} final`,
          rng.chance(0.3),
        );
        totals.undos++;
      }
    trace.events.push({ t: "fullSync" });
    fullSync(replicas, `${context()} sync after redo`);
    totals.merges += 4 * count * (count - 1);
    totals.seeds++;
  } catch (error) {
    if (process.env.FUZZ_DUMP) {
      mkdirSync(process.env.FUZZ_DUMP, { recursive: true });
      const dump: Dump = {
        id,
        names: Array.from({ length: count }, (_, i) => `r${i}`),
        base: Buffer.from(baseSnapshot).toString("base64"),
        events: trace.events,
        error: String(error),
      };
      writeFileSync(
        `${process.env.FUZZ_DUMP}/seed-${seed}.json`,
        JSON.stringify(dump),
      );
    }
    throw new Error(
      `seed ${seed} (${count} replicas) failed at step ${step}:\n${trace.short(String(error))}\nrecent trace:\n  ${trace.tail()}`,
    );
  } finally {
    for (const replica of replicas) closeReplica(replica);
  }
}

// FUZZ_KEEP_GOING=1 runs every seed and groups failures by message, to see
// whether a long run found one bug or several.
test(`replicas converge under random edits, undo, partitions and out-of-order sync (${SEEDS} seeds × ${STEPS} steps)`, () => {
  const failures = new Map<string, string[]>();
  for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed++) {
    try {
      run(seed);
    } catch (error) {
      if (!process.env.FUZZ_KEEP_GOING) throw error;
      const message = String(error);
      const key = (message.split("\n")[1] ?? message)
        .replace(/seed \d+ |step \d+|r\d/g, "")
        .slice(0, 160);
      if (!failures.has(key)) {
        failures.set(key, []);
        console.log(message.split("\n").slice(0, 60).join("\n"));
      }
      failures.get(key)!.push(String(seed));
    }
  }
  if (process.env.FUZZ_REPORT || failures.size)
    console.log(
      JSON.stringify({
        ...totals,
        known: Object.fromEntries(knownHits),
        failures: Object.fromEntries(failures),
      }),
    );
  expect(failures.size).toBe(0);
}, 3_600_000);

// ---------------------------------------------------- replay and minimize --

interface Dump {
  id: string;
  names: string[];
  base: string;
  events: FuzzEvent[];
  error: string;
}

// Replays recorded events on fresh replicas with the same checks as the
// fuzzer. Nodes created during the run get new ids, mapped by creation;
// commands that no longer apply (after minimization) are skipped.
function replay(dump: Dump, trace = new Trace()) {
  const base = Buffer.from(dump.base, "base64");
  const replicas = dump.names.map((name) =>
    openReplica(dump.id, name, base, trace),
  );
  const index = (name: string) => dump.names.indexOf(name);
  const get = (name: string) => replicas[index(name)]!;
  const ids = new Map<string, string>();
  const saved = new Map<number, { bytes: Uint8Array; version: Version }>();
  try {
    for (const event of dump.events)
      switch (event.t) {
        case "cmd": {
          const command = JSON.parse(
            JSON.stringify(event.command).replace(
              /\d+@\d+/g,
              (id) => ids.get(id) ?? id,
            ),
          ) as Command;
          try {
            const result = get(event.r).doc.dispatch(command);
            if (event.created && result.createdNode)
              ids.set(event.created, result.createdNode);
          } catch {}
          break;
        }
        case "group":
          get(event.r).history.finishGroup();
          break;
        case "undo":
          undoStep(
            replicas,
            index(event.r),
            event.redo,
            dump.id,
            trace,
            "replay",
            event.roundTrip,
          );
          break;
        case "merge":
          mergeInto(
            get(event.to),
            get(event.from).doc.snapshot(),
            versionOf(get(event.from).doc),
            `replay ${event.to} <- ${event.from}`,
          );
          break;
        case "save":
          saved.set(event.slot, {
            bytes: get(event.r).doc.snapshot(),
            version: versionOf(get(event.r).doc),
          });
          break;
        case "mergeSaved": {
          const stale = saved.get(event.slot);
          if (stale)
            mergeInto(
              get(event.to),
              stale.bytes,
              stale.version,
              `replay ${event.to} <- stale`,
            );
          break;
        }
        case "reload": {
          const replica = get(event.r);
          const bytes = replica.doc.snapshot();
          closeReplica(replica);
          replicas[index(event.r)] = openReplica(
            dump.id,
            event.r,
            bytes,
            trace,
          );
          break;
        }
        case "fullSync":
          fullSync(replicas, "replay");
          break;
      }
    // Anything left unsynced must still converge.
    fullSync(replicas, "replay end");
  } finally {
    for (const replica of replicas) closeReplica(replica);
  }
}

const signature = (message: string) =>
  (message.split("\n").find((line) => line.startsWith("Error:")) ?? message)
    .replace(
      /seed \d+|step \d+|final|replay( end)?|r\d|n\d+|\d+@\d+|[:\s]+/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();

// FUZZ_REPLAY=dump.json replays a dumped failure and delta-debugs its events
// down to a small sequence that still fails the same way (FUZZ_TRIES replays
// per candidate, since peer ids and tie-breaks differ between runs).
test.skipIf(!process.env.FUZZ_REPLAY)(
  "replay and minimize a dumped failure",
  () => {
    const dump = JSON.parse(
      readFileSync(process.env.FUZZ_REPLAY!, "utf8"),
    ) as Dump;
    const target = signature(dump.error);
    const tries = Number(process.env.FUZZ_TRIES ?? 10);
    const fails = (events: FuzzEvent[]) => {
      for (let i = 0; i < tries; i++)
        try {
          replay({ ...dump, events });
        } catch (error) {
          if (signature(String(error)) === target) return true;
        }
      return false;
    };
    console.log(`target: ${target}`);
    if (!fails(dump.events)) {
      // Show what the replays did instead, to tell drift from a fix.
      const seen = new Map<string, number>();
      for (let i = 0; i < tries; i++) {
        let outcome = "passed";
        try {
          replay(dump);
        } catch (error) {
          outcome = String(error).split("\n").slice(0, 3).join(" | ");
        }
        seen.set(outcome, (seen.get(outcome) ?? 0) + 1);
      }
      throw new Error(
        `replay does not reproduce; outcomes: ${JSON.stringify([...seen])}`,
      );
    }
    let events = dump.events;
    let chunks = 2;
    while (events.length >= 2) {
      const size = Math.ceil(events.length / chunks);
      let reduced = false;
      for (let start = 0; start < events.length; start += size) {
        const candidate = [
          ...events.slice(0, start),
          ...events.slice(start + size),
        ];
        if (fails(candidate)) {
          events = candidate;
          chunks = Math.max(chunks - 1, 2);
          reduced = true;
          break;
        }
      }
      if (!reduced) {
        if (chunks >= events.length) break;
        chunks = Math.min(chunks * 2, events.length);
      }
    }
    const trace = new Trace();
    console.log(
      `minimized to ${events.length} events:\n${events.map((event) => trace.short(JSON.stringify(event))).join("\n")}`,
    );
    writeFileSync(
      `${process.env.FUZZ_REPLAY}.min.json`,
      JSON.stringify({ ...dump, events }),
    );
  },
  3_600_000,
);

// ------------------------------------------------------ targeted scenarios --

// Peer ids and fractional-index jitter are random, so each scenario repeats
// to cover both tie-break outcomes, and delivers merges in both orders.
const REPEAT = 8;

function scenario(count: number, texts = ["a", "b", "c"]) {
  const id = crypto.randomUUID();
  const base = createProjectDocument(id, "Scenario", { text: "root" });
  const root = base.view().roots[0]!;
  const nodes = texts.map((text) => createChild(base, root, { text }));
  const bytes = base.snapshot();
  base.destroy();
  const trace = new Trace();
  const replicas = Array.from({ length: count }, (_, i) =>
    openReplica(id, `r${i}`, bytes, trace),
  );
  const node = (replica: Replica, nodeId: string) =>
    replica.doc.view().nodes.find((candidate) => candidate.id === nodeId);
  return {
    id,
    root,
    nodes,
    replicas,
    trace,
    node,
    // Syncs everyone, in a random receiving order, and checks agreement.
    sync(rng: Random) {
      return fullSync(shuffled(rng, replicas), "scenario sync");
    },
    close() {
      for (const replica of replicas) closeReplica(replica);
    },
  };
}

function repeat(body: (rng: Random) => void) {
  for (let seed = 1; seed <= REPEAT; seed++) body(random(seed));
}

describe("convergence scenarios", () => {
  test("concurrent moves that would form a cycle keep a valid tree", () => {
    repeat((rng) => {
      const s = scenario(2);
      try {
        const [a, b] = s.nodes as [string, string];
        moveNode(s.replicas[0]!.doc, a, b, 0);
        moveNode(s.replicas[1]!.doc, b, a, 0);
        s.sync(rng);
        const view = s.replicas[0]!.doc.view();
        const parents = [a, b].map(
          (id) => view.nodes.find((node) => node.id === id)?.parent,
        );
        // Both survive; exactly one move wins.
        expect(
          parents.filter((parent) => parent === a || parent === b),
        ).toHaveLength(1);
      } finally {
        s.close();
      }
    });
  });

  test("a three-way move cycle across replicas keeps a valid tree", () => {
    repeat((rng) => {
      const s = scenario(3);
      try {
        const [a, b, c] = s.nodes as [string, string, string];
        moveNode(s.replicas[0]!.doc, a, b, 0);
        moveNode(s.replicas[1]!.doc, b, c, 0);
        moveNode(s.replicas[2]!.doc, c, a, 0);
        s.sync(rng);
        expect(s.replicas[0]!.doc.view().nodes).toHaveLength(4);
      } finally {
        s.close();
      }
    });
  });

  test("deleting a node while another replica edits it or adds children converges", () => {
    repeat((rng) => {
      const s = scenario(3);
      try {
        const [a, b, c] = s.nodes as [string, string, string];
        const [r0, r1, r2] = s.replicas as [Replica, Replica, Replica];
        deleteSubtree(r0.doc, a);
        editNodeText(r1.doc, a, 0, 1, "edited");
        setNodeNote(r1.doc, a, "note");
        setNodeColor(r1.doc, a, "teal", true);
        const child = createChild(r1.doc, a, { text: "child" });
        moveNode(r1.doc, b, a, 0);
        // A third replica moves the deleted node's new child elsewhere.
        mergeInto(r2, r1.doc.snapshot(), undefined, "r2 <- r1");
        moveNode(r2.doc, child, c, 0);
        s.sync(rng);
        const view = r0.doc.view();
        expect(view.nodes.some((node) => node.id === a)).toBe(false);
      } finally {
        s.close();
      }
    });
  });

  test("overlapping concurrent text edits keep every insertion", () => {
    repeat((rng) => {
      const s = scenario(2, ["abcdef"]);
      try {
        const [a] = s.nodes as [string];
        const [r0, r1] = s.replicas as [Replica, Replica];
        editNodeText(r0.doc, a, 1, 3, "XY");
        editNodeText(r1.doc, a, 2, 3, "Z");
        s.sync(rng);
        const text = s.node(r0, a)!.text;
        expect(text).toContain("XY");
        expect(text).toContain("Z");
        expect(text.startsWith("a")).toBe(true);
        expect(text.endsWith("f")).toBe(true);
      } finally {
        s.close();
      }
    });
  });

  test("concurrent emoji insertions at one position stay whole", () => {
    repeat((rng) => {
      const s = scenario(3, ["x😀y"]);
      try {
        const [a] = s.nodes as [string];
        const [r0, r1, r2] = s.replicas as [Replica, Replica, Replica];
        editNodeText(r0.doc, a, 1, 0, "👩‍👩‍👧");
        editNodeText(r1.doc, a, 3, 0, "é");
        editNodeText(r2.doc, a, 1, 2, "שלום");
        s.sync(rng);
        const text = s.node(r0, a)!.text;
        expect(text).toContain("👩‍👩‍👧");
        expect(text).toContain("é");
        expect(text).toContain("שלום");
        expect(text).not.toContain("😀");
      } finally {
        s.close();
      }
    });
  });

  test("concurrent first note edits on the same node keep both", () => {
    repeat((rng) => {
      const s = scenario(2);
      try {
        const [r0, r1] = s.replicas as [Replica, Replica];
        // An existing node, and one created on r0 and synced to r1.
        const fresh = createChild(r0.doc, s.nodes[0]!, { text: "new" });
        mergeInto(r1, r0.doc.snapshot(), undefined, "r1 <- r0");
        for (const id of [s.nodes[1]!, fresh]) {
          setNodeNote(r0.doc, id, "left");
          editNodeNote(r1.doc, id, 0, 0, "right");
        }
        s.sync(rng);
        for (const id of [s.nodes[1]!, fresh]) {
          const note = s.node(r0, id)!.note;
          expect(note).toContain("left");
          expect(note).toContain("right");
        }
      } finally {
        s.close();
      }
    });
  });

  test("concurrent reorders keep each sibling exactly once", () => {
    repeat((rng) => {
      const s = scenario(3, ["a", "b", "c", "d"]);
      try {
        const [a, b, c, d] = s.nodes as [string, string, string, string];
        const [r0, r1, r2] = s.replicas as [Replica, Replica, Replica];
        reorderNode(r0.doc, a, 1);
        reorderNode(r0.doc, a, 1);
        reorderNode(r1.doc, d, -1);
        reorderNode(r1.doc, a, 1);
        moveNode(r2.doc, c, s.root, 0);
        s.sync(rng);
        const children = s.node(r0, s.root)!.children;
        expect([...children].sort()).toEqual([a, b, c, d].sort());
      } finally {
        s.close();
      }
    });
  });

  test("undo after receiving remote edits reverts only local edits", () => {
    repeat((rng) => {
      const s = scenario(2);
      try {
        const [a, b] = s.nodes as [string, string];
        const [r0, r1] = s.replicas as [Replica, Replica];
        editNodeText(r0.doc, a, 1, 0, "L");
        r0.history.finishGroup();
        setNodeColor(r1.doc, a, "amber");
        editNodeText(r1.doc, a, 0, 0, "R");
        editNodeText(r1.doc, b, 0, 0, "R");
        const remoteChild = createChild(r1.doc, a, { text: "remote" });
        mergeInto(r0, r1.doc.snapshot(), undefined, "r0 <- r1");
        expect(s.node(r0, a)!.text).toBe("RaL");
        r0.history.undo();
        valid(r0.doc, "after undo");
        expect(s.node(r0, a)).toMatchObject({ text: "Ra", color: "amber" });
        expect(s.node(r0, b)!.text).toBe("Rb");
        expect(s.node(r0, remoteChild)?.parent).toBe(a);
        r0.history.redo();
        expect(s.node(r0, a)!.text).toBe("RaL");
        r0.history.undo();
        s.sync(rng);
        expect(s.node(r1, a)!.text).toBe("Ra");
      } finally {
        s.close();
      }
    });
  });

  test("undoing a delete that raced remote edits converges", () => {
    repeat((rng) => {
      const s = scenario(2);
      try {
        const [a] = s.nodes as [string];
        const [r0, r1] = s.replicas as [Replica, Replica];
        createChild(r0.doc, a, { text: "grandchild" });
        mergeInto(r1, r0.doc.snapshot(), undefined, "r1 <- r0");
        deleteSubtree(r0.doc, a);
        r0.history.finishGroup();
        editNodeText(r1.doc, a, 1, 0, "R");
        setNodeNote(r1.doc, a, "remote note");
        createChild(r1.doc, a, { text: "remote child" });
        mergeInto(r0, r1.doc.snapshot(), undefined, "r0 <- r1");
        r0.history.undo();
        valid(r0.doc, "after undo");
        expect(s.node(r0, a)).toBeDefined();
        s.sync(rng);
        r0.history.redo();
        s.sync(rng);
      } finally {
        s.close();
      }
    });
  });

  test("undoing a create after a remote replica built on it converges", () => {
    repeat((rng) => {
      const s = scenario(2);
      try {
        const [r0, r1] = s.replicas as [Replica, Replica];
        const created = createChild(r0.doc, s.nodes[0]!, { text: "mine" });
        r0.history.finishGroup();
        mergeInto(r1, r0.doc.snapshot(), undefined, "r1 <- r0");
        createChild(r1.doc, created, { text: "theirs" });
        editNodeText(r1.doc, created, 0, 0, "R");
        mergeInto(r0, r1.doc.snapshot(), undefined, "r0 <- r1");
        r0.history.undo();
        valid(r0.doc, "after undo");
        s.sync(rng);
        r0.history.redo();
        valid(r0.doc, "after redo");
        s.sync(rng);
      } finally {
        s.close();
      }
    });
  });

  test("a replica offline for a long time converges with everyone", () => {
    repeat((rng) => {
      const s = scenario(3);
      try {
        const [r0, r1, r2] = s.replicas as [Replica, Replica, Replica];
        for (let i = 0; i < 80; i++) {
          tryEdit(rng, rng.chance(0.5) ? r0.doc : r1.doc);
          if (rng.chance(0.2)) {
            mergeInto(r1, r0.doc.snapshot(), undefined, "r1 <- r0");
            mergeInto(r0, r1.doc.snapshot(), undefined, "r0 <- r1");
          }
        }
        for (let i = 0; i < 30; i++) tryEdit(rng, r2.doc);
        s.sync(rng);
      } finally {
        s.close();
      }
    });
  });
});

// ----------------------------------------------------------------- repros --
// Regression tests for fuzzer findings. The skipped ones document Loro's
// collaborative-undo semantics, reproducible with plain Loro and on main:
// undo restores what the local step replaced even if a collaborator changed
// it since, and undoing a delete recreates the branch as it was deleted.

// Undoing a move (or reorder) of a node that a remote replica has since
// deleted, directly or through an ancestor, used to leave a tree node without
// metadata: view() threw "Missing stable node ID", the replica could no longer
// render, and every other replica rejected its snapshots. The engine now
// removes such blank nodes after undo and redo. Undoing text, color or create edits on deleted nodes is fine.
test("undoing a move of a node that a remote replica deleted leaves no blank idea", () => {
  const cases: [string, (s: ReturnType<typeof scenario>) => void][] = [
    [
      "remote deletes the new parent",
      (s) => deleteSubtree(s.replicas[1]!.doc, s.nodes[1]!),
    ],
    [
      "remote deletes the moved node",
      (s) => deleteSubtree(s.replicas[1]!.doc, s.nodes[0]!),
    ],
  ];
  for (const [, remote] of cases) {
    const s = scenario(2);
    try {
      const [a, b] = s.nodes as [string, string];
      const [r0, r1] = s.replicas as [Replica, Replica];
      moveNode(r0.doc, a, b, 0); // or reorderNode(r0.doc, a, 1)
      r0.history.finishGroup();
      r1.doc.merge(r0.doc.snapshot());
      remote(s);
      r0.doc.merge(r1.doc.snapshot());
      r0.history.undo();
      checkView(r0.doc.view()); // throws: Missing stable node ID
      r1.doc.merge(r0.doc.snapshot()); // throws too
      expect(canonical(r1.doc)).toBe(canonical(r0.doc));
    } finally {
      s.close();
    }
  }
});

// Replica r0 deletes a node while r1 concurrently edits its text and note and
// adds a child. After r0 merges r1 and undoes the delete, the node comes back
// as it was before the delete: r1's text, note and new child are gone, and
// syncing spreads the loss to r1 too (it is not just a local view). Undo
// recreates the branch rather than restoring the deleted tree nodes, so edits
// made to the originals are orphaned. Undo should only revert local edits.
test.skip("repro: undoing a delete drops concurrent remote edits to the branch", () => {
  repeat((rng) => {
    const s = scenario(2);
    try {
      const [a] = s.nodes as [string];
      const [r0, r1] = s.replicas as [Replica, Replica];
      deleteSubtree(r0.doc, a);
      r0.history.finishGroup();
      editNodeText(r1.doc, a, 1, 0, "R");
      setNodeNote(r1.doc, a, "remote note");
      const child = createChild(r1.doc, a, { text: "remote child" });
      mergeInto(r0, r1.doc.snapshot(), undefined, "r0 <- r1");
      r0.history.undo();
      valid(r0.doc, "after undo");
      expect(s.node(r0, a)).toMatchObject({ text: "aR", note: "remote note" });
      expect(s.node(r0, child)?.parent).toBe(a);
      s.sync(rng);
      expect(s.node(r1, a)).toMatchObject({ text: "aR", note: "remote note" });
    } finally {
      s.close();
    }
  });
});

// After a concurrent sibling insert, undoing and redoing a create (or move)
// does not put the node back where it was: about half the time (depending on
// peer tie-breaks) "abcd" -undo-> "abd" -redo-> "abdc". Without concurrent
// siblings the order is restored. Converges, but the user's order drifts.
test.skip("repro: undo then redo of a create keeps sibling order after concurrent inserts", () => {
  repeat((rng) => {
    const s = scenario(2);
    try {
      const [r0, r1] = s.replicas as [Replica, Replica];
      createChild(r0.doc, s.root, { text: "mine" });
      r0.history.finishGroup();
      createChild(r1.doc, s.root, { text: "theirs" });
      s.sync(rng);
      const order = () => s.node(r0, s.root)!.children.join();
      const before = order();
      r0.history.undo();
      r0.history.redo();
      expect(order()).toBe(before);
    } finally {
      s.close();
    }
  });
});

// EditHistory pairs each Loro undo step with browser selection metadata. When
// the next undo step only edited a node another replica deleted, Loro skips it
// and reverts the older step in the same call, but EditHistory hands out the
// skipped step's entry; every later restore is then off by one, so the caret
// returns to the wrong node. Observed: undo:C, undo:B, redo:B, redo:C.
test("undo selection entries stay paired when Loro skips a remotely deleted step", () => {
  const s = scenario(2);
  try {
    const [a, b, c] = s.nodes as [string, string, string];
    const [r0, r1] = s.replicas as [Replica, Replica];
    const history = r0.history;
    let label = "";
    history.onRecord((entry) => {
      entry.before = label;
    });
    const restored: string[] = [];
    history.onRestore(({ entry, direction }) =>
      restored.push(`${direction}:${entry.before}`),
    );
    for (const [id, text] of [
      [a, "A"],
      [b, "B"],
      [c, "C"],
    ] as const) {
      label = text;
      editNodeText(r0.doc, id, 0, 0, text);
      history.finishGroup();
    }
    r1.doc.merge(r0.doc.snapshot());
    deleteSubtree(r1.doc, b);
    r0.doc.merge(r1.doc.snapshot());
    history.undo(); // reverts C
    history.undo(); // Loro skips B (deleted) and reverts A
    history.redo();
    history.redo();
    expect(restored).toEqual(["undo:C", "undo:A", "redo:A", "redo:C"]);
  } finally {
    s.close();
  }
});

// Undo restores the value a field had before the local edit even when another
// replica has since overwritten it: r1 sets teal, r0 later sets amber, r1's
// undo makes it blue again, discarding r0's newer edit on every replica once
// synced. Same for the project name, positions and moves (parent). Text is
// unaffected (its undo is a CRDT delta). Undo should leave a value that a
// newer remote edit superseded alone.
test.skip("repro: undo does not overwrite a newer remote value of the same field", () => {
  repeat((rng) => {
    const s = scenario(2);
    try {
      const [a, b, c] = s.nodes as [string, string, string];
      const [r0, r1] = s.replicas as [Replica, Replica];
      setNodeColor(r1.doc, a, "teal");
      moveNode(r1.doc, a, b, 0);
      r1.history.finishGroup();
      mergeInto(r0, r1.doc.snapshot(), undefined, "r0 <- r1");
      setNodeColor(r0.doc, a, "amber");
      moveNode(r0.doc, a, c, 0);
      mergeInto(r1, r0.doc.snapshot(), undefined, "r1 <- r0");
      r1.history.undo();
      s.sync(rng);
      expect(s.node(r0, a)).toMatchObject({ color: "amber", parent: c });
    } finally {
      s.close();
    }
  });
});
