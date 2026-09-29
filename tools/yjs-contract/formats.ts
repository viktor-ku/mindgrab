import * as Y from "yjs";
import {
  ORIGIN,
  assertId,
  createDocument,
  addNode,
  LIMITS,
  materialize,
  openDocument,
  validateContent,
} from "./contract";

// Public JSON is a portable content copy. Import always creates a fresh lineage.
export function exportJSON(doc: Y.Doc): string {
  assertId(doc.guid);
  const json = `${JSON.stringify(
    {
      format: "mindgrab-project",
      version: 2,
      sourceProjectId: doc.guid,
      content: materialize(doc),
    },
    null,
    2,
  )}\n`;
  if (new TextEncoder().encode(json).length > LIMITS.recoveryBytes)
    throw new Error("File too large");
  return json;
}
export function importJSON(json: string, newProjectId: string): Y.Doc {
  if (new TextEncoder().encode(json).length > LIMITS.recoveryBytes)
    throw new Error("File too large");
  const value = JSON.parse(json);
  if (value?.format !== "mindgrab-project" || value.version !== 2)
    throw new Error("Unsupported public format");
  assertId(value.sourceProjectId);
  assertId(newProjectId);
  if (newProjectId === value.sourceProjectId)
    throw new Error("Content copies require a new project UUID");
  const content = validateContent(value.content);
  const doc = createDocument(newProjectId, content.metadata.name);
  for (const [id, node] of Object.entries(content.nodes))
    addNode(doc, id, node, ORIGIN.import);
  return doc;
}
const magic = new TextEncoder().encode("MGRABY01");
export function exportRecovery(doc: Y.Doc): Uint8Array {
  materialize(doc);
  assertId(doc.guid);
  const update = Y.encodeStateAsUpdate(doc);
  const header = new TextEncoder().encode(
    JSON.stringify({
      projectId: doc.guid,
      schemaVersion: 1,
      encoding: "yjs-v1",
      updateLength: update.length,
    }),
  );
  const result = new Uint8Array(12 + header.length + update.length);
  if (result.length > LIMITS.recoveryBytes) throw new Error("File too large");
  result.set(magic);
  new DataView(result.buffer).setUint32(8, header.length, true);
  result.set(header, 12);
  result.set(update, 12 + header.length);
  return result;
}
export function importRecovery(bytes: Uint8Array): Y.Doc {
  if (
    bytes.length < 12 ||
    bytes.length > LIMITS.recoveryBytes ||
    !magic.every((byte, i) => bytes[i] === byte)
  )
    throw new Error("Invalid recovery envelope");
  const length = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(8, true);
  if (length > 4096 || 12 + length >= bytes.length)
    throw new Error("Invalid recovery header");
  const header = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(12, 12 + length),
    ),
  );
  if (
    header.schemaVersion !== 1 ||
    header.encoding !== "yjs-v1" ||
    header.updateLength !== bytes.length - 12 - length
  )
    throw new Error("Unsupported or truncated recovery file");
  return openDocument(header.projectId, bytes.subarray(12 + length));
}
