// Test-only subprocess entry point. Fault injection is absent from production.
import { Backend } from "../src/backend";
import type { Config } from "../src/config";
import { connect } from "../src/db";
import { digest, load, lockProject } from "../src/project/storage";
import { WorkOs } from "../src/workos";

const input = (await Bun.stdin.json()) as {
  config: Config;
  providerUrl: string;
  owner: string;
  projectId: string;
  operation: "baseline" | "crash";
  stage?: "published" | "pruned";
};
const db = connect(input.config.databaseUrl);
const backend = new Backend(
  db,
  input.config,
  new WorkOs(input.config, input.providerUrl),
);
try {
  if (input.operation === "baseline") {
    const baseline = await backend.services.storage.baseline(
      BigInt(input.owner),
      input.projectId,
    );
    console.log(
      JSON.stringify({
        sequence: baseline.sequence.toString(),
        bytes: [...baseline.bytes],
        validation: baseline.validation,
      }),
    );
  } else {
    await db.begin(async (tx) => {
      const project = await lockProject(
        tx,
        input.projectId,
        BigInt(input.owner),
      );
      const candidate = await backend.services.storage.documents.run(
        await load(tx, input.projectId, project.last_sequence),
        true,
      );
      if (!candidate.checkpoint)
        throw new Error("Expected complete checkpoint");
      await tx`INSERT INTO crdt_checkpoint (project_id, covered_sequence, data, sha256) VALUES (${input.projectId}, ${project.last_sequence}, ${Buffer.from(candidate.checkpoint)}, ${digest(candidate.checkpoint)})`;
      if (input.stage === "pruned")
        await tx`DELETE FROM crdt_update WHERE project_id = ${input.projectId}`;
      console.log("ready");
      await new Promise<void>(() => {});
    });
  }
} finally {
  await backend.close();
  await db.close();
}
