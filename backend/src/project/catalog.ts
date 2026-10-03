import type { SQL } from "bun";
import { one, query } from "../db";
import { ApiError } from "../errors";

const COLUMNS = `id, protocol_version, schema_version,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  COALESCE(name_utf8, convert_to(name, 'UTF8')) AS name, node_count, projection_sequence,
  projection_version, projection_status, last_sequence,
  to_char(content_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS content_updated_at,
  (EXTRACT(EPOCH FROM created_at) * 1000000)::BIGINT AS created_at_micros`;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const decodeText = (value: Uint8Array | null) =>
  value === null ? null : utf8.decode(value);

interface CatalogRow {
  id: string;
  protocol_version: number;
  schema_version: number;
  created_at: string;
  name: Uint8Array | null;
  node_count: number | null;
  projection_sequence: bigint | null;
  projection_version: number | null;
  projection_status: string;
  last_sequence: bigint;
  content_updated_at: string | null;
  created_at_micros: bigint;
}

function project(row: CatalogRow) {
  return {
    projectId: row.id,
    protocolVersion: row.protocol_version,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    name: decodeText(row.name),
    nodeCount: row.node_count,
    projectionSequence: row.projection_sequence?.toString() ?? null,
    projectionVersion: row.projection_version,
    projectionStatus: row.projection_status,
    lastSequence: row.last_sequence.toString(),
    contentUpdatedAt: row.content_updated_at,
  };
}

function encodeCursor(row: CatalogRow) {
  const bytes = Buffer.alloc(24);
  bytes.writeBigInt64BE(row.created_at_micros);
  Buffer.from(row.id.replaceAll("-", ""), "hex").copy(bytes, 8);
  return bytes.toString("base64url");
}

function decodeCursor(value: string) {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 24 || bytes.toString("base64url") !== value)
    throw new ApiError("invalid_cursor");
  const hex = bytes.subarray(8).toString("hex");
  return {
    micros: bytes.readBigInt64BE(),
    id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  };
}

export class Catalog {
  constructor(readonly db: SQL) {}

  async create(owner: bigint, id: string) {
    const created = await one<CatalogRow>(
      this.db,
      `INSERT INTO crdt_project (id, owner_id, protocol_version, schema_version) VALUES ($1, $2, 1, 1) ON CONFLICT (id) DO NOTHING RETURNING ${COLUMNS}`,
      [id, owner],
    );
    if (created) return { created: true, project: project(created) };
    const previous = await one<CatalogRow>(
      this.db,
      `SELECT ${COLUMNS} FROM crdt_project WHERE id = $1 AND owner_id = $2`,
      [id, owner],
    );
    if (
      !previous ||
      previous.protocol_version !== 1 ||
      previous.schema_version !== 1
    )
      throw new ApiError("project_id_conflict");
    return { created: false, project: project(previous) };
  }

  async get(owner: bigint, id: string) {
    const row = await one<CatalogRow>(
      this.db,
      `SELECT ${COLUMNS} FROM crdt_project WHERE id = $1 AND owner_id = $2`,
      [id, owner],
    );
    if (!row) throw new ApiError("project_not_found");
    return project(row);
  }

  async list(owner: bigint, limit: number, cursor?: string | null) {
    const after = cursor ? decodeCursor(cursor) : null;
    if (cursor === "") throw new ApiError("invalid_cursor");
    const rows = await query<CatalogRow>(
      this.db,
      `SELECT ${COLUMNS} FROM crdt_project WHERE owner_id = $1 AND ($2::BIGINT IS NULL OR (created_at, id) < (TIMESTAMPTZ 'epoch' + $2::BIGINT * INTERVAL '1 microsecond', $3::UUID)) ORDER BY created_at DESC, id DESC LIMIT $4`,
      [owner, after?.micros ?? null, after?.id ?? null, limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      projects: page.map(project),
      nextCursor:
        hasMore && page.length ? encodeCursor(page[page.length - 1]) : null,
    };
  }
}
