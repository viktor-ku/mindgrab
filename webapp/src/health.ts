import { backendEndpoint } from "./backend";

export type ComponentState = "up" | "down" | "unknown";

export type ComponentHealth = {
  state: ComponentState;
  latencyMs?: number;
};

export type HealthReport = {
  server: ComponentHealth;
  database: ComponentHealth;
  checkedAt: number;
};

export const HEALTH_TIMEOUT_MS = 5000;

type HealthDeps = {
  fetch: typeof fetch;
  now: () => number;
  clock: () => number;
};

const defaultDeps: HealthDeps = {
  fetch: (...args) => fetch(...args),
  now: () => performance.now(),
  clock: () => Date.now(),
};

function parseDatabase(body: unknown): ComponentHealth | undefined {
  if (typeof body !== "object" || body === null) return;
  const database = (body as { database?: unknown }).database;
  if (typeof database !== "object" || database === null) return;
  const { status, latency_ms } = database as {
    status?: unknown;
    latency_ms?: unknown;
  };
  if (status === "down") return { state: "down" };
  if (status !== "up") return;
  return typeof latency_ms === "number" && Number.isFinite(latency_ms)
    ? { state: "up", latencyMs: latency_ms }
    : { state: "up" };
}

export function serverTimingMs(header: string | null, name: string): number {
  for (const entry of header?.split(",") ?? []) {
    const [metric, ...params] = entry.split(";").map((part) => part.trim());
    if (metric !== name) continue;
    const duration = params.find((param) => param.startsWith("dur="));
    const value = Number(duration?.slice(4));
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  return 0;
}

export async function checkHealth(
  deps: HealthDeps = defaultDeps,
): Promise<HealthReport> {
  const started = deps.now();
  const unreachable = (): HealthReport => ({
    server: { state: "down" },
    database: { state: "unknown" },
    checkedAt: deps.clock(),
  });
  try {
    const response = await deps.fetch(backendEndpoint("/api/health"), {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const roundTrip = deps.now() - started;
    if (response.status !== 200 && response.status !== 503) {
      return unreachable();
    }
    const databaseCheck = serverTimingMs(
      response.headers.get("server-timing"),
      "db",
    );
    const latencyMs = Math.max(0, roundTrip - databaseCheck);
    const database = parseDatabase(await response.json());
    if (!database) return unreachable();
    return {
      server: { state: "up", latencyMs },
      database,
      checkedAt: deps.clock(),
    };
  } catch {
    return unreachable();
  }
}

export type Overall = "operational" | "degraded" | "outage";

export function overallStatus(report: HealthReport): Overall {
  if (report.server.state !== "up") return "outage";
  return report.database.state === "up" ? "operational" : "degraded";
}

export function formatLatency(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1) return "<1 ms";
  return `${Math.round(ms)} ms`;
}
