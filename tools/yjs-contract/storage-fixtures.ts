// Called by the SQLx storage API suite. Uses the same pinned browser library.
import * as Y from "yjs";
import {
  addNode,
  materialize,
  nodeMap,
  present,
  projectForest,
} from "./contract";
import { base, capture, ID, node, text } from "./scenarios";

const input = await Bun.stdin.json();
if (input.large) {
  const doc = base();
  for (let i = 10; i < 266; i++) addNode(doc, ID(i), node("x".repeat(32_000)));
  console.log(JSON.stringify({ checkpoint: [...Y.encodeStateAsUpdate(doc)] }));
  doc.destroy();
} else if (input.verify || input.inspect) {
  const doc = new Y.Doc();
  for (const bytes of input.updates) Y.applyUpdate(doc, new Uint8Array(bytes));
  if (input.verify && (doc.store.pendingStructs || doc.store.pendingDs))
    throw Error("Pending content");
  const content = input.inspect
    ? doc.getMap("project").toJSON()
    : materialize(doc);
  console.log(
    JSON.stringify({
      content,
      ...(input.verify ? { forest: projectForest(materialize(doc)) } : {}),
      pending: Boolean(doc.store.pendingStructs || doc.store.pendingDs),
    }),
  );
  doc.destroy();
} else {
  const doc = base();
  const initial = Y.encodeStateAsUpdate(doc);
  // #670: same-client text dependency and an independent operation after it.
  const u1 = capture(doc, () => text(doc).insert(0, "A"))[0];
  const u2 = capture(doc, () => text(doc).insert(1, "B"))[0];
  const u3 = capture(doc, () => text(doc, ID(2)).insert(0, "C"))[0];
  const causalExpected = materialize(doc);
  // #673: independent atomic fields on one client, with the first withheld.
  const gapBase = Y.encodeStateAsUpdate(doc);
  const predecessor = capture(doc, () =>
    present(nodeMap(doc).get(ID(1))).set("color", "rose"),
  )[0];
  const gapped = capture(doc, () =>
    present(nodeMap(doc).get(ID(2))).set("color", "teal"),
  )[0];
  const gapExpected = materialize(doc);
  const deleteBase = Y.encodeStateAsUpdate(doc);
  const deletion = capture(doc, () => text(doc).delete(0, 2))[0];
  const deleteExpected = materialize(doc);
  const invalidBase = Y.encodeStateAsUpdate(doc);
  const withheld = capture(doc, () => text(doc).insert(0, "dependency"))[0];
  const invalidPending = capture(doc, () =>
    present(nodeMap(doc).get(ID(2))).set("color", "unknown"),
  )[0];
  const limits: { bytes: number[]; status: number }[] = [];
  for (const [field, value, status] of [
    ["name", "x".repeat(201), 413],
    ["schemaVersion", 2, 426],
    ["unknown", true, 422],
    ["text", "x".repeat(65_537), 413],
    ["rich", true, 422],
    ["placement", { rank: "a0" }, 422],
  ] as const) {
    const candidate = base();
    if (field === "name")
      (candidate.getMap("project").get("metadata") as Y.Map<unknown>).set(
        "name",
        value,
      );
    else if (field === "text") text(candidate).insert(0, value as string);
    else if (field === "rich") text(candidate).format(0, 1, { bold: true });
    else if (field === "placement")
      present(nodeMap(candidate).get(ID(1))).set("placement", value);
    else candidate.getMap("project").set(field, value);
    limits.push({ bytes: [...Y.encodeStateAsUpdate(candidate)], status });
    candidate.destroy();
  }
  console.log(
    JSON.stringify({
      initial: [...initial],
      causal: [u1, u2, u3].map((u) => [...u]),
      causalExpected,
      gapBase: [...gapBase],
      predecessor: [...predecessor],
      gapped: [...gapped],
      gapExpected,
      deleteBase: [...deleteBase],
      deletion: [...deletion],
      deleteExpected,
      invalidBase: [...invalidBase],
      withheld: [...withheld],
      invalidPending: [...invalidPending],
      limits,
    }),
  );
  doc.destroy();
}
