import {
  materializeProject,
  projectForest,
} from "@mindgrab/document/project-document";
import * as Y from "yjs";
import { reconstruct } from "../src/project/document";

const input = (await Bun.stdin.json()) as {
  updates: number[][];
  edit?: { node: string; index: number; delete: number; insert: string };
  stateVector?: number[];
};
const doc = new Y.Doc({ gc: false });
try {
  const updates = input.updates.map((bytes) => new Uint8Array(bytes));
  const candidate = reconstruct(updates);
  Y.applyUpdate(doc, candidate.bytes);
  if (input.edit) {
    const node = (
      doc.getMap("project").get("nodes") as Y.Map<Y.Map<unknown>>
    ).get(input.edit.node);
    const text = node?.get("text");
    if (!(text instanceof Y.Text)) throw new Error("Missing shared text");
    const edit = input.edit;
    doc.transact(() => {
      text.delete(edit.index, edit.delete);
      text.insert(edit.index, edit.insert);
    });
  }
  const content = materializeProject(doc);
  console.log(
    JSON.stringify({
      content,
      forest: projectForest(content),
      update: [...Y.encodeStateAsUpdate(doc)],
      diff: [
        ...Y.encodeStateAsUpdate(
          doc,
          input.stateVector ? new Uint8Array(input.stateVector) : undefined,
        ),
      ],
      stateVector: [...Y.encodeStateVector(doc)],
      pending: Boolean(doc.store.pendingStructs || doc.store.pendingDs),
    }),
  );
} finally {
  doc.destroy();
}
