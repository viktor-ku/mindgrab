import { For, Show } from "solid-js";
import type { PreferenceTab } from "./app-search";
import { ColorSettings } from "./ColorSettings";
import { Dialog } from "./Dialog";
import { LockIcon } from "./icons";
import { press } from "./press";
import type { ColorPreferences, SavingPreferences } from "./project-document";
import type { CloudStatus } from "./project-sync";

export function ProjectPreferences(props: {
  open: boolean;
  onClose: () => void;
  // The section shown, from the address; saving when absent.
  section?: PreferenceTab;
  onSection: (section: PreferenceTab) => void;
  saving: SavingPreferences;
  onChange: (value: SavingPreferences) => void;
  colors: ColorPreferences;
  onColors: (value: ColorPreferences) => void;
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
  const sections = () => [
    { id: "saving" as const, label: "Saving" },
    { id: "colors" as const, label: "Colors" },
    { id: "backup" as const, label: "Backup" },
    // Only where the dialog is the way to it: on phones.
    ...(props.onReviewAnalytics
      ? [{ id: "privacy" as const, label: "Privacy" }]
      : []),
  ];
  // A section that went away, such as Privacy off the phone, shows saving.
  const current = () =>
    sections().some((item) => item.id === props.section)
      ? (props.section as PreferenceTab)
      : "saving";
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="Project preferences"
      closeLabel="Close project preferences"
      variant="center"
      size="large"
    >
      <div class="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav
          aria-label="Preference sections"
          class="preferences-nav flex shrink-0 gap-1 overflow-x-auto border-b border-stone-100 p-3 sm:w-52 sm:flex-col sm:border-r sm:border-b-0"
        >
          <For each={sections()}>
            {(item) => (
              <button
                type="button"
                class="menu-item w-auto! shrink-0 sm:w-full!"
                aria-current={current() === item.id ? "true" : undefined}
                {...press(() => props.onSection(item.id))}
              >
                {item.label}
              </button>
            )}
          </For>
        </nav>
        <div class="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-5 pb-8">
          <div class="preferences-body">
            <h3 class="mb-2 text-base font-semibold text-stone-900">
              {sections().find((item) => item.id === current())?.label}
            </h3>
            <Show when={current() === "saving"}>
              <p class="mb-6 text-sm leading-6 text-stone-600">
                Choose where this map is saved. Turning a switch off deletes its
                existing copy from that location. Your open map stays available
                in this tab.
              </p>
              <div class="flex max-w-2xl flex-col gap-6">
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
                  {(option) => {
                    // Cloud saving needs an account, so until there is one the row is
                    // locked and offers sign-in instead of a switch that does nothing.
                    const locked = () =>
                      option.key === "cloud" && !props.signedIn;
                    return (
                      <div class="flex items-start justify-between gap-5">
                        <div>
                          <p
                            id={`saving-${option.key}`}
                            class="flex items-center gap-1.5 font-medium"
                            classList={{ "text-stone-500": locked() }}
                          >
                            {option.label}
                            <Show when={locked()}>
                              <LockIcon class="size-4 text-stone-400" />
                            </Show>
                          </p>
                          <p
                            id={`saving-${option.key}-description`}
                            class="mt-1 text-sm leading-5 text-stone-500"
                          >
                            {locked()
                              ? "Sign in to keep a copy in your account and sync across devices."
                              : option.description}
                          </p>
                        </div>
                        <Show
                          when={!locked()}
                          fallback={
                            <button
                              type="button"
                              class="map-control outlined shrink-0"
                              aria-describedby={`saving-${option.key}-description`}
                              // Absent while the account is still being checked.
                              disabled={!props.onSignIn}
                              {...press(() => props.onSignIn?.())}
                            >
                              Sign in
                            </button>
                          }
                        >
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
                            <span>
                              {props.saving[option.key] ? "On" : "Off"}
                            </span>
                          </button>
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </div>
              {/* Without an account cloud saving cannot run, so local off means memory only. */}
              <Show
                when={
                  !props.saving.local &&
                  (!props.saving.cloud || !props.signedIn)
                }
              >
                <div class="mt-8 max-w-2xl rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
                  <p class="font-semibold">This map lives only in memory.</p>
                  <p>
                    Export a backup before closing or reloading this tab. Import
                    it when you want to continue working.
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
              <Show
                when={
                  !props.saving.local && props.saving.cloud && props.signedIn
                }
              >
                <p class="mt-8 text-sm leading-6 text-stone-600">
                  Wait for the green save dot before leaving, or export a
                  backup. This browser will not keep a copy.
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
            </Show>
            <Show when={current() === "colors"}>
              <ColorSettings colors={props.colors} onChange={props.onColors} />
            </Show>
            <Show when={current() === "backup"}>
              <p class="mb-4 text-sm leading-6 text-stone-600">
                Download this map as a file. Import it later, here or in another
                browser, to continue working.
              </p>
              <button
                type="button"
                class="map-control outlined"
                {...press(props.onExport)}
              >
                Export backup
              </button>
            </Show>
            <Show when={current() === "privacy"}>
              <p class="mb-4 text-sm leading-6 text-stone-600">
                Choose whether Mindgrab may collect anonymous usage analytics.
              </p>
              <button
                type="button"
                class="map-control outlined"
                {...press(() => props.onReviewAnalytics?.())}
              >
                Analytics choice…
              </button>
            </Show>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
