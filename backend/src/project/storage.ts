import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { type Database, one, query } from "../db";
import { ApiError } from "../errors";
import {
  MAX_DOCUMENT_BYTES,
  MAX_PAGE_BYTES,
  MAX_TAIL_ROWS,
  MAX_UPDATE_BYTES,
  type Validation,
} from "./document";
import { DocumentPool } from "./document-pool";
import { preflight } from "./wire";

export const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export const bytes = (value: Uint8Array) => new Uint8Array(value);
export const parseProjectId = (id: string) => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      id,
    ) ||
    id === "00000000-0000-0000-0000-000000000000"
  )
    throw new ApiError("invalid_project_id");
  return id;
};
export function parseNewProjectId(id: string) {
  parseProjectId(id);
  if (id[14] !== "4" || !/[89ab]/.test(id[19]))
    throw new ApiError("invalid_project_id");
  return id;
}
export function sequence(value: string) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new ApiError("invalid_cursor");
  const result = BigInt(value);
  if (result > 9223372036854775807n) throw new ApiError("invalid_cursor");
  return result;
}

export interface Project {
  schema_version: number;
  protocol_version: number;
  last_sequence: bigint;
  validation: Validation;
}
export interface Receipt {
  protocolVersion: 1;
  projectId: string;
  updateId: string;
  sequence: string;
  sha256: string;
  durable: true;
  validation: Validation;
}
export interface Baseline {
  sequence: bigint;
  bytes: Uint8Array;
  stateVector: Uint8Array;
  validation: Validation;
}

export async function lockProject(tx: Database, id: string, owner: bigint) {
  const project = await one<Project>(
    tx,
    "SELECT schema_version, protocol_version, last_sequence, validation FROM crdt_project WHERE id = $1 AND owner_id = $2 FOR UPDATE",
    [id, owner],
  );
  if (!project) throw new ApiError("project_not_found");
  return project;
}
export function supported(project: Project) {
  if (project.schema_version !== 1 || project.protocol_version !== 1)
    throw new ApiError("unsupported_schema");
}

// Read checkpoint and a contiguous, checksummed tail under the writer's row
// lock. Original bytes are canonical; read models are never replay input.
export async function load(tx: Database, id: string, last: bigint) {
  const checkpoint = await one<{
    covered_sequence: bigint;
    data: Uint8Array;
    sha256: string;
    checkpoint_version: number;
    encoding: string;
  }>(
    tx,
    "SELECT covered_sequence, data, sha256, checkpoint_version, encoding FROM crdt_checkpoint WHERE project_id = $1",
    [id],
  );
  const updates: Uint8Array[] = [];
  let covered = 0n;
  if (checkpoint) {
    if (
      checkpoint.covered_sequence > last ||
      checkpoint.checkpoint_version !== 1 ||
      checkpoint.encoding !== "yjs-v1" ||
      digest(checkpoint.data) !== checkpoint.sha256
    )
      throw new ApiError("unavailable");
    updates.push(bytes(checkpoint.data));
    covered = checkpoint.covered_sequence;
  }
  const totals = await one<{ count: bigint; size: bigint }>(
    tx,
    "SELECT COUNT(*) AS count, COALESCE(SUM(octet_length(data)), 0)::BIGINT AS size FROM crdt_update WHERE project_id = $1 AND sequence > $2 AND sequence <= $3",
    [id, covered, last],
  );
  if (
    !totals ||
    totals.count > BigInt(MAX_TAIL_ROWS) ||
    totals.size + BigInt(updates[0]?.length ?? 0) > BigInt(MAX_DOCUMENT_BYTES)
  )
    throw new ApiError("resource_limit");
  if (totals.count !== last - covered) throw new ApiError("unavailable");
  const rows = await query<{ data: Uint8Array; sha256: string }>(
    tx,
    "SELECT data, sha256 FROM crdt_update WHERE project_id = $1 AND sequence > $2 AND sequence <= $3 ORDER BY sequence",
    [id, covered, last],
  );
  for (const row of rows) {
    if (digest(row.data) !== row.sha256) throw new ApiError("unavailable");
    updates.push(bytes(row.data));
  }
  return updates;
}

export class Storage {
  constructor(
    readonly db: SQL,
    readonly documents = new DocumentPool(),
  ) {}

  // The same row lock as ingestion serializes deletion with accepted writes.
  // Foreign-key cascades remove updates, receipts, checkpoints and read models.
  async remove(owner: bigint, id: string) {
    await this.db.begin(async (tx) => {
      await tx`SET LOCAL synchronous_commit = on`;
      await tx`DELETE FROM crdt_project WHERE id = ${id} AND owner_id = ${owner}`;
    });
  }

  async ingest(
    owner: bigint,
    id: string,
    updateId: string,
    update: Uint8Array,
  ): Promise<{ created: boolean; receipt: Receipt }> {
    if (update.length > MAX_UPDATE_BYTES) throw new ApiError("resource_limit");
    return this.db.begin(async (tx) => {
      await tx`SET LOCAL synchronous_commit = on`;
      const project = await lockProject(tx, id, owner);
      supported(project);
      const previous = await one<{
        byte_length: number;
        sequence: bigint;
        sha256: string;
        validation: Validation;
      }>(
        tx,
        "SELECT byte_length, sequence, sha256, validation FROM crdt_receipt WHERE project_id = $1 AND update_id = $2",
        [id, updateId],
      );
      const sha256 = digest(update);
      const receipt = (seq: bigint, validation: Validation): Receipt => ({
        protocolVersion: 1,
        projectId: id,
        updateId,
        sequence: seq.toString(),
        sha256,
        durable: true,
        validation,
      });
      if (previous) {
        if (
          previous.byte_length !== update.length ||
          previous.sha256 !== sha256
        )
          throw new ApiError("update_id_conflict");
        return {
          created: false,
          receipt: receipt(previous.sequence, previous.validation),
        };
      }
      if (project.validation === "quarantined")
        throw new ApiError("project_quarantined");
      preflight(update);
      const updates = await load(tx, id, project.last_sequence);
      if (
        updates.length >= MAX_TAIL_ROWS ||
        updates.reduce((sum, item) => sum + item.length, update.length) >
          MAX_DOCUMENT_BYTES
      )
        throw new ApiError("resource_limit");
      updates.push(update);
      let validation: Validation;
      try {
        const candidate = await this.documents.run(updates);
        if (candidate.content?.metadata.saving?.cloud === false)
          throw new ApiError("cloud_saving_disabled");
        validation = candidate.validation;
      } catch (error) {
        if (
          project.last_sequence > 0n &&
          project.validation === "pending_dependencies" &&
          error instanceof ApiError &&
          ["invalid_schema", "unsupported_schema", "resource_limit"].includes(
            error.code,
          )
        )
          validation = "quarantined";
        else throw error;
      }
      const next = project.last_sequence + 1n;
      if (next > 9223372036854775807n) throw new ApiError("resource_limit");
      await tx`INSERT INTO crdt_update (project_id, sequence, update_id, data, sha256, validation) VALUES (${id}, ${next}, ${updateId}, ${Buffer.from(update)}, ${sha256}, ${validation})`;
      await tx`UPDATE crdt_project SET last_sequence = ${next}, validation = ${validation}, content_updated_at = NOW() WHERE id = ${id}`;
      return { created: true, receipt: receipt(next, validation) };
    });
  }

  async baseline(owner: bigint, id: string): Promise<Baseline> {
    return this.db.begin(async (tx) => {
      const project = await lockProject(tx, id, owner);
      supported(project);
      if (project.validation === "quarantined")
        throw new ApiError("project_quarantined");
      if (project.last_sequence === 0n)
        return {
          sequence: 0n,
          bytes: new Uint8Array([0, 0]),
          stateVector: new Uint8Array([0]),
          validation: "pending_dependencies",
        };
      const candidate = await this.documents.run(
        await load(tx, id, project.last_sequence),
      );
      return {
        sequence: project.last_sequence,
        bytes: candidate.bytes,
        stateVector: candidate.stateVector,
        validation: candidate.validation,
      };
    });
  }

  async updates(owner: bigint, id: string, after: bigint, limit: number) {
    return this.db.begin(async (tx) => {
      await lockProject(tx, id, owner);
      const checkpoint = await one<{ covered: bigint }>(
        tx,
        "SELECT COALESCE((SELECT covered_sequence FROM crdt_checkpoint WHERE project_id = $1), 0) AS covered",
        [id],
      );
      if (checkpoint && after < checkpoint.covered)
        throw new ApiError("baseline_required");
      const rows = await query<{
        sequence: bigint;
        update_id: string;
        sha256: string;
        data: Uint8Array;
      }>(
        tx,
        "WITH page AS (SELECT sequence, update_id, sha256, octet_length(data) AS size FROM crdt_update WHERE project_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3), sized AS (SELECT *, SUM(size) OVER (ORDER BY sequence) AS total FROM page) SELECT u.sequence, u.update_id, u.sha256, u.data FROM sized p JOIN crdt_update u ON u.project_id = $1 AND u.sequence = p.sequence WHERE p.total <= $4 ORDER BY u.sequence",
        [id, after, limit, MAX_PAGE_BYTES],
      );
      const next = rows.at(-1)?.sequence ?? after;
      const hasMore = await one<{ more: boolean }>(
        tx,
        "SELECT EXISTS(SELECT 1 FROM crdt_update WHERE project_id = $1 AND sequence > $2) AS more",
        [id, next],
      );
      return {
        updates: rows.map((row) => ({
          sequence: row.sequence.toString(),
          updateId: row.update_id,
          sha256: row.sha256,
          encoding: "yjs-v1",
          data: Buffer.from(row.data).toString("base64"),
        })),
        nextAfter: next.toString(),
        hasMore: hasMore?.more ?? false,
      };
    });
  }
}
