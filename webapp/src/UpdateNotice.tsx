import { makeEventListener } from "@solid-primitives/event-listener";
import { createMutation, createQuery } from "@tanstack/solid-query";
import { createEffect, For, Match, Show, Switch } from "solid-js";
import {
  type Confirmation,
  applyUpdate,
  follow,
  otherWindows,
  pendingUpdate,
  reloadAnyway,
  strandedRisks,
} from "./offline-shell";
import { press } from "./press";

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

// A newer build waits until the person updates. This stays on screen until
// then, says which other open tabs update along with this one, and warns
// before any of them would lose work.
export function UpdateNotice(props: { inline?: boolean }) {
  const ids = new WeakMap<ServiceWorker, number>();
  let count = 0;
  const windowsKey = () => {
    const worker = pendingUpdate();
    if (worker && !ids.has(worker)) ids.set(worker, ++count);
    return ["offline-shell", "other-windows", worker && ids.get(worker)];
  };
  const windows = createQuery(() => {
    const worker = pendingUpdate();
    return {
      queryKey: windowsKey(),
      queryFn: () => (worker ? otherWindows(worker) : 0),
      enabled: !!worker,
      // Tabs open and close elsewhere, so look again while visible and as
      // soon as this window regains focus.
      refetchInterval: 3000,
      refetchOnWindowFocus: "always" as const,
      retry: false,
    };
  });
  const update = createMutation(() => ({
    mutationKey: ["offline-shell", "apply-update"],
    mutationFn: (confirmed?: Confirmation) => applyUpdate(confirmed),
  }));
  const recheck = createMutation(() => ({
    mutationKey: ["offline-shell", "follow-update"],
    mutationFn: follow,
  }));
  const others = () => windows.data ?? 0;
  const busy = () => update.isPending || update.data?.status === "reloading";
  // While saving and reloading, no input may reach the map: an edit made now
  // could miss the save that the update waits for.
  createEffect(() => {
    if (!busy()) return;
    for (const type of ["keydown", "keypress", "beforeinput", "paste"])
      makeEventListener(
        window,
        type,
        (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
        },
        { capture: true },
      );
  });
  const risks = () =>
    update.data?.status === "unsafe" ? update.data.risks : undefined;

  return (
    // Activation clears pendingUpdate just before the reload; stay until then.
    <Show when={pendingUpdate() || busy() || strandedRisks()}>
      <Show when={busy()}>
        <div class="fixed inset-0 z-[60] cursor-progress bg-white/40" />
      </Show>
      <section
        aria-label="Update"
        data-no-pan
        data-toolbar
        // Floats over the map, top centre, clear of the phone menu button.
        class={
          props.inline
            ? "update-notice relative my-4 max-w-lg"
            : "update-notice fixed top-3 right-3 left-[4.5rem] z-30 sm:left-1/2 sm:right-auto sm:z-40 sm:w-max sm:max-w-[min(30rem,calc(100%-1.5rem))] sm:-translate-x-1/2"
        }
        classList={{
          "z-[61]!": busy(),
          warning: !!risks() || !!strandedRisks(),
        }}
      >
        <Switch
          fallback={
            <div class="flex items-center gap-3">
              <span aria-hidden="true" class="update-dot" />
              <p role="status" class="min-w-0 flex-1 text-[0.8125rem]">
                <span class="font-semibold">
                  A new version of Mindgrab is ready.
                </span>
                <Show when={others()}>
                  {(count) => (
                    <>
                      {" "}
                      Updating also reloads your other{" "}
                      {count() === 1
                        ? "Mindgrab tab"
                        : plural(count(), "Mindgrab tab")}
                      .
                    </>
                  )}
                </Show>
              </p>
              <button
                type="button"
                class="primary-button compact shrink-0"
                {...press(() => update.mutate(undefined))}
              >
                Update now
              </button>
            </div>
          }
        >
          <Match when={strandedRisks()}>
            {(list) => (
              <div role="alert" class="text-[0.8125rem]">
                <p class="font-semibold">Mindgrab was updated in another tab</p>
                <p class="mt-1 text-stone-700">
                  This tab stays open because reloading it would lose work:
                </p>
                <ul class="mt-1 list-disc pl-5 text-stone-700">
                  <For each={list()}>{(risk) => <li>{risk}</li>}</For>
                </ul>
                <p class="mt-1 text-stone-700">
                  Export your maps or wait until they are saved, then reload.
                </p>
                <div class="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    class="map-control outlined"
                    disabled={recheck.isPending}
                    {...press(() => recheck.mutate())}
                  >
                    Check again
                  </button>
                  <button
                    type="button"
                    class="primary-button compact danger"
                    {...press(reloadAnyway)}
                  >
                    Reload and lose it
                  </button>
                </div>
              </div>
            )}
          </Match>
          <Match when={busy()}>
            <div class="flex items-center gap-3">
              <span aria-hidden="true" class="update-dot pulsing" />
              <p role="status" class="min-w-0 flex-1 text-[0.8125rem]">
                Saving your work and updating…
              </p>
              <Show when={update.data?.status === "reloading"}>
                <button
                  type="button"
                  class="primary-button compact shrink-0"
                  {...press(() => window.location.reload())}
                >
                  Reload
                </button>
              </Show>
            </div>
          </Match>
          <Match when={risks()}>
            {(list) => (
              <div role="alert" class="text-[0.8125rem]">
                <p class="font-semibold">Updating now would lose work</p>
                <ul class="mt-1 list-disc pl-5 text-stone-700">
                  <For each={list()}>{(risk) => <li>{risk}</li>}</For>
                </ul>
                <p class="mt-1 text-stone-700">
                  Export your maps or wait until they are saved, then update.
                </p>
                <div class="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    class="map-control outlined"
                    {...press(() => update.reset())}
                  >
                    Not now
                  </button>
                  <button
                    type="button"
                    class="primary-button compact danger"
                    {...press(
                      () =>
                        update.data?.status === "unsafe" &&
                        update.mutate(update.data.confirmation),
                    )}
                  >
                    Update and lose it
                  </button>
                </div>
              </div>
            )}
          </Match>
          <Match when={update.isError}>
            <div class="flex items-center gap-3">
              <span aria-hidden="true" class="update-dot" />
              <p role="alert" class="min-w-0 flex-1 text-[0.8125rem]">
                <span class="font-semibold">
                  A new version of Mindgrab is ready.
                </span>{" "}
                The update could not start. Try again, or close every Mindgrab
                tab and open Mindgrab again.
              </p>
              <button
                type="button"
                class="map-control outlined shrink-0"
                {...press(() => update.reset())}
              >
                Try again
              </button>
            </div>
          </Match>
        </Switch>
      </section>
    </Show>
  );
}
