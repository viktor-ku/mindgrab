import { For, Show } from "solid-js";
import { Dialog } from "./Dialog";
import type { SavingPreferences } from "./project-document";
import type { CloudStatus } from "./project-sync";
import { press } from "./press";

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
  // Starts sign-in; absent while signed in or while the account is checked.
  onSignIn?: () => void;
  onReviewAnalytics?: () => void;
}) {
  let firstSwitch: HTMLButtonElement | undefined;
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="Project preferences"
      closeLabel="Close project preferences"
      variant="side"
    >
      <p class="my-6 text-sm leading-6 text-stone-600">
        Choose where this map is saved. Turning a switch off deletes its
        existing copy from that location. Your open map stays available in this
        tab.
      </p>
      <div class="flex flex-col gap-6">
        <For
          each={[
            {
              key: "local" as const,
              label: "Save locally",
              description: "Keep a copy in this browser.",
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
                ref={(el) => {
                  if (option.key === "local") firstSwitch = el;
                }}
                type="button"
                role="switch"
                aria-checked={props.saving[option.key]}
                aria-labelledby={`saving-${option.key}`}
                aria-describedby={`saving-${option.key}-description`}
                class="saving-switch"
                aria-disabled={props.busy}
                data-busy={props.busy ? "" : undefined}
                {...press(() => {
                  if (props.busy) return;
                  props.onChange({
                    ...props.saving,
                    [option.key]: !props.saving[option.key],
                  });
                })}
              >
                <span>{props.saving[option.key] ? "On" : "Off"}</span>
              </button>
            </div>
          )}
        </For>
      </div>
      <Show when={!props.signedIn && props.saving.cloud}>
        <p class="mt-5 text-sm text-stone-600">
          Sign in to save in Mindgrab Cloud.
        </p>
        <Show when={props.onSignIn}>
          <button
            type="button"
            class="map-control outlined mt-2"
            {...press(() => props.onSignIn?.())}
          >
            Sign in
          </button>
        </Show>
      </Show>
      {/* Without an account cloud saving cannot run, so local off means memory only. */}
      <Show
        when={!props.saving.local && (!props.saving.cloud || !props.signedIn)}
      >
        <div class="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
          <p class="font-semibold">This map lives only in memory.</p>
          <p>
            Export a backup before closing or reloading this tab. Import it when
            you want to continue working.
          </p>
          <button
            type="button"
            class="map-control outlined mt-2"
            {...press(props.onExport)}
          >
            Export backup
          </button>
        </div>
      </Show>
      <Show when={!props.saving.local && props.saving.cloud && props.signedIn}>
        <p class="mt-8 text-sm leading-6 text-stone-600">
          Wait for the green save dot before leaving, or export a backup. This
          browser will not keep a copy.
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
          class="map-control outlined mt-2"
          disabled={props.busy}
          {...press(() => {
            props.onChange(props.saving);
            // This button disables itself and then goes away.
            firstSwitch?.focus();
          })}
        >
          Retry
        </button>
      </Show>
      <Show when={props.onReviewAnalytics}>
        <button
          type="button"
          class="map-control outlined mt-6"
          {...press(() => props.onReviewAnalytics?.())}
        >
          Analytics choice…
        </button>
      </Show>
    </Dialog>
  );
}
