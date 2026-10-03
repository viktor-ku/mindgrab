import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import {
  effectivePlacements,
  materializeProject,
  projectForest,
} from "@mindgrab/document/project-document";
import * as Y from "yjs";
import { addNode } from "../../webapp/tests/fixtures/project-document";
import {
  base,
  capture,
  ID,
  node,
  text,
} from "../../webapp/tests/fixtures/yjs-scenarios";
import { ApiError } from "../src/errors";
import { reconstruct } from "../src/project/document";
import { DocumentPool } from "../src/project/document-pool";
import { syncFrame } from "../src/project/sync";
import { decodeFrame, preflight } from "../src/project/wire";

test("golden documents, projections, and checkpoints agree in all delivery schedules", async () => {
  const directory = new URL(
    "../../webapp/tests/fixtures/yjs/",
    import.meta.url,
  );
  for (const name of (await readdir(directory)).filter((name) =>
    name.endsWith(".json"),
  )) {
    const fixture = await Bun.file(new URL(name, directory)).json();
    const originals = await Promise.all(
      fixture.updates.map(
        async (name: string) =>
          new Uint8Array(
            await Bun.file(new URL(name, directory)).arrayBuffer(),
          ),
      ),
    );
    for (const updates of [
      originals,
      [...originals].reverse(),
      originals.flatMap((update) => [update, update]),
    ]) {
      const candidate = reconstruct(updates, true);
      expect(candidate.validation).toBe("valid");
      expect(candidate.content).toEqual(fixture.expected);
      expect(projectForest(candidate.content!)).toEqual(fixture.forest);
      expect(candidate.checkpoint).toBeDefined();
      expect(reconstruct([candidate.checkpoint!]).content).toEqual(
        fixture.expected,
      );
    }
  }
});

test("causal gaps and pending checkpoint bytes survive every delivery order", () => {
  const writer = base();
  const initial = Y.encodeStateAsUpdate(writer);
  const a = capture(writer, () => text(writer).insert(0, "A"))[0];
  const b = capture(writer, () => text(writer).insert(1, "B"))[0];
  const c = capture(writer, () => text(writer, ID(2)).insert(0, "C"))[0];
  const expected = materializeProject(writer);
  for (const order of [
    [a, b, c],
    [a, c, b],
    [b, a, c],
    [b, c, a],
    [c, a, b],
    [c, b, a],
  ])
    expect(reconstruct([initial, ...order], true).content).toEqual(expected);
  const pending = reconstruct([initial, b, c], true);
  expect(pending.validation).toBe("pending_dependencies");
  expect(pending.content).toBeUndefined();
  expect(pending.checkpoint).toBeUndefined();
  expect(reconstruct([pending.bytes, a], true).content).toEqual(expected);
  writer.destroy();
});

test("independent same-client gaps and unresolved deletes cannot be compacted", () => {
  const writer = base();
  const initial = Y.encodeStateAsUpdate(writer);
  const nodes = writer.getMap("project").get("nodes") as Y.Map<Y.Map<unknown>>;
  const predecessor = capture(writer, () =>
    nodes.get(ID(1))!.set("color", "rose"),
  )[0];
  const gapped = capture(writer, () =>
    nodes.get(ID(2))!.set("color", "teal"),
  )[0];
  const pending = reconstruct([initial, gapped], true);
  expect(pending.validation).toBe("pending_dependencies");
  expect(pending.checkpoint).toBeUndefined();
  expect(reconstruct([pending.bytes, predecessor], true).content).toEqual(
    materializeProject(writer),
  );
  const deleteBase = Y.encodeStateAsUpdate(writer);
  const insertion = capture(writer, () => text(writer).insert(0, "new"))[0];
  const deletion = capture(writer, () => text(writer).delete(0, 3))[0];
  const deletePending = reconstruct([deleteBase, deletion], true);
  expect(deletePending.validation).toBe("pending_dependencies");
  expect(deletePending.checkpoint).toBeUndefined();
  expect(reconstruct([deletePending.bytes, insertion], true).content).toEqual(
    materializeProject(writer),
  );
  writer.destroy();
});

test("delete-only changes survive checkpoints without advancing state vectors", () => {
  const writer = base();
  const initial = Y.encodeStateAsUpdate(writer);
  const vector = Y.encodeStateVector(writer);
  const deletion = capture(writer, () => text(writer).delete(1, 2))[0];
  expect(Y.encodeStateVector(writer)).toEqual(vector);
  const compacted = reconstruct([initial, deletion], true);
  expect(compacted.checkpoint).toBeDefined();
  expect(reconstruct([compacted.checkpoint!]).content).toEqual(
    materializeProject(writer),
  );
  writer.destroy();
});

test("binary preflight bounds allocation, nesting, clocks, shared types and trailing bytes", () => {
  for (const invalid of [
    [],
    [0],
    [0, 0, 0],
    [255, 255, 255, 255, 31],
    [1, 255, 255, 255, 255, 15],
    [0, 1, 1, 1, 255, 255, 255, 255, 15, 1],
  ])
    expect(() => preflight(new Uint8Array(invalid))).toThrow(ApiError);
  const doc = base();
  doc.getMap("project").set("xml", new Y.XmlFragment());
  expect(() => reconstruct([Y.encodeStateAsUpdate(doc)])).toThrow(ApiError);
  doc.destroy();
});

test("socket envelopes reject trailing bytes and oversized state vectors", () => {
  expect(decodeFrame(syncFrame(0, new Uint8Array([0])))).toEqual({
    kind: "step1",
    bytes: new Uint8Array([0]),
  });
  for (const invalid of [
    [0, 9, 0],
    [0, 0, 1, 0, 0],
    [3, 0],
    [0, 0, 3, 255, 255, 1],
    [0, 0, 1, 1],
  ])
    expect(() => decodeFrame(new Uint8Array(invalid))).toThrow(ApiError);
});

test("the shared flat projection handles a ten-thousand-node chain", () => {
  const doc = base();
  for (let index = 4; index <= 10000; index++)
    addNode(doc, ID(index), node("", ID(index - 1)));
  const placements = effectivePlacements(materializeProject(doc));
  expect(Object.keys(placements)).toHaveLength(10000);
  expect(placements[ID(10000)].parent).toBe(ID(9999));
  doc.destroy();
});

test("bounded reconstruction workers recover from invalid jobs and close cleanly", async () => {
  const pool = new DocumentPool();
  const doc = base();
  const initial = Y.encodeStateAsUpdate(doc);
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => pool.run([initial], true)),
    );
    expect(
      results.every(
        (result) => result.validation === "valid" && result.checkpoint,
      ),
    ).toBe(true);
    expect(
      await pool.run([new Uint8Array([255])]).catch((error) => error),
    ).toBeInstanceOf(ApiError);
    expect((await pool.run([initial])).content).toEqual(
      materializeProject(doc),
    );
  } finally {
    await pool.close();
    doc.destroy();
  }
  await expect(pool.run([initial])).rejects.toBeInstanceOf(ApiError);
});
