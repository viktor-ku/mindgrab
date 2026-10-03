import {
  checkSharedTypes,
  LIMITS,
  materializeProject,
  type ProjectContent,
  ProjectDocumentError,
  SCHEMA_VERSION,
} from "@mindgrab/document/project-document";
import * as Y from "yjs";
import { ApiError } from "../errors";
import { preflight } from "./wire";

export const MAX_UPDATE_BYTES = 1048576;
export const MAX_DOCUMENT_BYTES = 10485760;
export const MAX_TAIL_ROWS = 10000;
export const MAX_PAGE_BYTES = 2097152;
export type Validation = "valid" | "pending_dependencies" | "quarantined";
export interface Candidate {
  bytes: Uint8Array;
  stateVector: Uint8Array;
  validation: Exclude<Validation, "quarantined">;
  content?: ProjectContent;
  checkpoint?: Uint8Array;
}

function schema(doc: Y.Doc) {
  if (doc.share.size !== 1 || !doc.share.has("project"))
    throw new ApiError("invalid_schema");
  const root = doc.getMap("project");
  if (typeof root.get("schemaVersion") !== "number")
    throw new ApiError("invalid_schema");
  if (root.get("schemaVersion") !== SCHEMA_VERSION)
    throw new ApiError("unsupported_schema");
  const nodes = root.get("nodes");
  const metadata = root.get("metadata");
  if (nodes instanceof Y.Map) {
    if (nodes.size > LIMITS.nodes) throw new ApiError("resource_limit");
    for (const node of nodes.values()) {
      if (!(node instanceof Y.Map)) continue;
      const text = node.get("text");
      const placement = node.get("placement");
      if (
        (text instanceof Y.Text && text.length > LIMITS.text) ||
        (typeof placement?.rank === "string" &&
          placement.rank.length > LIMITS.rank)
      )
        throw new ApiError("resource_limit");
    }
  }
  const name = metadata instanceof Y.Map ? metadata.get("name") : undefined;
  if (
    typeof name === "string" &&
    new TextEncoder().encode(name).length > LIMITS.nameBytes
  )
    throw new ApiError("resource_limit");
  try {
    checkSharedTypes(doc);
    return materializeProject(doc);
  } catch (error) {
    throw new ApiError(
      error instanceof ProjectDocumentError && error.reason === "unsupported"
        ? "unsupported_schema"
        : "invalid_schema",
    );
  }
}

// Compare actual insertion and deletion coverage, never encoded byte order or
// state vectors alone (delete-only updates do not advance a vector).
function coverage(bytes: Uint8Array) {
  const decoded = Y.decodeUpdate(bytes);
  const ranges = new Map<number, [number, number][]>();
  for (const struct of decoded.structs) {
    if (struct instanceof Y.Skip) continue;
    const list = ranges.get(struct.id.client) ?? [];
    list.push([struct.id.clock, struct.id.clock + struct.length]);
    ranges.set(struct.id.client, list);
  }
  for (const [client, values] of ranges) {
    const merged: [number, number][] = [];
    for (const range of values.sort((a, b) => a[0] - b[0])) {
      const previous = merged.at(-1);
      if (previous && range[0] <= previous[1])
        previous[1] = Math.max(previous[1], range[1]);
      else merged.push([...range]);
    }
    ranges.set(client, merged);
  }
  return { ranges, deletes: decoded.ds.clients };
}

function covered(source: Uint8Array, checkpoint: Uint8Array) {
  const original = coverage(source);
  const encoded = coverage(checkpoint);
  const contains = (
    range: [number, number],
    candidates: [number, number][],
  ) => {
    let clock = range[0];
    for (const [start, end] of candidates.sort((a, b) => a[0] - b[0])) {
      if (start > clock) break;
      clock = Math.max(clock, end);
      if (clock >= range[1]) return true;
    }
    return false;
  };
  for (const [client, ranges] of original.ranges)
    for (const range of ranges)
      if (!contains(range, encoded.ranges.get(client) ?? [])) return false;
  for (const [client, ranges] of original.deletes)
    for (const range of ranges)
      if (
        !contains(
          [range.clock, range.clock + range.len],
          (encoded.deletes.get(client) ?? []).map((value) => [
            value.clock,
            value.clock + value.len,
          ]),
        )
      )
        return false;
  return true;
}

export function reconstruct(
  updates: Uint8Array[],
  checkpoint = false,
): Candidate {
  if (
    updates.length > MAX_TAIL_ROWS + 1 ||
    updates.reduce((size, update) => size + update.length, 0) >
      MAX_DOCUMENT_BYTES
  )
    throw new ApiError("resource_limit");
  for (const update of updates) preflight(update);
  const doc = new Y.Doc({ gc: false });
  try {
    const bytes = Y.mergeUpdates(updates);
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new ApiError("resource_limit");
    Y.applyUpdate(doc, bytes);
    const pending = Boolean(doc.store.pendingStructs || doc.store.pendingDs);
    const candidate: Candidate = {
      bytes,
      stateVector: Y.encodeStateVector(doc),
      validation: pending ? "pending_dependencies" : "valid",
      ...(!pending && { content: schema(doc) }),
    };
    if (checkpoint && !pending) {
      const encoded = Y.encodeStateAsUpdate(doc);
      if (encoded.length <= MAX_DOCUMENT_BYTES && covered(bytes, encoded)) {
        const fresh = reconstruct([encoded]);
        if (
          fresh.validation === "valid" &&
          Bun.deepEquals(fresh.content, candidate.content)
        )
          candidate.checkpoint = encoded;
      }
    }
    return candidate;
  } catch (error) {
    throw error instanceof ApiError ? error : new ApiError("invalid_update");
  } finally {
    doc.destroy();
  }
}
