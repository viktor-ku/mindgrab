import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import {
  effectivePlacements,
  materializeProject,
} from "@mindgrab/document/project-document";
import * as Y from "yjs";
import { updateBatches } from "../../webapp/src/update-batches";
import { addNode } from "../../webapp/tests/fixtures/project-document";
import {
  base,
  capture,
  ID,
  node,
  text,
} from "../../webapp/tests/fixtures/yjs-scenarios";
import { migrate } from "../src/db";
import { ApiError } from "../src/errors";
import { type Fixture, fixture, initial, owner } from "./fixtures";

let f: Fixture;
let credential: string;
let id: string;
let user: bigint;
beforeEach(async () => {
  f = await fixture();
  credential = await f.signIn();
  id = await f.register(credential);
  user = await owner(f.db, id);
});
afterEach(async () => {
  await f?.close();
});

test("checked-in goldens agree with durable ingestion and SQL projections in every delivery schedule", async () => {
  const directory = new URL(
    "../../webapp/tests/fixtures/yjs/",
    import.meta.url,
  );
  for (const name of (await readdir(directory)).filter((name) =>
    name.endsWith(".json"),
  )) {
    const golden = await Bun.file(new URL(name, directory)).json();
    const originals: Uint8Array[] = await Promise.all(
      golden.updates.map(
        async (name: string) =>
          new Uint8Array(
            await Bun.file(new URL(name, directory)).arrayBuffer(),
          ),
      ),
    );
    for (const updates of [
      originals,
      [...originals].reverse(),
      originals.flatMap((update) => [update, update]),
    ]) {
      const project = await f.register(credential);
      for (const update of updates) {
        const updateId = crypto.randomUUID();
        const accepted = await f.backend.services.storage.ingest(
          user,
          project,
          updateId,
          update,
        );
        const retried = await f.backend.services.storage.ingest(
          user,
          project,
          updateId,
          update,
        );
        expect(retried.created).toBe(false);
        expect(retried.receipt).toEqual(accepted.receipt);
      }
      const view = await f.backend.services.readModels.current(user, project);
      expect(view.current).toBe(true);
      expect(view.content).toEqual(golden.expected);
      expect(view.placements).toEqual(effectivePlacements(golden.expected));
      expect(
        (await f.backend.maintenance.compact(user, project)).coverage,
      ).toBe(true);
      const doc = new Y.Doc({ gc: false });
      Y.applyUpdate(
        doc,
        (await f.backend.services.storage.baseline(user, project)).bytes,
      );
      expect(materializeProject(doc)).toEqual(golden.expected);
      doc.destroy();
    }
  }
}, 15000);

test("causal gaps survive a fresh process and keep the last complete read model", async () => {
  const writer = base();
  const seed = Y.encodeStateAsUpdate(writer);
  await f.backend.services.storage.ingest(user, id, crypto.randomUUID(), seed);
  const first = await f.backend.services.readModels.current(user, id);
  const a = capture(writer, () => text(writer).insert(0, "A"))[0];
  const b = capture(writer, () => text(writer).insert(1, "B"))[0];
  const c = capture(writer, () => text(writer, ID(2)).insert(0, "C"))[0];
  for (const update of [b, c])
    await f.backend.services.storage.ingest(
      user,
      id,
      crypto.randomUUID(),
      update,
    );
  const pending = await f.backend.services.readModels.current(user, id);
  expect(pending.current).toBe(false);
  expect(pending.content).toEqual(first.content);
  expect(pending.freshness.status).toBe("pending_dependencies");
  const process = Bun.spawn(
    [processExec(), "--bun", "tests/process-probe.ts"],
    {
      cwd: new URL("../", import.meta.url).pathname,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  process.stdin.write(
    JSON.stringify({
      config: f.config,
      providerUrl: f.providerUrl,
      owner: user.toString(),
      projectId: id,
      operation: "baseline",
    }),
  );
  process.stdin.end();
  const [code, output, errors] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect(errors).toBe("");
  expect(code).toBe(0);
  const restarted = JSON.parse(output);
  expect(restarted.validation).toBe("pending_dependencies");
  const remote = new Y.Doc({ gc: false });
  Y.applyUpdate(remote, new Uint8Array(restarted.bytes));
  Y.applyUpdate(remote, a);
  expect(materializeProject(remote)).toEqual(materializeProject(writer));
  await f.backend.services.storage.ingest(user, id, crypto.randomUUID(), a);
  const complete = await f.backend.services.readModels.current(user, id);
  expect(complete.current).toBe(true);
  expect(complete.content).toEqual(materializeProject(writer));
  expect(complete.placements).toEqual(
    effectivePlacements(materializeProject(writer)),
  );
  for (const doc of [writer, remote]) doc.destroy();
});

function processExec() {
  return process.execPath;
}

test("pending invalid content is preserved and quarantined when its dependency arrives", async () => {
  const writer = base();
  await f.backend.services.storage.ingest(
    user,
    id,
    crypto.randomUUID(),
    Y.encodeStateAsUpdate(writer),
  );
  await f.backend.services.readModels.current(user, id);
  const withheld = capture(writer, () =>
    text(writer).insert(0, "dependency"),
  )[0];
  const invalid = capture(writer, () =>
    (writer.getMap("project").get("nodes") as Y.Map<Y.Map<unknown>>)
      .get(ID(2))!
      .set("color", "unknown"),
  )[0];
  expect(
    (
      await f.backend.services.storage.ingest(
        user,
        id,
        crypto.randomUUID(),
        invalid,
      )
    ).receipt.validation,
  ).toBe("pending_dependencies");
  expect(
    (
      await f.backend.services.storage.ingest(
        user,
        id,
        crypto.randomUUID(),
        withheld,
      )
    ).receipt.validation,
  ).toBe("quarantined");
  const failed = await f.backend.services.storage
    .baseline(user, id)
    .catch((error) => error);
  expect(failed).toBeInstanceOf(ApiError);
  expect(failed.code).toBe("project_quarantined");
  expect((await f.backend.maintenance.compact(user, id)).prunedRows).toBe(0);
  await f.backend.services.readModels.rebuild(user, id);
  expect(
    (await f.backend.services.readModels.current(user, id)).content,
  ).toBeNull();
  expect(
    (
      await f.db`SELECT COUNT(*) AS count FROM crdt_update WHERE project_id = ${id}`
    )[0].count,
  ).toBe(3n);
  writer.destroy();
});

test("delete-only updates remain durable with equal state vectors", async () => {
  const writer = base();
  const seed = Y.encodeStateAsUpdate(writer);
  await f.backend.services.storage.ingest(user, id, crypto.randomUUID(), seed);
  const before = await f.backend.services.storage.baseline(user, id);
  const deletion = capture(writer, () => text(writer).delete(1, 2))[0];
  await f.backend.services.storage.ingest(
    user,
    id,
    crypto.randomUUID(),
    deletion,
  );
  const after = await f.backend.services.storage.baseline(user, id);
  expect(Y.decodeStateVector(after.stateVector)).toEqual(
    Y.decodeStateVector(before.stateVector),
  );
  expect(after.sequence).toBe(2n);
  expect(
    (await f.backend.services.readModels.current(user, id)).content,
  ).toEqual(materializeProject(writer));
  writer.destroy();
});

test("schema, text, name, rank and shared-type limits reject complete candidates", async () => {
  const candidates: { update: Uint8Array; status: number }[] = [];
  for (const mutation of [
    {
      action: (doc: Y.Doc) =>
        (doc.getMap("project").get("metadata") as Y.Map<unknown>).set(
          "name",
          "x".repeat(201),
        ),
      status: 413,
    },
    {
      action: (doc: Y.Doc) => text(doc).insert(0, "x".repeat(65537)),
      status: 413,
    },
    {
      action: (doc: Y.Doc) => doc.getMap("project").set("schemaVersion", 2),
      status: 426,
    },
    {
      action: (doc: Y.Doc) => doc.getMap("project").set("unknown", true),
      status: 422,
    },
    {
      action: (doc: Y.Doc) => text(doc).format(0, 1, { bold: true }),
      status: 422,
    },
  ]) {
    const doc = base();
    mutation.action(doc);
    candidates.push({
      update: Y.encodeStateAsUpdate(doc),
      status: mutation.status,
    });
    doc.destroy();
  }
  for (const candidate of candidates)
    expect((await f.submit(credential, id, candidate.update)).status).toBe(
      candidate.status,
    );
  expect(
    (
      await f.db`SELECT COUNT(*) AS count FROM crdt_receipt WHERE project_id = ${id}`
    )[0].count,
  ).toBe(0n);
});

test("large offline documents split into bounded updates and recover from binary storage", async () => {
  const doc = base();
  for (let index = 4; index < 80; index++)
    addNode(doc, ID(index), node("😀".repeat(16000)));
  const encoded = Y.encodeStateAsUpdate(doc);
  expect(encoded.length).toBeGreaterThan(2 * 1048576);
  const batches = updateBatches(encoded);
  expect(batches.every((batch) => batch.length <= 1048576)).toBe(true);
  for (const batch of batches)
    expect((await f.submit(credential, id, batch)).status).toBe(201);
  const baseline = await f.backend.services.storage.baseline(user, id);
  expect(baseline.validation).toBe("valid");
  const recovered = new Y.Doc();
  Y.applyUpdate(recovered, baseline.bytes);
  expect(materializeProject(recovered)).toEqual(materializeProject(doc));
  doc.destroy();
  recovered.destroy();
});

test("read-model rebuild repairs derived corruption, Unicode and embedded NUL without changing receipts", async () => {
  const doc = base();
  (doc.getMap("project").get("metadata") as Y.Map<unknown>).set(
    "name",
    "Ideas\0🌍",
  );
  text(doc).insert(0, "\0");
  await f.backend.services.storage.ingest(
    user,
    id,
    crypto.randomUUID(),
    Y.encodeStateAsUpdate(doc),
  );
  const expected = materializeProject(doc);
  expect(
    (await f.backend.services.readModels.current(user, id)).content,
  ).toEqual(expected);
  await f.db`DELETE FROM crdt_node_read WHERE project_id = ${id}`;
  await f.db`UPDATE crdt_project SET name_utf8 = ${Buffer.from("corrupt")}, node_count = 0 WHERE id = ${id}`;
  await f.backend.services.readModels.rebuild(user, id);
  expect(
    (await f.backend.services.readModels.current(user, id)).content,
  ).toEqual(expected);
  expect((await f.backend.services.catalog.get(user, id)).name).toBe(
    expected.metadata.name,
  );
  expect(
    (
      await f.db`SELECT COUNT(*) AS count FROM crdt_receipt WHERE project_id = ${id}`
    )[0].count,
  ).toBe(1n);
  doc.destroy();
});

test("read-model commit failure preserves the prior view and accepted updates", async () => {
  const doc = base();
  await f.backend.services.storage.ingest(
    user,
    id,
    crypto.randomUUID(),
    Y.encodeStateAsUpdate(doc),
  );
  const before = await f.backend.services.readModels.current(user, id);
  const update = capture(doc, () => text(doc).insert(0, "new "))[0];
  await f.backend.services.storage.ingest(
    user,
    id,
    crypto.randomUUID(),
    update,
  );
  await f.db.unsafe(
    "CREATE FUNCTION fail_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected projection failure'; END; $$; CREATE CONSTRAINT TRIGGER fail_projection AFTER INSERT ON crdt_node_read DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_projection()",
  );
  expect(
    await f.backend.services.readModels
      .current(user, id)
      .catch((error) => error),
  ).toBeInstanceOf(Error);
  expect(
    (
      await f.db`SELECT projection_sequence FROM crdt_project WHERE id = ${id}`
    )[0].projection_sequence,
  ).toBe(BigInt(before.freshness.sourceSequence!));
  expect(
    (
      await f.db`SELECT COUNT(*) AS count FROM crdt_receipt WHERE project_id = ${id}`
    )[0].count,
  ).toBe(2n);
  await f.db.unsafe(
    "DROP TRIGGER fail_projection ON crdt_node_read; DROP FUNCTION fail_projection()",
  );
  expect(
    (await f.backend.services.readModels.current(user, id)).content,
  ).toEqual(materializeProject(doc));
  doc.destroy();
});

test("migration adoption and concurrent runs preserve existing data", async () => {
  await f.db.unsafe(
    "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, checksum BYTEA NOT NULL, success BOOLEAN NOT NULL); INSERT INTO _sqlx_migrations SELECT version, checksum, TRUE FROM backend_migrations; DROP TABLE backend_migrations",
  );
  await Promise.all([migrate(f.db), migrate(f.db)]);
  expect(
    (await f.db`SELECT COUNT(*) AS count FROM backend_migrations`)[0].count,
  ).toBe(11n);
  expect((await f.db`SELECT id FROM crdt_project WHERE id = ${id}`)[0].id).toBe(
    id,
  );
  await f.db`UPDATE backend_migrations SET checksum = ${Buffer.from("corrupt")} WHERE version = 1`;
  expect(await migrate(f.db).catch((error) => error)).toBeInstanceOf(Error);
});

test("corrupt canonical bytes and missing log sequences fail closed", async () => {
  await f.backend.services.storage.ingest(
    user,
    id,
    crypto.randomUUID(),
    initial,
  );
  await f.db`ALTER TABLE crdt_update DISABLE TRIGGER crdt_update_is_immutable`;
  await f.db`UPDATE crdt_update SET data = ${Buffer.from([0, 0])} WHERE project_id = ${id}`;
  expect(
    (
      await f.backend.services.storage
        .baseline(user, id)
        .catch((error) => error)
    ).code,
  ).toBe("unavailable");
  await f.db`DELETE FROM crdt_update WHERE project_id = ${id}`;
  expect(
    (
      await f.backend.services.storage
        .baseline(user, id)
        .catch((error) => error)
    ).code,
  ).toBe("unavailable");
});
