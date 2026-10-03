import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeProject } from "@mindgrab/document/project-document";
import * as Y from "yjs";
import { base, capture, text } from "../../webapp/tests/fixtures/yjs-scenarios";
import { Archive } from "../src/project/backup";
import { type Fixture, fixture, owner } from "./fixtures";

let f: Fixture;
let id: string;
let user: bigint;
let directory: string;
beforeEach(async () => {
  f = await fixture();
  id = await f.register(await f.signIn());
  user = await owner(f.db, id);
  directory = await mkdtemp(join(tmpdir(), "mindgrab-backup-"));
});
afterEach(async () => {
  await f?.close();
  await rm(directory, { recursive: true, force: true });
});

test("compaction preserves retries and deletion history while requiring a fresh baseline", async () => {
  const doc = base();
  const seed = Y.encodeStateAsUpdate(doc);
  const updateId = crypto.randomUUID();
  await f.backend.services.storage.ingest(user, id, updateId, seed);
  const deletion = capture(doc, () => text(doc).delete(1, 2))[0];
  await f.backend.services.storage.ingest(
    user,
    id,
    crypto.randomUUID(),
    deletion,
  );
  const compacted = await f.backend.maintenance.compact(user, id);
  expect(compacted.prunedRows).toBe(2);
  expect(compacted.coverage).toBe(true);
  expect(
    (await f.backend.services.storage.ingest(user, id, updateId, seed)).created,
  ).toBe(false);
  expect(
    (
      await f.backend.services.storage
        .updates(user, id, 0n, 100)
        .catch((error) => error)
    ).code,
  ).toBe("baseline_required");
  const baseline = await f.backend.services.storage.baseline(user, id);
  const recovered = new Y.Doc({ gc: false });
  Y.applyUpdate(recovered, baseline.bytes);
  expect(materializeProject(recovered)).toEqual(materializeProject(doc));
  expect(
    (
      await f.db`SELECT COUNT(*) AS count FROM crdt_receipt WHERE project_id = ${id}`
    )[0].count,
  ).toBe(2n);
  doc.destroy();
  recovered.destroy();
});

test("pending dependencies never publish a checkpoint or prune source rows", async () => {
  const doc = base();
  await f.backend.services.storage.ingest(
    user,
    id,
    crypto.randomUUID(),
    Y.encodeStateAsUpdate(doc),
  );
  capture(doc, () => text(doc).insert(0, "withheld"));
  const pending = capture(doc, () => text(doc).insert(0, "pending"))[0];
  await f.backend.services.storage.ingest(
    user,
    id,
    crypto.randomUUID(),
    pending,
  );
  expect((await f.backend.maintenance.compact(user, id)).coverage).toBe(false);
  expect(
    (
      await f.db`SELECT COUNT(*) AS count FROM crdt_checkpoint WHERE project_id = ${id}`
    )[0].count,
  ).toBe(0n);
  expect(
    (
      await f.db`SELECT COUNT(*) AS count FROM crdt_update WHERE project_id = ${id}`
    )[0].count,
  ).toBe(2n);
  doc.destroy();
});

test("killing a process before checkpoint commit rolls back publication and pruning", async () => {
  const doc = base();
  await f.backend.services.storage.ingest(
    user,
    id,
    crypto.randomUUID(),
    Y.encodeStateAsUpdate(doc),
  );
  for (const stage of ["published", "pruned"]) {
    const child = Bun.spawn(
      [process.execPath, "--bun", "tests/process-probe.ts"],
      {
        cwd: new URL("../", import.meta.url).pathname,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      child.stdin.write(
        JSON.stringify({
          config: f.config,
          providerUrl: f.providerUrl,
          owner: user.toString(),
          projectId: id,
          operation: "crash",
          stage,
        }),
      );
      child.stdin.end();
      const reader = child.stdout.getReader();
      const ready = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(new Error("Subprocess did not reach checkpoint boundary")),
            5000,
          ),
        ),
      ]);
      expect(new TextDecoder().decode(ready.value)).toContain("ready");
      reader.releaseLock();
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
    expect((await f.backend.services.storage.baseline(user, id)).sequence).toBe(
      1n,
    );
    expect(
      (
        await f.db`SELECT COUNT(*) AS count FROM crdt_checkpoint WHERE project_id = ${id}`
      )[0].count,
    ).toBe(0n);
    expect(
      (
        await f.db`SELECT COUNT(*) AS count FROM crdt_update WHERE project_id = ${id}`
      )[0].count,
    ).toBe(1n);
  }
  doc.destroy();
});

test("binary archives restore exact receipts, timestamps, ownership and document bytes", async () => {
  const doc = base();
  const seed = Y.encodeStateAsUpdate(doc);
  const updateId = crypto.randomUUID();
  await f.backend.services.storage.ingest(user, id, updateId, seed);
  await f.backend.services.storage.ingest(
    user,
    id,
    crypto.randomUUID(),
    capture(doc, () => text(doc).delete(1, 2))[0],
  );
  const archive = await f.backend.backups.export(id, "user_test");
  const path = join(directory, "project.mgbk");
  await archive.write(path);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await archive.write(path).catch((error) => error)).toBeInstanceOf(
    Error,
  );
  const read = await Archive.read(path);
  expect(read.manifest).toEqual(archive.manifest);
  expect(
    (
      await read
        .validate(f.backend.services.storage, id, "wrong-owner")
        .catch((error) => error)
    ).code,
  ).toBe("project_id_conflict");
  expect(
    (
      await f.backend.backups
        .restore(id, "user_test", "user_test", read)
        .catch((error) => error)
    ).code,
  ).toBe("project_id_conflict");
  await f.sessionFor("destination");
  await f.db`DELETE FROM crdt_project WHERE id = ${id}`;
  await f.backend.backups.restore(id, "user_test", "destination", read);
  const destination = await owner(f.db, id);
  expect(destination).not.toBe(user);
  const baseline = await f.backend.services.storage.baseline(destination, id);
  const recovered = new Y.Doc();
  Y.applyUpdate(recovered, baseline.bytes);
  expect(materializeProject(recovered)).toEqual(materializeProject(doc));
  expect(
    (await f.backend.services.storage.ingest(destination, id, updateId, seed))
      .created,
  ).toBe(false);
  expect(
    (await f.backend.backups.export(id, "destination")).manifest.receipts,
  ).toEqual(read.manifest.receipts);
  const damaged = Buffer.from(await Bun.file(path).arrayBuffer());
  damaged[damaged.length - 1] ^= 1;
  await Bun.write(join(directory, "damaged.mgbk"), damaged);
  const corrupt = await Archive.read(join(directory, "damaged.mgbk"));
  expect(
    (
      await corrupt
        .validate(f.backend.services.storage, id, "user_test")
        .catch((error) => error)
    ).code,
  ).toBe("invalid_request");
  doc.destroy();
  recovered.destroy();
});

test("pending and quarantined archives retain their original update tail", async () => {
  const doc = base();
  await f.backend.services.storage.ingest(
    user,
    id,
    crypto.randomUUID(),
    Y.encodeStateAsUpdate(doc),
  );
  const predecessor = capture(doc, () => text(doc).insert(0, "withheld"))[0];
  const invalid = capture(doc, () =>
    doc.getMap("project").set("schemaVersion", 2),
  )[0];
  await f.backend.services.storage.ingest(
    user,
    id,
    crypto.randomUUID(),
    invalid,
  );
  for (const expected of ["pending_dependencies", "quarantined"] as const) {
    if (expected === "quarantined")
      await f.backend.services.storage.ingest(
        user,
        id,
        crypto.randomUUID(),
        predecessor,
      );
    const archive = await f.backend.backups.export(id, "user_test");
    expect(archive.manifest.validation).toBe(expected);
    expect(archive.manifest.coveredSequence).toBe("0");
    await f.db`DELETE FROM crdt_project WHERE id = ${id}`;
    await f.backend.backups.restore(id, "user_test", "user_test", archive);
    expect(
      (await f.db`SELECT validation FROM crdt_project WHERE id = ${id}`)[0]
        .validation,
    ).toBe(expected);
  }
  doc.destroy();
});
