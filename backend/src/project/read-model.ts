import {
  type EffectivePlacement,
  effectivePlacements,
  type ProjectContent,
} from "@mindgrab/document/project-document";
import { type Database, one, query } from "../db";
import { ApiError } from "../errors";
import { decodeText } from "./catalog";
import { load, lockProject, type Storage, supported } from "./storage";

interface FreshnessRow {
  last_sequence: bigint;
  source_sequence: bigint | null;
  attempted_sequence: bigint;
  projection_version: number | null;
  status: string;
  name: Uint8Array | null;
  node_count: number | null;
  content_updated_at: string | null;
}
interface NodeRow {
  node_id: string;
  text: Uint8Array;
  color: ProjectContent["nodes"][string]["color"];
  deleted: boolean;
  stored_parent: string | null;
  rank: string;
  position_x: number | null;
  position_y: number | null;
  effective_parent: string | null;
  sibling_order: number | null;
}

export class ReadModels {
  constructor(readonly storage: Storage) {}

  private async publish(
    tx: Database,
    id: string,
    sequence: bigint,
    content: ProjectContent,
  ) {
    const placements = effectivePlacements(content);
    await query(tx, "DELETE FROM crdt_node_read WHERE project_id = $1", [id]);
    const nodes = Object.entries(content.nodes);
    for (let offset = 0; offset < nodes.length; offset += 500) {
      const params: unknown[] = [];
      const rows = nodes.slice(offset, offset + 500).map(([nodeId, node]) => {
        const effective = placements[nodeId];
        const values = [
          id,
          nodeId,
          sequence,
          Buffer.from(node.text),
          node.color,
          node.deleted,
          node.placement.parent,
          node.placement.rank,
          node.position?.x ?? null,
          node.position?.y ?? null,
          effective?.parent ?? null,
          effective?.siblingOrder ?? null,
        ];
        return `(${values
          .map((value) => {
            params.push(value);
            return `$${params.length}`;
          })
          .join(",")})`;
      });
      await query(
        tx,
        `INSERT INTO crdt_node_read (project_id, node_id, source_sequence, text, color, deleted, stored_parent, rank, position_x, position_y, effective_parent, sibling_order) VALUES ${rows.join(",")}`,
        params,
      );
    }
    await query(
      tx,
      "UPDATE crdt_project SET name = $2, node_count = $3, projection_sequence = $4, name_utf8 = $5 WHERE id = $1",
      [
        id,
        content.metadata.name.includes("\0") ? null : content.metadata.name,
        Object.keys(placements).length,
        sequence,
        Buffer.from(content.metadata.name),
      ],
    );
  }

  private async refresh(
    tx: Database,
    owner: bigint,
    id: string,
    force: boolean,
  ) {
    const project = await lockProject(tx, id, owner);
    supported(project);
    const previous = await one<{ attempted: bigint; version: number | null }>(
      tx,
      "SELECT projection_attempt_sequence AS attempted, projection_version AS version FROM crdt_project WHERE id = $1",
      [id],
    );
    if (
      !force &&
      previous?.attempted === project.last_sequence &&
      previous.version === 1
    )
      return;
    let status: string;
    let content: ProjectContent | undefined;
    if (project.validation === "quarantined") status = "quarantined";
    else if (project.last_sequence === 0n) status = "uninitialized";
    else {
      content = (
        await this.storage.documents.run(
          await load(tx, id, project.last_sequence),
        )
      ).content;
      status = content ? "ready" : "pending_dependencies";
    }
    if (content) await this.publish(tx, id, project.last_sequence, content);
    else if (force) {
      await query(tx, "DELETE FROM crdt_node_read WHERE project_id = $1", [id]);
      await query(
        tx,
        "UPDATE crdt_project SET name = NULL, name_utf8 = NULL, node_count = NULL, projection_sequence = NULL WHERE id = $1",
        [id],
      );
    }
    await query(
      tx,
      "UPDATE crdt_project SET projection_attempt_sequence = $2, projection_version = 1, projection_status = $3 WHERE id = $1",
      [id, project.last_sequence, status],
    );
  }

  async current(owner: bigint, id: string) {
    return this.storage.db.begin(async (tx) => {
      await this.refresh(tx, owner, id, false);
      const freshness = await one<FreshnessRow>(
        tx,
        `SELECT last_sequence, projection_sequence AS source_sequence, projection_attempt_sequence AS attempted_sequence, projection_version, projection_status AS status, COALESCE(name_utf8, convert_to(name, 'UTF8')) AS name, node_count, to_char(content_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS content_updated_at FROM crdt_project WHERE id = $1`,
        [id],
      );
      if (!freshness) throw new ApiError("project_not_found");
      const rows = await query<NodeRow>(
        tx,
        "SELECT node_id, text, color, deleted, stored_parent, rank, position_x, position_y, effective_parent, sibling_order FROM crdt_node_read WHERE project_id = $1",
        [id],
      );
      const nodes: ProjectContent["nodes"] = {};
      const placements: Record<string, EffectivePlacement> = {};
      for (const row of rows) {
        if (row.sibling_order !== null)
          placements[row.node_id] = {
            parent: row.effective_parent,
            siblingOrder: row.sibling_order,
          };
        nodes[row.node_id] = {
          text: decodeText(row.text) ?? "",
          color: row.color,
          deleted: row.deleted,
          placement: { parent: row.stored_parent, rank: row.rank },
          ...(row.position_x !== null &&
            row.position_y !== null && {
              position: { x: row.position_x, y: row.position_y },
            }),
        };
      }
      const name = decodeText(freshness.name);
      return {
        projectId: id,
        schemaVersion: 1,
        current:
          freshness.status === "ready" &&
          freshness.source_sequence === freshness.last_sequence,
        freshness: {
          lastSequence: freshness.last_sequence.toString(),
          sourceSequence: freshness.source_sequence?.toString() ?? null,
          attemptedSequence: freshness.attempted_sequence.toString(),
          projectionVersion: freshness.projection_version,
          status: freshness.status,
          name,
          nodeCount: freshness.node_count,
          contentUpdatedAt: freshness.content_updated_at,
        },
        content:
          freshness.source_sequence !== null && name !== null
            ? { schemaVersion: 1, metadata: { name }, nodes }
            : null,
        placements,
      };
    });
  }

  async rebuild(owner: bigint, id: string) {
    await this.storage.db.begin((tx) => this.refresh(tx, owner, id, true));
  }

  async rebuildAll() {
    let after: string | null = null;
    let failed = false;
    for (;;) {
      const projects: { id: string; owner_id: bigint }[] = await query(
        this.storage.db,
        "SELECT id, owner_id FROM crdt_project WHERE ($1::UUID IS NULL OR id > $1) ORDER BY id LIMIT 50",
        [after],
      );
      if (!projects.length) break;
      for (const project of projects) {
        after = project.id;
        try {
          await this.rebuild(project.owner_id, project.id);
        } catch {
          failed = true;
          console.error(`Read-model rebuild failed for project ${project.id}`);
        }
      }
    }
    if (failed) throw new ApiError("unavailable");
  }

  async sweep(after: string | null) {
    const projects = await query<{ id: string; owner_id: bigint }>(
      this.storage.db,
      "SELECT id, owner_id FROM crdt_project WHERE last_sequence > 0 AND (projection_attempt_sequence < last_sequence OR projection_version IS DISTINCT FROM 1) AND ($1::UUID IS NULL OR id > $1) ORDER BY id LIMIT 50",
      [after],
    );
    for (const project of projects) {
      try {
        await this.storage.db.begin((tx) =>
          this.refresh(tx, project.owner_id, project.id, false),
        );
      } catch {
        console.error(`Read-model catch-up failed for project ${project.id}`);
      }
    }
    return projects.at(-1)?.id ?? null;
  }
}
