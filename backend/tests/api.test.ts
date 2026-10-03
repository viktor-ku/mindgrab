import { afterEach, beforeEach, expect, test } from "bun:test";
import { Backend } from "../src/backend";
import { type Fixture, fixture, initial, ORIGIN, owner } from "./fixtures";

let f: Fixture;
let credential: string;
beforeEach(async () => {
  f = await fixture();
  credential = await f.signIn();
});
afterEach(async () => {
  await f?.close();
});

test("health, private response headers and method contracts", async () => {
  const health = await f.rpc("getHealth", {});
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({
    status: "ok",
    database: { status: "up" },
  });
  expect(health.headers.get("Cache-Control")).toBe("no-store");
  expect(health.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(health.headers.get("Server-Timing")).toMatch(/db;dur=.*request;dur=/);
  expect((await f.request("/api/getMe")).status).toBe(405);
  expect((await f.request("/")).headers.get("Cache-Control")).toBeNull();
});

test("registration retries preserve identity, ownership, versions and reconnect state", async () => {
  const id = await f.register(credential);
  const registered = await f.rpc(
    "createProject",
    { projectId: id, schemaVersion: 1 },
    credential,
  );
  expect(registered.status).toBe(200);
  expect(await registered.json()).toMatchObject({
    projectId: id,
    name: null,
    lastSequence: "0",
  });
  const other = await f.sessionFor("user_other");
  expect(
    (await f.rpc("createProject", { projectId: id, schemaVersion: 1 }, other))
      .status,
  ).toBe(409);
  expect((await f.rpc("getProject", { projectId: id }, other)).status).toBe(
    404,
  );
  expect(
    (
      await f.rpc(
        "createProject",
        { projectId: crypto.randomUUID(), schemaVersion: 2 },
        credential,
      )
    ).status,
  ).toBe(426);
  expect(
    (
      await f.rpc(
        "createProject",
        { projectId: id.toUpperCase(), schemaVersion: 1 },
        credential,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.rpc(
        "createProject",
        { projectId: "00000000-0000-0000-0000-000000000000", schemaVersion: 1 },
        credential,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.rpc(
        "createProject",
        { projectId: crypto.randomUUID(), schemaVersion: 1, name: "unknown" },
        credential,
      )
    ).status,
  ).toBe(400);
});

test("concurrent registration creates one project and stable owner-scoped pagination", async () => {
  const id = crypto.randomUUID();
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      f.rpc("createProject", { projectId: id, schemaVersion: 1 }, credential),
    ),
  );
  expect(results.filter((response) => response.status === 201)).toHaveLength(1);
  for (let i = 0; i < 8; i++) await f.register(credential);
  const other = await f.sessionFor("user_other");
  await f.register(other);
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await f.rpc(
      "listProjects",
      { limit: 2, ...(cursor ? { cursor } : {}) },
      credential,
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      projects: { projectId: string }[];
      nextCursor: string | null;
    };
    ids.push(...page.projects.map((project) => project.projectId));
    cursor = page.nextCursor;
  } while (cursor);
  expect(new Set(ids).size).toBe(9);
  expect(
    (await f.rpc("listProjects", { cursor: "invalid" }, credential)).status,
  ).toBe(400);
  expect((await f.rpc("listProjects", { limit: 0 }, credential)).status).toBe(
    400,
  );
});

test("account fences and origin checks precede ownership, metadata and body reads", async () => {
  const id = await f.register(credential);
  const user = await owner(f.db, id);
  const other = await f.sessionFor("user_other");
  const headers = { "X-Mindgrab-Account": user.toString() };
  for (const method of [
    "getProject",
    "getProjectBaseline",
    "getProjectState",
    "getProjectStatus",
    "getProjectUpdates",
  ])
    expect(
      (await f.rpc(method, { projectId: id }, other, headers)).status,
    ).toBe(409);
  expect(
    (await f.submit(other, id, initial, crypto.randomUUID(), headers)).status,
  ).toBe(409);
  expect(
    (
      await f.rpc("getProject", { projectId: id }, credential, {
        "X-Mindgrab-Account": `0${user}`,
      })
    ).status,
  ).toBe(400);
  for (const origin of [
    "null",
    "https://attacker.example",
    "http://localhost:5174",
    `${ORIGIN}/`,
  ]) {
    expect(
      (
        await f.submit(credential, id, initial, crypto.randomUUID(), {
          Origin: origin,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.rpc(
          "createProject",
          { projectId: crypto.randomUUID(), schemaVersion: 1 },
          credential,
          { Origin: origin },
        )
      ).status,
    ).toBe(403);
  }
  expect((await f.submit("", id, initial)).status).toBe(401);
});

test("submission validates query IDs, headers, binary bounds and every owner's reads", async () => {
  const id = await f.register(credential);
  expect(
    (
      await f.submit(credential, id, initial, crypto.randomUUID(), {
        "X-Mindgrab-Schema-Version": "2",
      })
    ).status,
  ).toBe(426);
  expect(
    (
      await f.submit(credential, id, initial, crypto.randomUUID(), {
        "Content-Type": "text/plain",
      })
    ).status,
  ).toBe(400);
  expect((await f.submit(credential, id, new Uint8Array(1048577))).status).toBe(
    413,
  );
  expect(
    (await f.submit(credential, id, new Uint8Array([0, 0, 1]))).status,
  ).toBe(400);
  const duplicate = `/api/submitProjectUpdate?projectId=${id}&projectId=${id}&updateId=${crypto.randomUUID()}`;
  expect(
    (await f.request(duplicate, { method: "POST" }, credential)).status,
  ).toBe(400);
  const other = await f.sessionFor("user_other");
  for (const method of [
    "getProjectBaseline",
    "getProjectState",
    "getProjectStatus",
    "getProjectUpdates",
  ])
    expect((await f.rpc(method, { projectId: id }, other)).status).toBe(404);
  expect((await f.submit(other, id, initial)).status).toBe(404);
  expect(
    (
      await f.rpc(
        "getProjectUpdates",
        { projectId: id, after: "01" },
        credential,
      )
    ).status,
  ).toBe(400);
});

test("receipts are committed, immutable and idempotent across backend recreation", async () => {
  const id = await f.register(credential);
  const updateId = crypto.randomUUID();
  const first = await f.submit(credential, id, initial, updateId);
  expect(first.status).toBe(201);
  const receipt = await first.json();
  expect(receipt).toMatchObject({
    sequence: "1",
    updateId,
    durable: true,
    validation: "valid",
  });
  const replay = await f.submit(credential, id, initial, updateId);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(receipt);
  expect(
    (await f.submit(credential, id, new Uint8Array([0, 0]), updateId)).status,
  ).toBe(409);
  expect(
    await f.db`UPDATE crdt_update SET data = ${Buffer.from([0, 0])} WHERE project_id = ${id}`.then(
      () => undefined,
      (error) => error,
    ),
  ).toBeDefined();
  expect(
    await f.db`UPDATE crdt_receipt SET sha256 = ${"0".repeat(64)} WHERE project_id = ${id}`.then(
      () => undefined,
      (error) => error,
    ),
  ).toBeDefined();
  const recreated = new Backend(f.db, f.config, f.provider);
  try {
    const response = await recreated.fetch(
      new Request(`${f.url}/api/getProjectBaseline`, {
        method: "POST",
        headers: { Cookie: credential, "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: id }),
      }),
      "127.0.0.1",
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      lastSequence: "1",
      validation: "valid",
    });
  } finally {
    await recreated.close();
  }
});

test("concurrent writers allocate gapless sequences and concurrent retries share one receipt", async () => {
  const id = await f.register(credential);
  const updateId = crypto.randomUUID();
  const duplicate = await Promise.all(
    Array.from({ length: 8 }, () =>
      f.submit(credential, id, initial, updateId),
    ),
  );
  expect(duplicate.filter((response) => response.status === 201)).toHaveLength(
    1,
  );
  const unique = await Promise.all(
    Array.from({ length: 12 }, () => f.submit(credential, id, initial)),
  );
  expect(unique.every((response) => response.status === 201)).toBe(true);
  const rows =
    await f.db`SELECT sequence FROM crdt_receipt WHERE project_id = ${id} ORDER BY sequence`;
  expect(rows.map((row: { sequence: bigint }) => row.sequence)).toEqual(
    Array.from({ length: 13 }, (_, index) => BigInt(index + 1)),
  );
});

test("a deferred commit failure returns no receipt and rolls back all update state", async () => {
  const id = await f.register(credential);
  await f.db.unsafe(
    "CREATE FUNCTION fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected commit failure'; END; $$; CREATE CONSTRAINT TRIGGER fail_commit AFTER INSERT ON crdt_update DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_commit()",
  );
  const failed = await f.submit(credential, id, initial);
  expect(failed.status).toBe(503);
  expect(await failed.json()).toMatchObject({ error: { code: "unavailable" } });
  expect(
    (await f.db`SELECT last_sequence FROM crdt_project WHERE id = ${id}`)[0]
      .last_sequence,
  ).toBe(0n);
  expect(
    (
      await f.db`SELECT COUNT(*) AS count FROM crdt_receipt WHERE project_id = ${id}`
    )[0].count,
  ).toBe(0n);
  await f.db.unsafe(
    "DROP TRIGGER fail_commit ON crdt_update; DROP FUNCTION fail_commit()",
  );
  expect((await f.submit(credential, id, initial)).status).toBe(201);
});

test("deleting cloud storage is owner scoped, idempotent and cascades to every project table", async () => {
  const id = await f.register(credential);
  const user = await owner(f.db, id);
  const data = initial;
  await f.backend.services.storage.ingest(user, id, crypto.randomUUID(), data);
  await f.backend.services.readModels.current(user, id);
  await f.backend.maintenance.compact(user, id);
  const other = await f.sessionFor("user_other");
  expect((await f.rpc("deleteProject", { projectId: id }, other)).status).toBe(
    200,
  );
  expect(
    (await f.rpc("getProject", { projectId: id }, credential)).status,
  ).toBe(200);
  expect((await f.rpc("deleteProject", { projectId: id })).status).toBe(401);
  expect(
    (await f.rpc("deleteProject", { projectId: id }, credential)).status,
  ).toBe(200);
  expect(
    (await f.rpc("deleteProject", { projectId: id }, credential)).status,
  ).toBe(200);
  for (const table of [
    "crdt_update",
    "crdt_checkpoint",
    "crdt_receipt",
    "crdt_node_read",
  ])
    expect(
      (await f.db.unsafe(`SELECT * FROM ${table} WHERE project_id = $1`, [id]))
        .length,
    ).toBe(0);
  expect((await f.db`SELECT * FROM crdt_project WHERE id = ${id}`).length).toBe(
    0,
  );
  expect(
    (await f.rpc("getProjectBaseline", { projectId: id }, credential)).status,
  ).toBe(404);
  await expect(
    f.backend.services.storage.ingest(user, id, crypto.randomUUID(), data),
  ).rejects.toMatchObject({ code: "project_not_found" });
});
