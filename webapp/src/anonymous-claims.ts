import * as Y from "yjs";
import { CrdtApi, SyncError } from "./crdt-api";
import { ORIGIN } from "./project-document";
import { accountNamespace, ANONYMOUS_NAMESPACE } from "./project-repository";
import type { ProjectRepository } from "./project-repository";

export async function claimCandidates(
  source: ProjectRepository,
  ownerId: number,
) {
  return (await source.list({ includeClaims: true })).filter(
    (entry) =>
      !entry.claim ||
      (entry.claim.ownerId === ownerId && entry.claim.phase === "pending"),
  );
}

// The source marker commits before copying or registration. Targets remain
// hidden from cloud/background workers until their local copy and registration
// have committed. Every retry merges the exact Yjs bytes, including causal gaps.
export async function claimAnonymousProjects(
  source: ProjectRepository,
  destination: ProjectRepository,
  ownerId: number,
  signal: AbortSignal,
  api = new CrdtApi(undefined, undefined, ownerId),
) {
  if (
    source.scope.namespace !== ANONYMOUS_NAMESPACE ||
    destination.scope.namespace !== accountNamespace(ownerId) ||
    source.scope.deployment !== destination.scope.deployment
  )
    throw new Error("Invalid anonymous project destination.");
  const claimed: string[] = [];
  for (const entry of await claimCandidates(source, ownerId)) {
    signal.throwIfAborted();
    const copy = async () => {
      signal.throwIfAborted();
      let marker = await source.beginClaim(entry.id, ownerId);
      if (!marker || marker.ownerId !== ownerId || marker.phase === "complete")
        return;
      const original = await source.open(entry.id, { remember: false });
      try {
        await original.flush();
        signal.throwIfAborted();
        for (let attempt = 0; attempt < 5; attempt++) {
          signal.throwIfAborted();
          const targetId = marker.targetId;
          // Recover an orphaned document before deciding this UUID is free.
          await destination.list({ includeClaims: true });
          signal.throwIfAborted();
          if (
            !(await destination.reserveClaim(
              targetId,
              entry.name,
              `${source.names.catalog}/${entry.id}`,
            ))
          ) {
            marker = await source.rerouteClaim(entry.id, ownerId, targetId);
            if (!marker || marker.ownerId !== ownerId) return;
            continue;
          }
          const target = await destination.open(targetId, { remember: false });
          try {
            signal.throwIfAborted();
            Y.applyUpdate(
              target.doc,
              Y.encodeStateAsUpdate(original.doc),
              ORIGIN.import,
            );
            await target.flush();
            signal.throwIfAborted();
            await target.refreshMetadata();
            const view = await source.preference(`project/${entry.id}/view`);
            signal.throwIfAborted();
            if (view !== undefined)
              await destination.setPreference(`project/${targetId}/view`, view);
            signal.throwIfAborted();
            try {
              await api.register(targetId, signal);
            } catch (error) {
              signal.throwIfAborted();
              if (
                error instanceof SyncError &&
                error.code === "project_id_conflict"
              ) {
                marker = await source.rerouteClaim(entry.id, ownerId, targetId);
                if (!marker || marker.ownerId !== ownerId) return;
                continue;
              }
              throw error;
            }
            signal.throwIfAborted();
            await destination.markRegistered(targetId);
            signal.throwIfAborted();
            await destination.releaseClaim(targetId);
            signal.throwIfAborted();
            await source.completeClaim(entry.id, ownerId, targetId);
            claimed.push(targetId);
            return;
          } finally {
            await target.close();
          }
        }
        throw new Error(
          "Could not assign a project ID. Your local work is retained; retry adding it.",
        );
      } finally {
        await original.close();
      }
    };
    if (globalThis.navigator?.locks)
      await navigator.locks.request(
        `${source.names.catalog}/claim/${entry.id}`,
        { signal },
        copy,
      );
    else await copy();
  }
  return claimed;
}
