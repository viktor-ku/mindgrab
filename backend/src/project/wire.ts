import { ApiError, type ErrorCode } from "../errors";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const MAX_UINT = 0xffffffff;

class Reader {
  offset = 0;
  constructor(
    readonly bytes: Uint8Array,
    readonly error: ErrorCode = "invalid_update",
  ) {}
  take(length: number) {
    const end = this.offset + length;
    if (!Number.isSafeInteger(end) || end > this.bytes.length)
      throw new ApiError(this.error);
    const result = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return result;
  }
  byte() {
    return this.take(1)[0];
  }
  uint() {
    let result = 0;
    for (let index = 0; index < 5; index++) {
      const byte = this.byte();
      result += (byte & 127) * 2 ** (index * 7);
      if (result > MAX_UINT) throw new ApiError(this.error);
      if (byte < 128) return result;
    }
    throw new ApiError(this.error);
  }
  count() {
    const count = this.uint();
    if (count > this.bytes.length - this.offset || count > 200000)
      throw new ApiError("resource_limit");
    return count;
  }
  buffer() {
    return this.take(this.uint());
  }
  string() {
    try {
      return decoder.decode(this.buffer());
    } catch (error) {
      throw error instanceof ApiError ? error : new ApiError(this.error);
    }
  }
  id() {
    this.uint();
    this.uint();
  }
  end() {
    if (this.offset !== this.bytes.length) throw new ApiError(this.error);
  }
  any(depth: number) {
    if (depth > 16) throw new ApiError("resource_limit");
    const kind = this.byte();
    switch (kind) {
      case 120:
      case 121:
      case 126:
      case 127:
        return;
      case 125:
        for (let index = 0; index < 8; index++) if (this.byte() < 128) return;
        throw new ApiError(this.error);
      case 124:
        this.take(4);
        return;
      case 122:
      case 123:
        this.take(8);
        return;
      case 119:
        this.string();
        return;
      case 117:
      case 118: {
        const count = this.count();
        for (let i = 0; i < count; i++) {
          if (kind === 118) this.string();
          this.any(depth + 1);
        }
        return;
      }
      case 116:
        this.buffer();
        return;
      default:
        throw new ApiError(this.error);
    }
  }
}

// Bound amplification, nested values, clocks, and unsupported shared types
// before the Yjs decoder allocates objects from caller-declared counts.
export function preflight(bytes: Uint8Array) {
  const reader = new Reader(bytes);
  const clients = new Set<number>();
  const count = reader.count();
  for (let i = 0; i < count; i++) {
    const structures = reader.count();
    const client = reader.uint();
    if (clients.has(client)) throw new ApiError("invalid_update");
    clients.add(client);
    let clock = reader.uint();
    for (let j = 0; j < structures; j++) {
      const info = reader.byte();
      let length: number;
      if (info === 0 || info === 10) length = reader.uint();
      else {
        if (info & 128) reader.id();
        if (info & 64) reader.id();
        if (!(info & 192)) {
          const parent = reader.uint();
          if (parent === 1) reader.string();
          else if (parent === 0) reader.id();
          else throw new ApiError("invalid_update");
          if (info & 32) reader.string();
        }
        switch (info & 15) {
          case 1:
            length = reader.uint();
            break;
          case 4:
            length = reader.string().length;
            break;
          case 7:
            if (![1, 2].includes(reader.byte()))
              throw new ApiError("invalid_schema");
            length = 1;
            break;
          case 8:
            length = reader.count();
            for (let k = 0; k < length; k++) reader.any(0);
            break;
          default:
            throw new ApiError("invalid_schema");
        }
      }
      if (!length || clock + length > MAX_UINT)
        throw new ApiError("invalid_update");
      clock += length;
    }
  }
  clients.clear();
  const deleteClients = reader.count();
  for (let i = 0; i < deleteClients; i++) {
    const client = reader.uint();
    if (clients.has(client)) throw new ApiError("invalid_update");
    clients.add(client);
    const count = reader.count();
    for (let j = 0; j < count; j++) {
      const clock = reader.uint();
      if (clock + reader.uint() > MAX_UINT)
        throw new ApiError("invalid_update");
    }
  }
  reader.end();
}

export type Frame =
  | { kind: "step1" | "update"; bytes: Uint8Array }
  | { kind: "awareness" };
export function decodeFrame(bytes: Uint8Array): Frame {
  const reader = new Reader(bytes, "invalid_request");
  let frame: Frame;
  switch (reader.uint()) {
    case 0: {
      const kind = reader.uint();
      const payload = reader.buffer();
      if (kind === 0) {
        const vector = new Reader(payload, "invalid_request");
        const count = vector.uint();
        if (count > 10000) throw new ApiError("resource_limit");
        for (let i = 0; i < count; i++) {
          vector.uint();
          vector.uint();
        }
        vector.end();
        frame = { kind: "step1", bytes: payload };
      } else if (kind === 1 || kind === 2)
        frame = { kind: "update", bytes: payload };
      else throw new ApiError("invalid_request");
      break;
    }
    case 1:
      reader.buffer();
      frame = { kind: "awareness" };
      break;
    case 3:
      frame = { kind: "awareness" };
      break;
    default:
      throw new ApiError("invalid_request");
  }
  reader.end();
  return frame;
}
