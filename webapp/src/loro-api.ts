import type { QueryClient } from "@tanstack/solid-query";
import {
  createQueryClient,
  executeMutation,
  fetchScopedQuery,
} from "./query-client";
import { z } from "zod";
import { backendEndpoint } from "./backend";
import { parsePreferenceRow } from "./preferences";
import type { PreferenceChanges } from "./preferences";

const sequence = z.string().regex(/^(0|[1-9][0-9]*)$/);
const projectId = z.string().uuid();
const record = z.object({
  projectId,
  schemaVersion: z.literal(1),
  format: z.literal("mindgrab-loro-v1"),
  name: z.string().nullable(),
  // Listed projects report their last committed change; registration does not.
  updatedAt: z.string().optional(),
  // Listed projects name the cloud copy's revision; an earlier API does not.
  revision: sequence.optional(),
});
// What a read or a save answers. A "loro-snapshot" carries the complete
// document, or nothing while the cloud has none. A "loro-update" carries only
// changes: with a `head`, those the cloud copy has beyond what the request
// named; without one, the copy has not moved since the revision named.
const snapshot = z.object({
  projectId,
  revision: sequence,
  encoding: z.enum(["loro-snapshot", "loro-update"]),
  data: z.string(),
  // Names the cloud copy's version, as `ProjectDocument.head` does.
  head: z.string().max(4096).optional(),
  durable: z.literal(true),
});
// Asks a save to answer with the cloud copy's head, not the complete document.
const RECEIPT = "application/vnd.mindgrab.receipt+json";
const shareLink = z.object({ projectId, token: z.string().nullable() });
export type CloudProject = z.infer<typeof record>;
export type CloudSnapshot = z.infer<typeof snapshot>;

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

// Cookie credentials and ownership are outside the Loro document. One client per scope.
export class LoroApi {
  readonly endpoint: typeof backendEndpoint;
  readonly fetcher: typeof fetch;
  readonly ownerId?: number;
  readonly queryClient: QueryClient;
  readonly #lifetimes = new WeakMap<AbortSignal, string>();
  constructor(
    endpoint = backendEndpoint,
    fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    ownerId?: number,
    queryClient = createQueryClient(),
  ) {
    this.endpoint = endpoint;
    this.fetcher = fetcher;
    this.ownerId = ownerId;
    this.queryClient = queryClient;
  }

  #key(signal: AbortSignal, operation: string, id?: string) {
    let lifetime = this.#lifetimes.get(signal);
    if (!lifetime) {
      lifetime = crypto.randomUUID();
      this.#lifetimes.set(signal, lifetime);
    }
    return [
      "cloud",
      this.endpoint("/"),
      this.ownerId ?? null,
      lifetime,
      operation,
      id ?? null,
    ] as const;
  }

  #read<T>(
    operation: string,
    signal: AbortSignal,
    read: (signal: AbortSignal) => Promise<T>,
    id?: string,
  ) {
    return fetchScopedQuery(
      this.queryClient,
      this.#key(signal, operation, id),
      signal,
      read,
    );
  }

  register(id: string, signal: AbortSignal) {
    return executeMutation(
      this.queryClient,
      {
        mutationKey: this.#key(signal, "register", id),
        mutationFn: () => this.#register(id, signal),
      },
      undefined,
    );
  }

  async remove(id: string, signal: AbortSignal) {
    await this.#json("deleteProject.php", { projectId: id }, signal);
  }

  list(signal: AbortSignal) {
    return this.#read("catalog", signal, (signal) => this.#list(signal));
  }

  // One page of this account's projects, most recently changed first.
  recent(signal: AbortSignal) {
    return this.#read(
      "recent",
      signal,
      async (signal) =>
        z
          .object({ projects: z.array(record) })
          .parse(
            await this.#json(
              "listProjects.php",
              { limit: 20, recent: true },
              signal,
            ),
          ).projects,
    );
  }

  // What the cloud copy holds beyond `since`, a head this device holds ("" for
  // nothing), or word that it has not moved since `revision`.
  changes(
    id: string,
    held: { revision?: string; since: string },
    signal: AbortSignal,
  ): Promise<CloudSnapshot> {
    return this.#read(
      "changes",
      signal,
      async (signal) => {
        try {
          return await this.#readSnapshot({ projectId: id, ...held }, signal);
        } catch (error) {
          if (!(error instanceof SyncError) || error.code !== "invalid_request")
            throw error;
        }
        // An API from before these arguments refuses them, and answers the
        // plain request with the complete document.
        const { head: _, ...complete } = await this.#readSnapshot(
          { projectId: id },
          signal,
        );
        return complete;
      },
      id,
    );
  }

  // The complete cloud copy.
  async snapshot(id: string, signal: AbortSignal) {
    const reply = await this.changes(id, { since: "" }, signal);
    if (reply.encoding !== "loro-snapshot")
      throw new SyncError("Cloud saving is unavailable. Retrying…");
    return reply;
  }

  // The project's view-only link token, or null while the project is private.
  async shareLink(id: string, signal: AbortSignal) {
    return shareLink.parse(
      await this.#json("getShareLink.php", { projectId: id }, signal),
    ).token;
  }

  async setShareLink(id: string, enabled: boolean, signal: AbortSignal) {
    return shareLink.parse(
      await this.#json("setShareLink.php", { projectId: id, enabled }, signal),
    ).token;
  }

  // Every preference the account has set, each checked against its name.
  async preferences(signal: AbortSignal) {
    const { preferences } = z
      .object({ preferences: z.array(z.unknown()) })
      .parse(await this.#json("listPreferences.php", {}, signal));
    return preferences.flatMap((value) => {
      const row = parsePreferenceRow(value);
      return row ? [row] : [];
    });
  }

  async setPreferences(changes: PreferenceChanges, signal: AbortSignal) {
    await this.#json("setPreferences.php", changes, signal);
  }

  merge(id: string, bytes: Uint8Array, signal: AbortSignal) {
    return executeMutation(
      this.queryClient,
      {
        mutationKey: this.#key(signal, "merge", id),
        mutationFn: async () =>
          this.#parseSnapshot(
            id,
            await this.#request(
              `mergeProject.php?${new URLSearchParams({ projectId: id })}`,
              signal,
              {
                headers: {
                  "Content-Type": "application/octet-stream",
                  Accept: RECEIPT,
                },
                body: bytes.slice().buffer,
              },
            ),
          ),
      },
      undefined,
    );
  }

  #parseSnapshot(id: string, value: unknown) {
    const result = snapshot.parse(value);
    if (result.projectId !== id)
      throw new SyncError("Unexpected project snapshot.", "blocked");
    return result;
  }

  async #request(path: string, signal: AbortSignal, init?: RequestInit) {
    signal.throwIfAborted();
    const headers = new Headers(init?.headers);
    if (this.ownerId) headers.set("X-Mindgrab-Account", String(this.ownerId));
    const response = await this.fetcher(this.endpoint(`/api/${path}`), {
      ...init,
      method: "POST",
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
      // The cloud reads where a map is kept from the account's preferences;
      // one just turned on here may not have reached it yet.
      if (code === "cloud_disabled")
        throw new SyncError("Cloud saving is unavailable. Retrying…");
      if ([400, 403, 404, 409, 413, 422].includes(response.status))
        throw new SyncError(
          response.status === 413
            ? "Cloud storage reached its limit. Your local work is retained."
            : "Cloud saving needs attention. Your local work is retained.",
          "blocked",
          code,
        );
      throw new SyncError("Cloud saving is unavailable. Retrying…");
    }
    return response.json();
  }

  #json(path: string, args: unknown, signal: AbortSignal) {
    return this.#request(path, signal, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
  }

  async #register(id: string, signal: AbortSignal) {
    const result = record.parse(
      await this.#json(
        "createProject.php",
        { projectId: id, schemaVersion: 1 },
        signal,
      ),
    );
    if (result.projectId !== id)
      throw new SyncError("Unexpected project registration.", "blocked");
    return result;
  }

  async #list(signal: AbortSignal) {
    const projects: CloudProject[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = z
        .object({
          projects: z.array(record),
          nextCursor: z.string().nullable(),
        })
        .parse(
          await this.#json(
            "listProjects.php",
            { limit: 100, ...(cursor ? { cursor } : {}) },
            signal,
          ),
        );
      projects.push(...page.projects);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor))
        throw new SyncError("Invalid catalog cursor.", "blocked");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return projects;
  }

  async #readSnapshot(
    args: { projectId: string; revision?: string; since?: string },
    signal: AbortSignal,
  ) {
    return this.#parseSnapshot(
      args.projectId,
      await this.#json("getProjectSnapshot.php", args, signal),
    );
  }
}
