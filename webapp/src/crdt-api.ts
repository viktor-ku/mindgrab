import { z } from "zod";
import { backendEndpoint } from "./backend";

const sequence = z.string().regex(/^(0|[1-9][0-9]*)$/);
const validation = z.enum(["valid", "pending_dependencies", "quarantined"]);
const projectId = z.string().uuid();
const record = z.object({
  projectId,
  protocolVersion: z.literal(1),
  schemaVersion: z.literal(1),
  name: z.string().nullable(),
});
const baseline = z.object({
  schemaVersion: z.literal(1),
  lastSequence: sequence,
  validation,
  encoding: z.literal("yjs-v1"),
  data: z.string(),
  stateVector: z.string(),
});
const receipt = z.object({
  protocolVersion: z.literal(1),
  projectId,
  updateId: z.string().uuid(),
  sequence,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  durable: z.literal(true),
  validation,
});
export type CloudProject = z.infer<typeof record>;
export type Baseline = z.infer<typeof baseline>;
export type Receipt = z.infer<typeof receipt>;

export class SyncError extends Error {
  readonly kind: "retry" | "auth" | "blocked";
  readonly code?: string;
  constructor(
    message: string,
    kind: "retry" | "auth" | "blocked" = "retry",
    code?: string,
  ) {
    super(message);
    this.name = "SyncError";
    this.kind = kind;
    this.code = code;
  }
}

export function decodeBase64(data: string) {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}

export async function digest(bytes: Uint8Array) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes.slice().buffer),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// Cookie credentials and ownership are outside the Y.Doc. One client per scope.
export class CrdtApi {
  readonly endpoint: typeof backendEndpoint;
  readonly fetcher: typeof fetch;
  readonly ownerId?: number;
  constructor(
    endpoint = backendEndpoint,
    fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    ownerId?: number,
  ) {
    this.endpoint = endpoint;
    this.fetcher = fetcher;
    this.ownerId = ownerId;
  }

  async #request(path: string, signal: AbortSignal, init?: RequestInit) {
    signal.throwIfAborted();
    const headers = new Headers(init?.headers);
    if (this.ownerId) headers.set("X-Mindgrab-Account", String(this.ownerId));
    const response = await this.fetcher(this.endpoint(`/api/crdt/v1/${path}`), {
      ...init,
      headers,
      credentials: "include",
      cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    signal.throwIfAborted();
    if (!response.ok) {
      const error = await response.json().catch(() => undefined);
      const code = error?.error?.code;
      if (response.status === 401 || code === "account_changed")
        throw new SyncError(
          "Sign in again to resume cloud saving.",
          "auth",
          code,
        );
      if ([400, 403, 404, 409, 413, 422, 426].includes(response.status))
        throw new SyncError(
          response.status === 413
            ? "Cloud storage reached its limit. Your local work is retained."
            : response.status === 426
              ? "Reload with a compatible app to resume cloud saving."
              : "Cloud saving needs attention. Your local work is retained.",
          "blocked",
          code,
        );
      throw new SyncError("Cloud saving is unavailable. Retrying…");
    }
    return response.json();
  }

  async register(id: string, signal: AbortSignal) {
    const result = record.parse(
      await this.#request("projects", signal, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: id, schemaVersion: 1 }),
      }),
    );
    if (result.projectId !== id)
      throw new SyncError("Unexpected project registration.", "blocked");
    return result;
  }

  async list(signal: AbortSignal) {
    const projects: CloudProject[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const query = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const page = z
        .object({
          projects: z.array(record),
          nextCursor: z.string().nullable(),
        })
        .parse(await this.#request(`projects?limit=100${query}`, signal));
      projects.push(...page.projects);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor))
        throw new SyncError("Invalid catalog cursor.", "blocked");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return projects;
  }

  async baseline(id: string, signal: AbortSignal) {
    return baseline.parse(
      await this.#request(`projects/${id}/baseline`, signal),
    );
  }

  async status(id: string, signal: AbortSignal) {
    return z
      .object({
        schemaVersion: z.literal(1),
        lastSequence: sequence,
        validation,
      })
      .parse(await this.#request(`projects/${id}/status`, signal));
  }

  async submit(
    id: string,
    updateId: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ) {
    const sha256 = await digest(bytes);
    const result = receipt.parse(
      await this.#request(`projects/${id}/updates/${updateId}`, signal, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Mindgrab-Schema-Version": "1",
        },
        body: bytes.slice().buffer,
      }),
    );
    if (
      result.projectId !== id ||
      result.updateId !== updateId ||
      result.sha256 !== sha256
    )
      throw new SyncError(
        "Cloud receipt did not match the submitted change.",
        "blocked",
      );
    return result;
  }
}
