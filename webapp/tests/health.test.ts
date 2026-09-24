import { expect, test } from "bun:test";
import {
  checkHealth,
  formatLatency,
  overallStatus,
  serverTimingMs,
} from "../src/health";

function deps(respond: () => Promise<Response>) {
  const times = [100, 142.4];
  return {
    fetch: respond as unknown as typeof fetch,
    now: () => times.shift() ?? 0,
    clock: () => 1_700_000_000_000,
  };
}

const json = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status });

test("reports server round trip and database latency when healthy", async () => {
  const report = await checkHealth(
    deps(
      json(200, {
        status: "ok",
        database: { status: "up", latency_ms: 1.3 },
      }),
    ),
  );
  expect(report.server.state).toBe("up");
  expect(report.server.latencyMs).toBeCloseTo(42.4);
  expect(report.database).toEqual({ state: "up", latencyMs: 1.3 });
  expect(report.checkedAt).toBe(1_700_000_000_000);
  expect(overallStatus(report)).toBe("operational");
});

test("keeps the server up when only the database is down", async () => {
  const report = await checkHealth(
    deps(
      json(503, {
        status: "degraded",
        database: { status: "down", latency_ms: null },
      }),
    ),
  );
  expect(report.server.state).toBe("up");
  expect(report.database).toEqual({ state: "down" });
  expect(overallStatus(report)).toBe("degraded");
});

test("treats network errors, proxy errors, and unexpected bodies as unreachable", async () => {
  for (const respond of [
    async () => {
      throw new TypeError("Failed to fetch");
    },
    json(502, { database: { status: "up" } }),
    async () =>
      new Response("<html>Service Unavailable</html>", { status: 503 }),
    json(200, { status: "ok" }),
  ]) {
    const report = await checkHealth(deps(respond));
    expect(report.server).toEqual({ state: "down" });
    expect(report.database).toEqual({ state: "unknown" });
    expect(overallStatus(report)).toBe("outage");
  }
});

test("excludes the server's database check from the API round trip", async () => {
  const report = await checkHealth(
    deps(
      async () =>
        new Response(
          JSON.stringify({
            status: "degraded",
            database: { status: "down", latency_ms: null },
          }),
          { status: 503, headers: { "server-timing": "db;dur=40.4" } },
        ),
    ),
  );
  expect(report.server.latencyMs).toBeCloseTo(2);
});

test("reads durations from Server-Timing headers", () => {
  expect(serverTimingMs("cache;dur=3, db;desc=x;dur=12.5", "db")).toBe(12.5);
  expect(serverTimingMs("db", "db")).toBe(0);
  expect(serverTimingMs("db;dur=oops", "db")).toBe(0);
  expect(serverTimingMs(null, "db")).toBe(0);
});

test("formats latency for display", () => {
  expect(formatLatency(undefined)).toBe("—");
  expect(formatLatency(0.4)).toBe("<1 ms");
  expect(formatLatency(12.6)).toBe("13 ms");
});
