import { LoroApi, SyncError } from "./loro-api";
import {
  isPristineSeed,
  ORIGIN,
  projectForest,
  readProject,
  savingPreferences,
} from "./project-document";
import { accountNamespace, ANONYMOUS_NAMESPACE } from "./project-repository";
import type {
  CatalogEntry,
  ProjectHandle,
  ProjectRepository,
} from "./project-repository";

// The map the user is looking at. The caller decides whether it migrates
// (a pristine seed is skipped while the account may already have maps); a
// complete marker keeps it listed until that tab has swapped to the copy.
export interface OpenCandidate {
  id: string;
  include: boolean;
}

export interface OpenClaim extends OpenCandidate {
  // Awaited after the copy is released and before the source marker completes,
  // inside the per-project lock, so the tab can swap to the copy without ever
  // stranding edits: a throw leaves the marker pending and the next run
  // re-copies the whole snapshot.
  beforeComplete: (sourceId: string, targetId: string) => Promise<void>;
}

// A map that cannot be read is not known to be empty, so it stays a candidate.
async function pristine(source: ProjectRepository, id: string) {
  try {
    const handle = await source.open(id, { remember: false });
    try {
      const state = readProject(handle.doc);
      return (
        state.status === "ready" &&
        isPristineSeed(projectForest(state.view), state.view.name)
      );
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

// Whether the migration still has something to copy for this entry.
export const waitingToCopy = (entry: CatalogEntry) =>
  !entry.claim || entry.claim.phase === "pending" || !!entry.claim.stale;

// Memory-only maps are left alone. Pending markers of any owner are intent
// and can be re-bound; complete markers of other owners are never touched,
// and an owner's own come back only for the open map or for edits made after
// the copy. Untouched seeds other than the open map are never worth copying.
export async function claimCandidates(
  source: ProjectRepository,
  ownerId: number,
  { open }: { open?: OpenCandidate } = {},
) {
  const candidates: CatalogEntry[] = [];
  for (const entry of await source.list({ includeClaims: true })) {
    if (entry.saving?.local === false) continue;
    if (entry.claim?.phase === "complete") {
      if (
        entry.claim.ownerId === ownerId &&
        (entry.id === open?.id || entry.claim.stale)
      )
        candidates.push(entry);
      continue;
    }
    if (entry.id === open?.id) {
      if (open.include) candidates.push(entry);
      continue;
    }
    if (!entry.claim && (await pristine(source, entry.id))) continue;
    candidates.push(entry);
  }
  return candidates;
}

// A tab killed right after a keystroke saves the edit but never flags it.
// Opening a copied source re-checks its version against the marker, so one
// pass per page load finds those; the flagged maps then copy as usual.
export async function flagLateEdits(
  source: ProjectRepository,
  ownerId: number,
) {
  for (const entry of await source.list({ includeClaims: true })) {
    const { claim } = entry;
    if (claim?.phase !== "complete" || claim.ownerId !== ownerId) continue;
    if (claim.stale) continue;
    try {
      const handle = await source.open(entry.id, { remember: false });
      try {
        await handle.refreshMetadata();
      } finally {
        await handle.close();
      }
    } catch {
      // An unreadable source has no edits to find.
    }
  }
  return true;
}

const CONFLICT_ATTEMPTS = 5;

// The source marker commits before copying or registration. Targets remain
// hidden from cloud/background workers until their local copy and registration
// have committed. Every retry merges the exact Loro snapshot history.
export async function claimAnonymousProjects(
  source: ProjectRepository,
  destination: ProjectRepository,
  ownerId: number,
  signal: AbortSignal,
  api = new LoroApi(undefined, undefined, ownerId),
  { open }: { open?: OpenClaim } = {},
) {
  if (
    source.scope.namespace !== ANONYMOUS_NAMESPACE ||
    destination.scope.namespace !== accountNamespace(ownerId) ||
    source.scope.deployment !== destination.scope.deployment
  )
    throw new Error("Invalid anonymous project destination.");
  const claimed: string[] = [];
  // Picks up anything typed since the last copy and records what the copy now
  // holds. An edit racing this is flagged stale by the final metadata refresh.
  const seal = async (
    original: ProjectHandle,
    target: ProjectHandle,
    targetId: string,
  ) => {
    const version = original.doc.version();
    target.doc.merge(original.doc.snapshot(), ORIGIN.import);
    await target.flush();
    await source.completeClaim(original.id, ownerId, targetId, version);
    await original.refreshMetadata();
  };
  const copyLateEdits = async (id: string, targetId: string) => {
    const original = await source.open(id, { remember: false });
    try {
      signal.throwIfAborted();
      const target = await destination.open(targetId, { remember: false });
      try {
        await seal(original, target, targetId);
      } finally {
        await target.close();
      }
    } finally {
      await original.close();
    }
  };
  const copy = async (entry: CatalogEntry) => {
    signal.throwIfAborted();
    let marker = await source.beginClaim(entry.id, ownerId);
    if (!marker) return;
    if (marker.phase === "complete") {
      if (marker.ownerId !== ownerId) return;
      // Late edits reach the copy first: the swap below may wait a long time
      // for a pause in typing.
      if (marker.stale) await copyLateEdits(entry.id, marker.targetId);
      // Another tab finished this map; this tab still has to swap to the copy.
      if (entry.id === open?.id)
        await open.beforeComplete(entry.id, marker.targetId);
      return;
    }
    if (marker.ownerId !== ownerId) {
      marker = await source.rebindClaim(entry.id, ownerId);
      if (!marker || marker.ownerId !== ownerId) return;
    }
    const original = await source.open(entry.id, { remember: false });
    try {
      await original.flush();
      signal.throwIfAborted();
      for (let attempt = 0; attempt < CONFLICT_ATTEMPTS; attempt++) {
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
          target.doc.merge(original.doc.snapshot(), ORIGIN.import);
          await target.flush();
          signal.throwIfAborted();
          await target.refreshMetadata();
          const view = await source.preference(`project/${entry.id}/view`);
          signal.throwIfAborted();
          if (view !== undefined)
            await destination.setPreference(`project/${targetId}/view`, view);
          signal.throwIfAborted();
          // A cloud-off map migrates locally only: the copied snapshot keeps
          // cloud saving off, so sync never uploads it. A cloud-on map is
          // registered before release, so a UUID owned elsewhere is rerouted
          // before the copy can appear in Load.
          if (
            savingPreferences(original.doc).cloud &&
            savingPreferences(target.doc).cloud
          ) {
            try {
              await destination.markCloudAttempted(targetId);
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
          }
          signal.throwIfAborted();
          await destination.releaseClaim(targetId);
          if (entry.id === open?.id)
            await open.beforeComplete(entry.id, targetId);
          await seal(original, target, targetId);
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
  const claim = (entry: CatalogEntry) =>
    globalThis.navigator?.locks
      ? navigator.locks.request(
          `${source.names.catalog}/claim/${entry.id}`,
          { signal },
          () => copy(entry),
        )
      : copy(entry);
  const candidates = await claimCandidates(source, ownerId, { open });
  const active = candidates.find((entry) => entry.id === open?.id);
  // One map that cannot be copied must not hold back the rest. The failure
  // still surfaces after them, so the run is retried.
  const failures: unknown[] = [];
  // The open map's claim waits for the user to pause typing, so it runs
  // beside the others instead of delaying them.
  const results = await Promise.allSettled([
    active ? claim(active) : undefined,
    (async () => {
      for (const entry of candidates) {
        if (entry === active) continue;
        signal.throwIfAborted();
        await claim(entry).catch((error: unknown) => {
          if (
            signal.aborted ||
            (error instanceof SyncError && error.kind === "auth")
          )
            throw error;
          failures.push(error);
        });
      }
    })(),
  ]);
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
  if (failures.length) throw failures[0];
  return claimed;
}
