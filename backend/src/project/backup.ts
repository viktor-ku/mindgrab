import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { one, query } from "../db";
import { ApiError } from "../errors";
import {
  MAX_DOCUMENT_BYTES,
  MAX_TAIL_ROWS,
  MAX_UPDATE_BYTES,
} from "./document";
import {
  digest,
  load,
  lockProject,
  parseNewProjectId,
  type Storage,
  sequence,
  supported,
} from "./storage";
import { preflight } from "./wire";

const MAGIC = Buffer.from("MGBK0001");
const MAX_ARCHIVE = 256 * 1024 * 1024;
const MAX_RECEIPTS = 1000000;
const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const validation = z.enum(["valid", "pending_dependencies", "quarantined"]);
const timestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)));
const receiptSchema = z.strictObject({
  sequence: decimal,
  updateId: z.string().uuid(),
  sha256: hash,
  byteLength: z.number().int().min(2).max(MAX_UPDATE_BYTES),
  validation,
  committedAt: timestamp,
});
const manifestSchema = z.strictObject({
  formatVersion: z.number().int(),
  schemaVersion: z.number().int(),
  protocolVersion: z.number().int(),
  checkpointVersion: z.number().int(),
  encoding: z.string(),
  projectId: z.string().uuid(),
  sourceOwnerExternalId: z.string(),
  createdAt: timestamp,
  contentUpdatedAt: timestamp.nullable(),
  coveredSequence: decimal,
  lastSequence: decimal,
  validation,
  checkpointLength: z.number().int().min(2).max(MAX_DOCUMENT_BYTES),
  checkpointSha256: hash,
  payloadSha256: hash,
  receipts: z.array(receiptSchema).max(MAX_RECEIPTS),
  tail: z
    .array(
      z.strictObject({
        sequence: decimal,
        byteLength: z.number().int().min(2).max(MAX_UPDATE_BYTES),
        sha256: hash,
      }),
    )
    .max(MAX_TAIL_ROWS),
});
export type Manifest = z.infer<typeof manifestSchema>;

export class Archive {
  constructor(
    readonly manifest: Manifest,
    readonly payload: Uint8Array,
  ) {}

  async write(path: string) {
    const manifest = Buffer.from(JSON.stringify(this.manifest));
    if (manifest.length + this.payload.length + 44 > MAX_ARCHIVE)
      throw new ApiError("resource_limit");
    const header = Buffer.alloc(44);
    MAGIC.copy(header);
    header.writeUInt32LE(manifest.length, 8);
    createHash("sha256").update(manifest).digest().copy(header, 12);
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(Buffer.concat([header, manifest, this.payload]));
      await file.sync();
    } finally {
      await file.close();
    }
    const parent = await open(dirname(path), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }

  static async read(path: string) {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of createReadStream(path, { end: MAX_ARCHIVE })) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_ARCHIVE) throw new ApiError("resource_limit");
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length < 44 || !bytes.subarray(0, 8).equals(MAGIC))
      throw new ApiError("invalid_request");
    const manifestLength = bytes.readUInt32LE(8);
    if (manifestLength > bytes.length - 44)
      throw new ApiError("invalid_request");
    const manifest = bytes.subarray(44, 44 + manifestLength);
    if (
      !createHash("sha256")
        .update(manifest)
        .digest()
        .equals(bytes.subarray(12, 44))
    )
      throw new ApiError("invalid_request");
    try {
      return new Archive(
        manifestSchema.parse(JSON.parse(manifest.toString("utf8"))),
        bytes.subarray(44 + manifestLength),
      );
    } catch {
      throw new ApiError("invalid_request");
    }
  }

  async validate(storage: Storage, id: string, sourceOwner: string) {
    const result = manifestSchema.safeParse(this.manifest);
    if (!result.success) throw new ApiError("invalid_request");
    const m = result.data;
    if (m.projectId !== id || m.sourceOwnerExternalId !== sourceOwner)
      throw new ApiError("project_id_conflict");
    if (
      m.formatVersion !== 1 ||
      m.schemaVersion !== 1 ||
      m.protocolVersion !== 1 ||
      m.checkpointVersion !== 1 ||
      m.encoding !== "yjs-v1"
    )
      throw new ApiError("unsupported_schema");
    parseNewProjectId(id);
    const covered = sequence(m.coveredSequence);
    const last = sequence(m.lastSequence);
    if (
      covered > last ||
      BigInt(m.receipts.length) !== last ||
      BigInt(m.tail.length) !== last - covered ||
      digest(this.payload) !== m.payloadSha256
    )
      throw new ApiError("invalid_request");
    const ids = new Set<string>();
    for (const [index, receipt] of m.receipts.entries()) {
      if (
        sequence(receipt.sequence) !== BigInt(index + 1) ||
        ids.has(receipt.updateId)
      )
        throw new ApiError("invalid_request");
      parseNewProjectId(receipt.updateId);
      ids.add(receipt.updateId);
    }
    if (m.checkpointLength > this.payload.length)
      throw new ApiError("invalid_request");
    const checkpoint = this.payload.subarray(0, m.checkpointLength);
    if (
      digest(checkpoint) !== m.checkpointSha256 ||
      (covered === 0n && !Buffer.from(checkpoint).equals(Buffer.from([0, 0])))
    )
      throw new ApiError("invalid_request");
    const inputs = [checkpoint];
    let offset = m.checkpointLength;
    for (const [index, tail] of m.tail.entries()) {
      const seq = covered + BigInt(index) + 1n;
      const receipt = m.receipts[Number(seq) - 1];
      const end = offset + tail.byteLength;
      const bytes = this.payload.subarray(offset, end);
      if (
        end > this.payload.length ||
        sequence(tail.sequence) !== seq ||
        tail.byteLength !== receipt.byteLength ||
        tail.sha256 !== receipt.sha256 ||
        digest(bytes) !== tail.sha256
      )
        throw new ApiError("invalid_request");
      inputs.push(bytes);
      offset = end;
    }
    if (offset !== this.payload.length || offset > MAX_DOCUMENT_BYTES)
      throw new ApiError("resource_limit");
    if (
      covered > 0n &&
      !(await storage.documents.run([checkpoint], true)).checkpoint
    )
      throw new ApiError("invalid_update");
    for (const bytes of inputs) preflight(bytes);
    if (last > 0n) {
      try {
        const candidate = await storage.documents.run(inputs);
        if (candidate.validation !== m.validation)
          throw new ApiError("invalid_update");
      } catch (error) {
        if (
          !(
            m.validation === "quarantined" &&
            error instanceof ApiError &&
            ["invalid_schema", "unsupported_schema", "resource_limit"].includes(
              error.code,
            )
          )
        )
          throw error;
      }
    } else if (m.validation !== "pending_dependencies")
      throw new ApiError("invalid_request");
    return inputs;
  }
}

export class Backups {
  constructor(readonly storage: Storage) {}

  async owner(externalId: string) {
    const owner = await one<{ id: bigint }>(
      this.storage.db,
      "SELECT id FROM users WHERE external_id = $1",
      [externalId],
    );
    if (!owner) throw new ApiError("project_not_found");
    return owner.id;
  }

  async export(id: string, expectedOwner: string) {
    const owner = await this.owner(expectedOwner);
    const archive = await this.storage.db.begin(async (tx) => {
      const project = await lockProject(tx, id, owner);
      supported(project);
      const inputs = await load(tx, id, project.last_sequence);
      const candidate =
        project.last_sequence > 0n && project.validation !== "quarantined"
          ? await this.storage.documents.run(inputs, true)
          : undefined;
      let covered: bigint;
      let checkpoint: Uint8Array;
      if (candidate?.checkpoint) {
        covered = project.last_sequence;
        checkpoint = candidate.checkpoint;
      } else {
        const previous = await one<{
          covered_sequence: bigint;
          data: Uint8Array;
        }>(
          tx,
          "SELECT covered_sequence, data FROM crdt_checkpoint WHERE project_id = $1",
          [id],
        );
        covered = previous?.covered_sequence ?? 0n;
        checkpoint = previous?.data ?? new Uint8Array([0, 0]);
      }
      const times = await one<{
        created_at: string;
        content_updated_at: string | null;
      }>(
        tx,
        "SELECT created_at::TEXT, content_updated_at::TEXT FROM crdt_project WHERE id = $1",
        [id],
      );
      const count = await one<{ count: bigint }>(
        tx,
        "SELECT COUNT(*) AS count FROM crdt_receipt WHERE project_id = $1",
        [id],
      );
      if (
        !times ||
        count?.count !== project.last_sequence ||
        count.count > BigInt(MAX_RECEIPTS)
      )
        throw new ApiError("resource_limit");
      const receipts = await query<{
        sequence: bigint;
        update_id: string;
        sha256: string;
        byte_length: number;
        validation: Manifest["validation"];
        committed_at: string;
      }>(
        tx,
        "SELECT sequence, update_id, sha256, byte_length, validation, committed_at::TEXT FROM crdt_receipt WHERE project_id = $1 ORDER BY sequence",
        [id],
      );
      const rows = await query<{
        sequence: bigint;
        data: Uint8Array;
        sha256: string;
      }>(
        tx,
        "SELECT sequence, data, sha256 FROM crdt_update WHERE project_id = $1 AND sequence > $2 ORDER BY sequence",
        [id, covered],
      );
      const payload = Buffer.concat([
        checkpoint,
        ...rows.map((row) => row.data),
      ]);
      return new Archive(
        {
          formatVersion: 1,
          schemaVersion: 1,
          protocolVersion: 1,
          checkpointVersion: 1,
          encoding: "yjs-v1",
          projectId: id,
          sourceOwnerExternalId: expectedOwner,
          createdAt: times.created_at,
          contentUpdatedAt: times.content_updated_at,
          coveredSequence: covered.toString(),
          lastSequence: project.last_sequence.toString(),
          validation: project.validation,
          checkpointLength: checkpoint.length,
          checkpointSha256: digest(checkpoint),
          payloadSha256: digest(payload),
          receipts: receipts.map((row) => ({
            sequence: row.sequence.toString(),
            updateId: row.update_id,
            sha256: row.sha256,
            byteLength: row.byte_length,
            validation: row.validation,
            committedAt: row.committed_at,
          })),
          tail: rows.map((row) => ({
            sequence: row.sequence.toString(),
            byteLength: row.data.length,
            sha256: row.sha256,
          })),
        },
        payload,
      );
    });
    await archive.validate(this.storage, id, expectedOwner);
    return archive;
  }

  async restore(
    id: string,
    sourceOwner: string,
    destinationOwner: string,
    archive: Archive,
  ) {
    const inputs = await archive.validate(this.storage, id, sourceOwner);
    const owner = await this.owner(destinationOwner);
    const m = archive.manifest;
    const covered = sequence(m.coveredSequence);
    await this.storage.db.begin(async (tx) => {
      await tx`SET LOCAL synchronous_commit = on`;
      const inserted =
        await tx`INSERT INTO crdt_project (id, owner_id, schema_version, protocol_version, created_at, last_sequence, validation, content_updated_at)
        VALUES (${id}, ${owner}, 1, 1, ${m.createdAt}::TEXT::TIMESTAMPTZ, ${sequence(m.lastSequence)}, ${m.validation}, ${m.contentUpdatedAt}::TEXT::TIMESTAMPTZ) ON CONFLICT (id) DO NOTHING`;
      if (inserted.count !== 1) throw new ApiError("project_id_conflict");
      if (covered > 0n)
        await tx`INSERT INTO crdt_checkpoint (project_id, covered_sequence, data, sha256) VALUES (${id}, ${covered}, ${Buffer.from(inputs[0])}, ${m.checkpointSha256})`;
      for (const receipt of m.receipts) {
        const seq = sequence(receipt.sequence);
        if (seq <= covered)
          await tx`INSERT INTO crdt_receipt (project_id, sequence, update_id, sha256, byte_length, validation, committed_at) VALUES (${id}, ${seq}, ${receipt.updateId}, ${receipt.sha256}, ${receipt.byteLength}, ${receipt.validation}, ${receipt.committedAt}::TEXT::TIMESTAMPTZ)`;
        else
          await tx`INSERT INTO crdt_update (project_id, sequence, update_id, data, sha256, validation, committed_at) VALUES (${id}, ${seq}, ${receipt.updateId}, ${Buffer.from(inputs[Number(seq - covered)])}, ${receipt.sha256}, ${receipt.validation}, ${receipt.committedAt}::TEXT::TIMESTAMPTZ)`;
      }
    });
  }
}
