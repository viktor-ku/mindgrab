import { one, query } from "../db";
import { ApiError } from "../errors";
import { digest, load, lockProject, type Storage, supported } from "./storage";

export class Maintenance {
  constructor(readonly storage: Storage) {}

  async compact(owner: bigint, id: string) {
    const started = performance.now();
    return this.storage.db.begin(async (tx) => {
      await tx`SET LOCAL synchronous_commit = on`;
      await tx`SET LOCAL lock_timeout = '5s'`;
      const project = await lockProject(tx, id, owner);
      supported(project);
      const totals = await one<{ rows: bigint; bytes: bigint }>(
        tx,
        "SELECT COUNT(*) AS rows, COALESCE(SUM(octet_length(data)), 0)::BIGINT AS bytes FROM crdt_update WHERE project_id = $1",
        [id],
      );
      const previous = await one<{ size: number }>(
        tx,
        "SELECT octet_length(data) AS size FROM crdt_checkpoint WHERE project_id = $1",
        [id],
      );
      const metrics = {
        sequence: project.last_sequence.toString(),
        prunedRows: 0,
        logRows: Number(totals?.rows ?? 0n),
        logBytes: Number(totals?.bytes ?? 0n),
        checkpointBytes: previous?.size ?? 0,
        replayMicros: 0,
        elapsedMicros: 0,
        coverage: false,
      };
      if (project.last_sequence > 0n && project.validation !== "quarantined") {
        const replay = performance.now();
        const candidate = await this.storage.documents.run(
          await load(tx, id, project.last_sequence),
          true,
        );
        metrics.replayMicros = Math.round((performance.now() - replay) * 1000);
        if (candidate.checkpoint) {
          const receipts = await one<{ count: bigint }>(
            tx,
            "SELECT COUNT(*) AS count FROM crdt_receipt WHERE project_id = $1 AND sequence <= $2",
            [id, project.last_sequence],
          );
          if (receipts?.count !== project.last_sequence)
            throw new ApiError("unavailable");
          const checkpoint = candidate.checkpoint;
          await tx`INSERT INTO crdt_checkpoint (project_id, covered_sequence, data, sha256, checkpoint_version, encoding) VALUES (${id}, ${project.last_sequence}, ${Buffer.from(checkpoint)}, ${digest(checkpoint)}, 1, 'yjs-v1')
            ON CONFLICT (project_id) DO UPDATE SET covered_sequence = EXCLUDED.covered_sequence, data = EXCLUDED.data, sha256 = EXCLUDED.sha256, checkpoint_version = EXCLUDED.checkpoint_version, encoding = EXCLUDED.encoding, created_at = NOW()`;
          const deleted =
            await tx`DELETE FROM crdt_update WHERE project_id = ${id} AND sequence <= ${project.last_sequence}`;
          metrics.prunedRows = deleted.count;
          metrics.checkpointBytes = checkpoint.length;
          metrics.coverage = true;
        }
      }
      await tx`UPDATE crdt_project SET compaction_attempt_sequence = ${project.last_sequence}, compaction_failures = 0, compaction_retry_at = NOW() WHERE id = ${id}`;
      metrics.elapsedMicros = Math.round((performance.now() - started) * 1000);
      return metrics;
    });
  }

  async sweep(after: string | null) {
    const projects = await query<{ id: string; owner_id: bigint }>(
      this.storage.db,
      "SELECT id, owner_id FROM crdt_project WHERE ($1::UUID IS NULL OR id > $1) AND last_sequence > 0 AND compaction_retry_at <= NOW() AND (last_sequence > compaction_attempt_sequence OR compaction_failures > 0) ORDER BY id LIMIT 50",
      [after],
    );
    for (const project of projects) {
      const due = await one<{ due: boolean }>(
        this.storage.db,
        "SELECT COUNT(*) >= 1000 OR COALESCE(SUM(octet_length(data)), 0) >= 1048576 OR COALESCE(MIN(committed_at) <= NOW() - INTERVAL '1 hour', FALSE) AS due FROM crdt_update WHERE project_id = $1",
        [project.id],
      );
      if (!due?.due) continue;
      try {
        await this.compact(project.owner_id, project.id);
      } catch {
        await query(
          this.storage.db,
          "UPDATE crdt_project SET compaction_failures = LEAST(compaction_failures + 1, 10), compaction_retry_at = NOW() + make_interval(secs => LEAST(1800, 30 * (1 << LEAST(compaction_failures, 6)))) WHERE id = $1",
          [project.id],
        ).catch(() => {});
        console.error(
          `Compaction failed for project ${project.id}; source rows retained`,
        );
      }
    }
    return projects.at(-1)?.id ?? null;
  }
}
