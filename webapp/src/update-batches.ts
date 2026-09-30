import { writeVarUint } from "lib0/encoding";
import * as Y from "yjs";
import { SyncError } from "./crdt-api";

type Decoded = ReturnType<typeof Y.decodeUpdate>;
type Struct = Decoded["structs"][number];
type DeleteRange = { client: number; clock: number; len: number };

// Uses the pinned Yjs V1 encoder, preserving original IDs/causal references.
// This is transport chunking, never reconstruction from semantic JSON.
function encode(structs: Struct[], ranges: DeleteRange[]) {
  const encoder = new Y.UpdateEncoderV1();
  const clients = new Map<number, Struct[]>();
  for (const struct of structs) {
    const group = clients.get(struct.id.client) ?? [];
    group.push(struct);
    clients.set(struct.id.client, group);
  }
  writeVarUint(encoder.restEncoder, clients.size);
  for (const [client, group] of clients) {
    writeVarUint(encoder.restEncoder, group.length);
    encoder.writeClient(client);
    writeVarUint(encoder.restEncoder, group[0].id.clock);
    for (const struct of group) struct.write(encoder, 0);
  }
  const deletes = new Map<number, DeleteRange[]>();
  for (const range of ranges) {
    const group = deletes.get(range.client) ?? [];
    group.push(range);
    deletes.set(range.client, group);
  }
  writeVarUint(encoder.restEncoder, deletes.size);
  for (const [client, group] of deletes) {
    encoder.resetDsCurVal();
    writeVarUint(encoder.restEncoder, client);
    writeVarUint(encoder.restEncoder, group.length);
    for (const range of group) {
      encoder.writeDsClock(range.clock);
      encoder.writeDsLen(range.len);
    }
  }
  return encoder.toUint8Array();
}

export function updateBatches(bytes: Uint8Array, limit = 1024 * 1024) {
  if (bytes.length <= limit) return [bytes];
  const { structs, ds } = Y.decodeUpdate(bytes);
  const chunks: Uint8Array[] = [];
  const split = (items: Struct[] | DeleteRange[], deletes: boolean) => {
    const encoded = deletes
      ? encode([], items as DeleteRange[])
      : encode(items as Struct[], []);
    if (encoded.length <= limit) {
      chunks.push(encoded);
      return;
    }
    if (items.length < 2)
      throw new SyncError(
        "A single change exceeds the cloud update limit. Your local work is retained.",
        "blocked",
      );
    const middle = Math.floor(items.length / 2);
    split(items.slice(0, middle), deletes);
    split(items.slice(middle), deletes);
  };
  if (structs.length) split(structs, false);
  const ranges = [...ds.clients].flatMap(([client, intervals]) =>
    intervals.map((range) => ({ client, ...range })),
  );
  if (ranges.length) split(ranges, true);
  // Dependencies last: intermediate chunks remain pending instead of exposing
  // a half-created node/schema to the backend validator. Delete sets go first.
  return chunks.reverse();
}
