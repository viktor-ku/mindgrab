import { z } from "zod";
import { backendEndpoint } from "./backend";

// Anyone holding a project's share link may view it. These requests carry no
// session or account, so viewing never touches the viewer's own projects.

const shared = z.object({
  projectId: z.string().uuid(),
  name: z.string().nullable(),
  revision: z.string().regex(/^(0|[1-9][0-9]*)$/),
  encoding: z.literal("loro-snapshot"),
  data: z.string(),
});
export type SharedSnapshot = z.infer<typeof shared>;

export class SharedProjectError extends Error {
  readonly kind: "missing" | "retry";
  constructor(kind: "missing" | "retry") {
    super(
      kind === "missing"
        ? "This link is no longer shared."
        : "Could not load the shared project.",
    );
    this.name = "SharedProjectError";
    this.kind = kind;
  }
}

export function shareUrl(token: string) {
  return new URL(`/s/${token}`, window.location.origin).toString();
}

export async function fetchSharedProject(token: string, signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(backendEndpoint("/api/getSharedProject"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      credentials: "omit",
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SharedProjectError("retry");
  }
  if (response.status === 404 || response.status === 400)
    throw new SharedProjectError("missing");
  if (!response.ok) throw new SharedProjectError("retry");
  return shared.parse(await response.json());
}

// Revision notifications; the socket closes once the link is revoked.
export function sharedProjectSocket(token: string) {
  const url = new URL(backendEndpoint(`/sync/share/${token}`));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url);
}
