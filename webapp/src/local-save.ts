import { createQuery } from "@tanstack/solid-query";
import type { Accessor } from "solid-js";
import { createEffect, createMemo, onCleanup } from "solid-js";
import type { ProjectHandle } from "./project-repository";
import { QUICK_RETRIES, saveRetryDelay } from "./query-client";

const FAILED_RETRY_INTERVAL_MS = 30_000;

// Browser saving as one query per open project. Each run settles every pending
// write and, after a failure, stores a full snapshot, so running it again is
// always safe. Query serializes runs and owns the retry policy: quick retries
// with backoff, then a slow poll and a retry on focus until a save succeeds.
export function createLocalSave(active: Accessor<ProjectHandle | undefined>) {
  const target = createMemo(() => {
    const handle = active();
    return handle && { handle, key: crypto.randomUUID() };
  });
  const query = createQuery(() => {
    const current = target();
    return {
      queryKey: ["local-save", current?.key],
      enabled: !!current,
      queryFn: async () => {
        await current?.handle.flush();
        return null;
      },
      retry: QUICK_RETRIES,
      retryDelay: saveRetryDelay,
      refetchInterval: (state) =>
        state.state.status === "error" ? FAILED_RETRY_INTERVAL_MS : false,
      refetchOnWindowFocus: (state) => state.state.status === "error",
      gcTime: 0,
    };
  });
  // A write that starts during a run joins it; the run waits for it to settle.
  const run = (throwOnError: boolean) =>
    query.refetch({ cancelRefetch: false, throwOnError });
  createEffect(() => {
    const handle = active();
    if (handle) onCleanup(handle.onDurability(() => void run(false)));
  });
  const failure = () => query.failureReason ?? query.error;
  return {
    status: () =>
      failure()
        ? ("error" as const)
        : query.isFetching
          ? ("saving" as const)
          : ("done" as const),
    message: () => failure()?.message ?? "",
    save: () => run(true),
    retry: () => run(false),
  };
}
