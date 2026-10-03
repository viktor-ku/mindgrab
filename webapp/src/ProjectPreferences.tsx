import { createEffect, For, Show } from "solid-js";
import type { SavingPreferences } from "./project-document";
import type { CloudStatus } from "./project-sync";

export function ProjectPreferences(props: {
  open: boolean;
  onClose: () => void;
  saving: SavingPreferences;
  onChange: (value: SavingPreferences) => void;
  busy: boolean;
  error: string;
  cloudStatus?: CloudStatus;
  signedIn: boolean;
  onExport: () => void;
}) {
  let dialog!: HTMLDialogElement;
  createEffect(() => {
    if (props.open && !dialog.open) dialog.showModal();
    else if (!props.open && dialog.open) dialog.close();
  });
  return (
    <dialog
      ref={dialog}
      class="project-preferences"
      aria-labelledby="project-preferences-title"
      data-no-pan
      onClose={props.onClose}
      onCancel={props.onClose}
    >
      <header class="flex items-center justify-between gap-4 border-b border-stone-200 pb-5">
        <h2 id="project-preferences-title" class="text-xl font-semibold">
          Project preferences
        </h2>
        <button
          type="button"
          class="map-control"
          aria-label="Close project preferences"
          onClick={props.onClose}
        >
          ✕
        </button>
      </header>
      <p class="my-6 text-sm leading-6 text-stone-600">
        Choose where this project is saved. Turning a switch to NO deletes its
        existing copy from that location. Your open project stays available in
        this tab.
      </p>
      <div class="flex flex-col gap-6">
        <For
          each={[
            {
              key: "local" as const,
              label: "Save locally",
              description: "Keep a copy in this browser for offline use.",
            },
            {
              key: "cloud" as const,
              label: "Save in Mindgrab Cloud",
              description:
                "Keep a copy in your account and sync across devices.",
            },
          ]}
        >
          {(option) => (
            <div class="flex items-start justify-between gap-5">
              <div>
                <p id={`saving-${option.key}`} class="font-medium">
                  {option.label}
                </p>
                <p
                  id={`saving-${option.key}-description`}
                  class="mt-1 text-sm leading-5 text-stone-500"
                >
                  {option.description}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={props.saving[option.key]}
                aria-labelledby={`saving-${option.key}`}
                aria-describedby={`saving-${option.key}-description`}
                class="saving-switch"
                disabled={props.busy}
                onClick={() =>
                  props.onChange({
                    ...props.saving,
                    [option.key]: !props.saving[option.key],
                  })
                }
              >
                {props.saving[option.key] ? "YES" : "NO"}
              </button>
            </div>
          )}
        </For>
      </div>
      <Show when={!props.signedIn && props.saving.cloud}>
        <p class="mt-5 text-sm text-stone-600">
          Sign in to save in Mindgrab Cloud.
        </p>
      </Show>
      <Show when={!props.saving.local && !props.saving.cloud}>
        <div class="mt-8 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
          <p class="font-semibold">This project lives only in memory.</p>
          <p>
            Export a file before closing or reloading this tab. Import it when
            you want to continue working.
          </p>
          <button
            type="button"
            class="map-control mt-2 bg-white"
            onClick={props.onExport}
          >
            Export project
          </button>
        </div>
      </Show>
      <Show when={!props.saving.local && props.saving.cloud}>
        <p class="mt-8 text-sm leading-6 text-stone-600">
          Wait for “Saved to cloud” before leaving, or export a copy. This
          browser will not keep an offline copy.
        </p>
      </Show>
      <p role="status" class="mt-6 text-sm text-stone-600">
        {props.busy
          ? "Updating storage…"
          : props.cloudStatus?.status === "deleting"
            ? "Deleting the existing cloud copy…"
            : ""}
      </p>
      <Show
        when={
          !props.saving.cloud &&
          props.cloudStatus &&
          "message" in props.cloudStatus
        }
      >
        <p role="alert" class="mt-3 text-sm text-amber-900">
          Cloud deletion has not been confirmed.{" "}
          {props.cloudStatus && "message" in props.cloudStatus
            ? props.cloudStatus.message
            : ""}
        </p>
      </Show>
      <Show when={props.error}>
        <p role="alert" class="mt-3 text-sm text-red-700">
          {props.error}
        </p>
        <button
          type="button"
          class="map-control mt-2"
          disabled={props.busy}
          onClick={() => props.onChange(props.saving)}
        >
          Retry storage change
        </button>
      </Show>
    </dialog>
  );
}
