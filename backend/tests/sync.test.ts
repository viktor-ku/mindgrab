import { afterEach, beforeEach, expect, test } from "bun:test";
import { materializeProject } from "@mindgrab/document/project-document";
import type { WebSocketOptions } from "bun";
import * as decoding from "lib0/decoding";
import * as Y from "yjs";
import { base, capture, text } from "../../webapp/tests/fixtures/yjs-scenarios";
import { Backend } from "../src/backend";
import { syncFrame } from "../src/project/sync";
import { type Fixture, fixture, ORIGIN, owner } from "./fixtures";

let f: Fixture;
let credential: string;
let id: string;
let user: bigint;
// DOM's constructor signature omits Bun's native request-header options.
const NativeWebSocket = globalThis.WebSocket as unknown as {
  new (url: string, options: WebSocketOptions): WebSocket;
};
const sockets: WebSocket[] = [];
let second: Backend | undefined;
beforeEach(async () => {
  f = await fixture();
  credential = await f.signIn();
  id = await f.register(credential);
  user = await owner(f.db, id);
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await second?.close();
  second = undefined;
  await f?.close();
});

async function eventually(
  check: () => boolean | Promise<boolean>,
  timeout = 4000,
) {
  const started = performance.now();
  while (!(await check())) {
    if (performance.now() - started > timeout)
      throw new Error("Condition did not converge");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function client(url = f.url, cookie = credential) {
  const doc = new Y.Doc({ gc: false });
  const messages: { kind: number; bytes: Uint8Array }[] = [];
  const socket = new NativeWebSocket(
    `${url.replace("http:", "ws:")}/sync/v1/${id}`,
    {
      headers: { Cookie: cookie, Origin: ORIGIN },
    },
  );
  socket.binaryType = "arraybuffer";
  sockets.push(socket);
  socket.addEventListener("message", (event) => {
    const decoder = decoding.createDecoder(new Uint8Array(event.data));
    if (decoding.readVarUint(decoder) !== 0)
      throw new Error("Unexpected protocol");
    const kind = decoding.readVarUint(decoder);
    const bytes = decoding.readVarUint8Array(decoder);
    messages.push({ kind, bytes });
    if (kind === 1 || kind === 2) Y.applyUpdate(doc, bytes);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Upgrade failed")),
      { once: true },
    );
  });
  await eventually(() => messages.some((message) => message.kind === 0));
  return { socket, doc, messages };
}

test("native Bun sockets exchange y-websocket frames and tail HTTP commits across backend instances", async () => {
  const writer = base();
  await f.backend.services.storage.ingest(
    user,
    id,
    crypto.randomUUID(),
    Y.encodeStateAsUpdate(writer),
  );
  second = new Backend(f.db, f.config, f.provider);
  const server = second.listen(0, "127.0.0.1", false);
  const first = await client();
  const other = await client(`http://127.0.0.1:${server.port}`);
  expect(materializeProject(first.doc)).toEqual(materializeProject(writer));
  first.socket.send(syncFrame(0, Y.encodeStateVector(first.doc)));
  await eventually(() => first.messages.some((message) => message.kind === 1));
  const update = capture(writer, () => text(writer).insert(0, "socket "))[0];
  first.socket.send(syncFrame(2, update));
  await eventually(
    () => text(other.doc).toString() === text(writer).toString(),
  );
  const deletion = capture(writer, () => text(writer).delete(0, 7))[0];
  expect((await f.submit(credential, id, deletion)).status).toBe(201);
  await eventually(
    () =>
      text(first.doc).toString() === text(writer).toString() &&
      text(other.doc).toString() === text(writer).toString(),
  );
  expect(
    (await f.db`SELECT last_sequence FROM crdt_project WHERE id = ${id}`)[0]
      .last_sequence,
  ).toBe(3n);
  expect(materializeProject(other.doc)).toEqual(materializeProject(writer));
  writer.destroy();
  first.doc.destroy();
  other.doc.destroy();
});

test("sockets preserve causal gaps and close before sending after session revocation", async () => {
  const writer = base();
  await f.backend.services.storage.ingest(
    user,
    id,
    crypto.randomUUID(),
    Y.encodeStateAsUpdate(writer),
  );
  const predecessor = capture(writer, () => text(writer).insert(0, "A"))[0];
  const successor = capture(writer, () => text(writer).insert(1, "B"))[0];
  await f.backend.services.storage.ingest(
    user,
    id,
    crypto.randomUUID(),
    successor,
  );
  const remote = await client();
  expect(remote.doc.store.pendingStructs).not.toBeNull();
  expect((await f.submit(credential, id, predecessor)).status).toBe(201);
  await eventually(() => remote.doc.store.pendingStructs === null);
  expect(materializeProject(remote.doc)).toEqual(materializeProject(writer));
  await f.db`DELETE FROM auth_sessions WHERE user_id = ${user}`;
  const closed = new Promise<CloseEvent>((resolve) =>
    remote.socket.addEventListener("close", resolve, { once: true }),
  );
  await f.backend.services.storage.ingest(
    user,
    id,
    crypto.randomUUID(),
    capture(writer, () => text(writer).insert(0, "revoked"))[0],
  );
  expect((await closed).code).toBe(1008);
  expect(text(remote.doc).toString()).not.toContain("revoked");
  writer.destroy();
  remote.doc.destroy();
});

test("malformed frames and text messages close without producing receipts", async () => {
  for (const frame of ["text", new Uint8Array([0, 2, 255])]) {
    const remote = await client();
    const closed = new Promise<CloseEvent>((resolve) =>
      remote.socket.addEventListener("close", resolve, { once: true }),
    );
    remote.socket.send(frame);
    expect((await closed).code).toBe(1008);
    remote.doc.destroy();
  }
  expect(
    (
      await f.db`SELECT COUNT(*) AS count FROM crdt_receipt WHERE project_id = ${id}`
    )[0].count,
  ).toBe(0n);
});

test("upgrade rejects foreign origins, stale account fences and another owner's project", async () => {
  const foreign = await f.request(
    `/sync/v1/${id}`,
    { headers: { Origin: "https://foreign.example" } },
    credential,
  );
  expect(foreign.status).toBe(403);
  expect(
    (await f.request(`/sync/v1/${id}?ownerId=999999`, {}, credential)).status,
  ).toBe(409);
  expect(
    (await f.request(`/sync/v1/${id}`, {}, await f.sessionFor("other"))).status,
  ).toBe(404);
});
