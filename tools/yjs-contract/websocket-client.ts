// Invoked by Rust's SQLx suite against real Axum sockets. Disable BroadcastChannel
// so these independent provider instances can only converge through the server.
import { WebsocketProvider } from "../../webapp/tests/interop-dependencies";
import { Y } from "./fixtures";
import { addNode, materialize, placeNode } from "./fixtures";
import { base, ID, node, text } from "./scenarios";

const input: { serverUrl: string; projectId: string; cookie: string } =
  await Bun.stdin.json();
// Bun supports handshake headers; DOM's constructor type omits this overload.
const BunSocket = WebSocket as typeof WebSocket & {
  new (url: string | URL, options: Bun.WebSocketOptions): WebSocket;
};
class AuthenticatedSocket extends BunSocket {
  constructor(url: string | URL) {
    super(url, {
      headers: { Cookie: input.cookie, Origin: "http://localhost:5173" },
    });
  }
}
const a = base();
const b = new Y.Doc();
const c = new Y.Doc();
const provider = (doc: Y.Doc) =>
  new WebsocketProvider(input.serverUrl, input.projectId, doc, {
    WebSocketPolyfill: AuthenticatedSocket,
    disableBc: true,
  });
const pa = provider(a);
const pb = provider(b);
let pc: WebsocketProvider | undefined;
async function until(predicate: () => boolean, phase: string) {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw Error(
        `Yjs provider convergence timed out: ${phase}, connected=${pa.wsconnected}/${pb.wsconnected}, synced=${pa.synced}/${pb.synced}, sizes=${a.getMap("project").size}/${b.getMap("project").size}`,
      );
    await Bun.sleep(20);
  }
}
function equal(a: Y.Doc, b: Y.Doc) {
  return Bun.deepEquals(materialize(a), materialize(b));
}
try {
  await until(
    () => pa.synced && pb.synced && b.getMap("project").size > 0,
    "bootstrap",
  );
  // Offline concurrent text and structural edits are caught up on reconnect.
  pa.disconnect();
  pb.disconnect();
  text(a).insert(0, "Left😀");
  addNode(a, ID(4), node("New child", ID(1)));
  text(b).insert(0, "Right✨");
  placeNode(b, ID(3), ID(1), 0);
  pa.connect();
  pb.connect();
  await until(() => pa.synced && pb.synced && equal(a, b), "reconnect");
  const beforeDelete = Y.encodeStateVector(a);
  text(a).delete(0, 1);
  await until(() => equal(a, b), "delete");
  if (String(beforeDelete) !== String(Y.encodeStateVector(a)))
    throw Error("Expected a delete-only edit");
  pc = provider(c);
  await until(
    () => pc?.synced === true && c.getMap("project").size > 0,
    "third bootstrap",
  );
  await until(() => equal(a, c), "third convergence");
  const content = materialize(c);
  if (!content.nodes[ID(4)] || content.nodes[ID(3)].placement.parent !== ID(1))
    throw Error("Structural changes lost");
  console.log(JSON.stringify({ content, converged: true }));
} finally {
  pa.destroy();
  pb.destroy();
  pc?.destroy();
  a.destroy();
  b.destroy();
  c.destroy();
}
