import { beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Y } from "./fixtures/project-document";
import {
  materialize,
  present,
  nodeMap,
  ORIGIN,
  projectForest,
  type Content,
  type ForestNode,
} from "./fixtures/project-document";
import {
  base,
  capture,
  fork,
  ID,
  seededRandom,
  shuffle,
  text,
} from "./fixtures/yjs-scenarios";
const root = join(import.meta.dir, "../..");
const manifest = join(root, "server/Cargo.toml");
const binary = join(root, "server/target/debug/examples/yjs_interop");
beforeAll(() => {
  const result = Bun.spawnSync(
    [
      "mise",
      "-C",
      join(root, "server"),
      "exec",
      "--",
      "cargo",
      "build",
      "--locked",
      "--example",
      "yjs_interop",
      "--manifest-path",
      manifest,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode) throw new Error(result.stderr.toString());
}, 120_000);
type Result = {
  content: Content;
  forest: ForestNode[];
  update: number[];
  diff: number[];
  stateVector: number[];
  pending: boolean;
  error?: string;
};
function rust(
  updates: Uint8Array[],
  options: {
    batch?: boolean;
    edit?: { node: string; index: number; delete: number; insert: string };
    stateVector?: number[];
  } = {},
): Result {
  const process = Bun.spawnSync([binary], {
    stdin: Buffer.from(
      `${JSON.stringify({
        updates: updates.map((update) => [...update]),
        ...options,
      })}\n`,
    ),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (process.exitCode) throw new Error(process.stderr.toString());
  const result: Result = JSON.parse(process.stdout.toString());
  if (result.error) throw new Error(result.error);
  return result;
}
function assertRoundTrip(result: Result, expected: Content) {
  expect(result.pending).toBe(false);
  expect(result.content).toEqual(expected);
  expect(result.forest).toEqual(projectForest(expected));
  const back = new Y.Doc();
  Y.applyUpdate(back, new Uint8Array(result.update));
  expect(materialize(back)).toEqual(expected);
  expect(back.store.pendingStructs).toBeNull();
  expect(back.store.pendingDs).toBeNull();
  back.destroy();
}
for (const file of readdirSync(join(import.meta.dir, "fixtures/yjs")).filter(
  (name) => name.endsWith(".json"),
)) {
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures/yjs", file), "utf8"),
  ) as { updates: string[]; expected: Content; forest: ForestNode[] };
  test(`golden ${file}: JS → Rust → JS, both transaction modes`, () => {
    const updates = fixture.updates.map(
      (name) =>
        new Uint8Array(
          readFileSync(join(import.meta.dir, "fixtures/yjs", name)),
        ),
    );
    const js = new Y.Doc();
    for (const update of updates) Y.applyUpdate(js, update);
    expect(materialize(js)).toEqual(fixture.expected);
    expect(projectForest(materialize(js))).toEqual(fixture.forest);
    for (const batch of [false, true])
      assertRoundTrip(rust(updates, { batch }), fixture.expected);
    js.destroy();
  });
}
test("Rust edits UTF-16 text after an emoji, deletes emoji, and sends a state-vector diff", () => {
  const doc = base();
  const initial = Y.encodeStateAsUpdate(doc);
  const stateVector = [...Y.encodeStateVector(doc)];
  const result = rust([initial], {
    edit: { node: ID(1), index: 3, delete: 1, insert: "🧠" },
    stateVector,
  });
  doc.transact(() => {
    text(doc).delete(3, 1);
    text(doc).insert(3, "🧠");
  }, ORIGIN.local);
  assertRoundTrip(result, materialize(doc));
  const receiver = base();
  Y.applyUpdate(receiver, new Uint8Array(result.diff));
  expect(materialize(receiver)).toEqual(materialize(doc));
  const deleted = rust([initial], {
    edit: { node: ID(1), index: 1, delete: 2, insert: "" },
    stateVector,
  });
  const deletionReceiver = base();
  Y.applyUpdate(deletionReceiver, new Uint8Array(deleted.diff));
  expect(text(deletionReceiver).toString()).toBe("Aé中B");
  expect(deleted.stateVector).toEqual(stateVector); // Delete-only update is not visible in the vector.
  expect(deleted.diff.length).toBeGreaterThan(2);
  for (const item of [doc, receiver, deletionReceiver]) item.destroy();
});
test("pending text dependency survives Rust full encoding and replay before arrival", () => {
  const doc = base();
  const initial = Y.encodeStateAsUpdate(doc);
  const updates = capture(doc, () => {
    doc.transact(() => text(doc).insert(text(doc).length, "x"), ORIGIN.local);
    doc.transact(() => text(doc).insert(text(doc).length, "y"), ORIGIN.local);
  });
  const pending = rust([initial, updates[1]]);
  expect(pending.pending).toBe(true);
  const recovered = rust([new Uint8Array(pending.update), updates[0]]);
  assertRoundTrip(recovered, materialize(doc));
  doc.destroy();
});
for (let seed = 1; seed <= 32; seed++) {
  test(`seed ${seed}: concurrent edits/deletes/map writes with duplicate shuffled delivery`, () => {
    const initialDoc = base();
    const initial = Y.encodeStateAsUpdate(initialDoc);
    const random = seededRandom(seed);
    const updates: Uint8Array[] = [];
    const peers = [
      fork(initialDoc, 10),
      fork(initialDoc, 11),
      fork(initialDoc, 12),
    ];
    for (const peer of peers)
      updates.push(
        ...capture(peer, () => {
          // A single shared text provides real causal dependencies, without the
          // independent same-client gaps exercised by the storage API suite.
          for (let step = 0; step < 12; step++)
            peer.transact(() => {
              const value = text(peer, ID(2));
              if (random() < 0.4 && value.length)
                value.delete(Math.floor(random() * value.length), 1);
              else
                value.insert(
                  Math.floor(random() * (value.length + 1)),
                  String.fromCharCode(97 + Math.floor(random() * 26)),
                );
            }, ORIGIN.local);
          peer.transact(() => {
            present(nodeMap(peer).get(ID(1))).set("position", {
              x: Math.floor(random() * 100),
              y: Math.floor(random() * 100),
            });
            present(nodeMap(peer).get(ID(3))).set("placement", {
              parent: random() < 0.5 ? ID(1) : null,
              rank: "a0",
            });
          }, ORIGIN.local);
        }),
      );
    // Keep the final independent map transaction after its client's text edits;
    // fully shuffle all causally dependent text edits and their duplicates.
    const mapUpdates = updates.filter((_, i) => i % 13 === 12);
    const textUpdates = updates.filter((_, i) => i % 13 !== 12);
    const shuffled = [
      initial,
      ...shuffle([...textUpdates, ...textUpdates.slice(0, 8)], random),
      ...shuffle(mapUpdates, random),
    ];
    const oracle = new Y.Doc();
    for (const update of [initial, ...updates]) Y.applyUpdate(oracle, update);
    const expected = materialize(oracle);
    const js = new Y.Doc();
    for (const update of shuffled) Y.applyUpdate(js, update);
    expect(materialize(js)).toEqual(expected);
    assertRoundTrip(rust(shuffled, { batch: seed % 2 === 0 }), expected);
    for (const item of [initialDoc, oracle, js, ...peers]) item.destroy();
  });
}
