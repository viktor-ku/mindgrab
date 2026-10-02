import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type Content,
  type ForestNode,
  materialize,
  ORIGIN,
  projectForest,
  Y,
} from "./fixtures/project-document";
import { base, capture, ID, text } from "./fixtures/yjs-scenarios";

// Shared goldens run through ingestion and read-model projection in the Rust
// suite; these two cases exercise the Rust writer and pending-update encoding.
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
