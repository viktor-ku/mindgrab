import { expect, test } from "bun:test";
import { LoroApi, SyncError } from "../src/loro-api";

const id = "10000000-0000-4000-8000-000000000000";
const refusing =
  (status: number, code: string): typeof fetch =>
  async () =>
    new Response(JSON.stringify({ error: { code } }), { status });
const saveWith = (fetcher: typeof fetch) =>
  new LoroApi((path) => `https://api.test${path}`, fetcher, 1)
    .merge(id, new Uint8Array([1]), new AbortController().signal)
    .then(
      () => undefined,
      (error: unknown) => error,
    );

test("a full account stops cloud saving and says how to make room", async () => {
  const error = await saveWith(refusing(422, "quota_exceeded"));
  expect(error).toBeInstanceOf(SyncError);
  expect(error).toMatchObject({ kind: "blocked", code: "quota_exceeded" });
  expect((error as SyncError).message).toContain("cloud storage");
  expect((error as SyncError).message).toContain("to make room");
});

test("an account out of map IDs does not suggest deleting maps", async () => {
  const error = await saveWith(refusing(422, "id_quota_exceeded"));
  expect(error).toMatchObject({ kind: "blocked", code: "id_quota_exceeded" });
  expect((error as SyncError).message).toContain("saved only in this browser");
  expect((error as SyncError).message).not.toContain("Delete");
});

test("a map too large for the cloud says so", async () => {
  for (const [status, code] of [
    [413, "payload_too_large"],
    [422, "resource_limit"],
  ] as const) {
    const error = await saveWith(refusing(status, code));
    expect(error).toMatchObject({
      kind: "blocked",
      code,
      message: "This map is too large to save to the cloud.",
    });
  }
});
