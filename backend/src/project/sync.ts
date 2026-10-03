import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { accountFence, type Services } from "../api";
import type { User } from "../auth";
import { one } from "../db";
import { ApiError, projectError } from "../errors";
import { parameters, sameOrigin } from "../http";
import { MAX_UPDATE_BYTES } from "./document";
import {
  bytes,
  digest,
  type Project,
  parseProjectId,
  supported,
} from "./storage";
import { decodeFrame } from "./wire";

export interface SocketData {
  user: User;
  id: string;
  sequence: bigint;
  closed: boolean;
  chain: Promise<void>;
  pendingBytes: number;
  polling: boolean;
  authorizedAt: number;
  lastActivity: number;
  lastPing: number;
  timer?: ReturnType<typeof setInterval>;
  drain?: () => void;
}
type Socket = ServerWebSocket<SocketData>;

export function syncFrame(kind: 0 | 1 | 2, bytes: Uint8Array) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint(encoder, kind);
  encoding.writeVarUint8Array(encoder, bytes);
  return encoding.toUint8Array(encoder);
}

export class Synchronization {
  private connections = 0;
  constructor(readonly services: Services) {}

  async upgrade(
    request: Request,
    server: Server<SocketData>,
    peerIp?: string,
  ): Promise<Response | undefined> {
    sameOrigin(request, this.services.config);
    this.services.limits.take("upgradePeers", peerIp);
    const user = await this.services.auth.identify(request);
    accountFence(user, request.headers.get("X-Mindgrab-Account"));
    const url = new URL(request.url);
    const scope = parameters(url);
    accountFence(user, scope.ownerId ?? null);
    this.services.limits.take("upgrades", user.id.toString());
    const id = parseProjectId(
      decodeURIComponent(url.pathname.slice("/sync/v1/".length)),
    );
    if (this.connections >= 64) throw new ApiError("unavailable");
    this.connections++;
    let upgraded = false;
    try {
      await this.services.storage.baseline(user.id, id);
      const now = performance.now();
      upgraded = server.upgrade(request, {
        data: {
          user,
          id,
          sequence: 0n,
          closed: false,
          chain: Promise.resolve(),
          pendingBytes: 0,
          polling: false,
          authorizedAt: now,
          lastActivity: now,
          lastPing: now,
        },
      });
      return upgraded ? undefined : new ApiError("invalid_request").response();
    } finally {
      if (!upgraded) this.connections--;
    }
  }

  private async authorize(data: SocketData) {
    const user = await this.services.auth.validate(data.user.session);
    if (user.id !== data.user.id) throw new ApiError("unauthenticated");
    data.authorizedAt = performance.now();
  }

  private async send(socket: Socket, kind: 0 | 1 | 2, bytes: Uint8Array) {
    if (socket.data.closed) throw new ApiError("unavailable");
    const sent = socket.send(syncFrame(kind, bytes), true);
    if (sent === 0) throw new ApiError("unavailable");
    if (sent !== -1) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        socket.data.drain = resolve;
        timer = setTimeout(() => reject(new ApiError("unavailable")), 10000);
        if (socket.getBufferedAmount() === 0) resolve();
      });
      if (socket.data.closed) throw new ApiError("unavailable");
    } finally {
      clearTimeout(timer);
      socket.data.drain = undefined;
    }
  }

  private fail(socket: Socket, error: unknown) {
    if (socket.data.closed) return;
    const failure = projectError(error);
    const [code, reason] =
      failure.code === "unavailable"
        ? [1013, "Sync temporarily unavailable; retry"]
        : failure.code === "resource_limit"
          ? [1009, "Sync resource limit"]
          : failure.code === "unauthenticated"
            ? [1008, "Sign in again"]
            : [1008, "Invalid or unsupported sync content"];
    socket.close(code, reason);
    const terminate = setTimeout(() => {
      if (!socket.data.closed) socket.terminate();
    }, 500);
    terminate.unref();
  }

  private enqueue(socket: Socket, task: () => Promise<void>) {
    socket.data.chain = socket.data.chain
      .then(async () => {
        if (!socket.data.closed) await task();
      })
      .catch((error) => this.fail(socket, error));
  }

  private async tail(socket: Socket) {
    const data = socket.data;
    const row = await one<
      Project & {
        sequence: bigint | null;
        data: Uint8Array | null;
        sha256: string | null;
      }
    >(
      this.services.storage.db,
      "SELECT p.last_sequence, p.validation, p.schema_version, p.protocol_version, u.sequence, u.data, u.sha256 FROM crdt_project p LEFT JOIN LATERAL (SELECT sequence, data, sha256 FROM crdt_update WHERE project_id = p.id AND sequence > $3 ORDER BY sequence LIMIT 1) u ON TRUE WHERE p.id = $1 AND p.owner_id = $2",
      [data.id, data.user.id, data.sequence],
    );
    if (!row) throw new ApiError("project_not_found");
    supported(row);
    if (row.validation === "quarantined")
      throw new ApiError("project_quarantined");
    if (row.last_sequence <= data.sequence) return;
    await this.authorize(data);
    if (row.sequence === data.sequence + 1n && row.data) {
      if (digest(row.data) !== row.sha256) throw new ApiError("unavailable");
      await this.send(socket, 2, bytes(row.data));
      data.sequence++;
    } else {
      const baseline = await this.services.storage.baseline(
        data.user.id,
        data.id,
      );
      await this.send(socket, 2, baseline.bytes);
      data.sequence = baseline.sequence;
    }
    if (data.sequence < row.last_sequence)
      setImmediate(() => {
        if (!data.closed) this.enqueue(socket, () => this.tail(socket));
      });
  }

  handlers(): WebSocketHandler<SocketData> {
    return {
      maxPayloadLength: MAX_UPDATE_BYTES + 16,
      backpressureLimit: 11 * 1048576,
      closeOnBackpressureLimit: true,
      idleTimeout: 60,
      sendPings: false,
      open: (socket) => {
        this.enqueue(socket, async () => {
          await this.authorize(socket.data);
          const baseline = await this.services.storage.baseline(
            socket.data.user.id,
            socket.data.id,
          );
          socket.data.sequence = baseline.sequence;
          if (baseline.sequence > 0n)
            await this.send(socket, 2, baseline.bytes);
          await this.send(socket, 0, baseline.stateVector);
        });
        socket.data.timer = setInterval(() => {
          const data = socket.data;
          if (data.polling || data.closed) return;
          data.polling = true;
          this.enqueue(socket, async () => {
            try {
              const now = performance.now();
              if (now - data.lastActivity >= 60000)
                throw new ApiError("unavailable");
              if (now - data.authorizedAt >= 5000) await this.authorize(data);
              await this.tail(socket);
              if (now - data.lastPing >= 20000) {
                socket.ping();
                data.lastPing = now;
              }
            } finally {
              data.polling = false;
            }
          });
        }, 250);
        socket.data.timer.unref();
      },
      message: (socket, message) => {
        const data = socket.data;
        data.lastActivity = performance.now();
        if (typeof message === "string") {
          this.fail(socket, new ApiError("invalid_request"));
          return;
        }
        if (data.pendingBytes + message.length > 2 * MAX_UPDATE_BYTES + 32) {
          this.fail(socket, new ApiError("resource_limit"));
          return;
        }
        const update = new Uint8Array(message);
        data.pendingBytes += update.length;
        this.enqueue(socket, async () => {
          try {
            const frame = decodeFrame(update);
            await this.authorize(data);
            if (frame.kind === "step1") {
              const baseline = await this.services.storage.baseline(
                data.user.id,
                data.id,
              );
              await this.send(
                socket,
                1,
                baseline.validation === "valid"
                  ? Y.diffUpdate(baseline.bytes, frame.bytes)
                  : baseline.bytes,
              );
            } else if (
              frame.kind === "update" &&
              !Buffer.from(frame.bytes).equals(Buffer.from([0, 0]))
            ) {
              await this.services.storage.ingest(
                data.user.id,
                data.id,
                crypto.randomUUID(),
                frame.bytes,
              );
            }
          } finally {
            data.pendingBytes -= update.length;
          }
        });
      },
      drain: (socket) => socket.data.drain?.(),
      pong: (socket) => {
        socket.data.lastActivity = performance.now();
      },
      close: (socket) => {
        if (socket.data.closed) return;
        socket.data.closed = true;
        clearInterval(socket.data.timer);
        socket.data.drain?.();
        this.connections--;
      },
    };
  }
}
