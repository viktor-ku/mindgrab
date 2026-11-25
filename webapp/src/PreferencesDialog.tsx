import { For, Show } from "solid-js";
import { analyticsEnabled, consent, setConsent } from "./analytics";
import type { PreferenceTab } from "./app-search";
import { ColorSettings } from "./ColorSettings";
import { Dialog } from "./Dialog";
import { LockIcon, UndoIcon } from "./icons";
import { connectionPath } from "./mind-map";
import { press } from "./press";
import type {
  ColorPreferences,
  LinkStyle,
  PreferenceLevel,
  PreferenceName,
  PreferenceScope,
  SavingPreferences,
} from "./preferences";
import type { CloudStatus } from "./project-sync";
import { ShortcutsSettings } from "./ShortcutsSettings";

export function PreferencesDialog(props: {
  open: boolean;
  onClose: () => void;
  // The section shown, from the address; saving when absent.
  section?: PreferenceTab;
  onSection: (section: PreferenceTab) => void;
  // Where maps are kept, for the scope.
  saving: SavingPreferences;
  onChange: (value: SavingPreferences) => void;
  // Which maps Saving, Colors and Connections edit: this one, or all of them.
  scope: PreferenceScope;
  onScope: (scope: PreferenceScope) => void;
  // The values for that scope.
  colors: ColorPreferences;
  onColors: (value: ColorPreferences) => void;
  links: LinkStyle;
  onLinks: (value: LinkStyle) => void;
  // What this map sets for itself, and a way to stop setting it.
  own: PreferenceLevel;
  onReset: (names: PreferenceName[]) => void;
  busy: boolean;
  error: string;
  cloudStatus?: CloudStatus;
  signedIn: boolean;
  onExport: () => void;
  // Starts sign-in; absent while signed in or while the account is checked.
  onSignIn?: () => void;
  // What a scroll wheel does on the canvas, on this device.
  wheelMode: "pan" | "zoom";
  onWheelMode: (mode: "pan" | "zoom") => void;
}) {
  let firstSwitch: HTMLButtonElement | undefined;
  const sections = () => [
    { id: "saving" as const, label: "Saving" },
    { id: "colors" as const, label: "Colors" },
    { id: "connections" as const, label: "Connections" },
    { id: "backup" as const, label: "Backup" },
    { id: "shortcuts" as const, label: "Shortcuts" },
    // Only in builds that collect analytics.
    ...(analyticsEnabled ? [{ id: "privacy" as const, label: "Privacy" }] : []),
  ];
  // A section that is not offered, such as Privacy without analytics, shows
  // saving.
  const current = () =>
    sections().some((item) => item.id === props.section)
      ? (props.section as PreferenceTab)
      : "saving";
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="Preferences"
      closeLabel="Close preferences"
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
        {/* Positioned so sr-only legends, such as the one in Shortcuts, stay
            inside this scroller rather than overflowing the dialog. */}
        <div class="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-5 pb-8">
          <div class="preferences-body">
            <Show when={SCOPED[current()]}>
              {(section) => (
                <ScopeRow
                  scope={props.scope}
                  onScope={props.onScope}
                  own={props.own}
                  onReset={props.onReset}
                  names={section().names}
                  what={section().what}
                />
              )}
            </Show>
            <Show when={current() === "shortcuts"}>
              <GlobalScopeRow what="Shortcuts are the same in every map." />
            </Show>
            <h3 class="mb-2 text-base font-semibold text-stone-900">
              {sections().find((item) => item.id === current())?.label}
            </h3>
            <Show when={current() === "saving"}>
              <p class="mb-6 text-sm leading-6 text-stone-600">
                {props.scope === "map"
                  ? "Choose where this map is saved. Turning a switch off deletes its existing copy from that location. Your open map stays available in this tab."
                  : "Choose where your maps are saved, unless a map chooses for itself. Turning a switch off deletes a map's copy from that location the next time the map opens."}
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
                  props.scope === "global" &&
                  !props.saving.local &&
                  (!props.saving.cloud || !props.signedIn)
                }
              >
                <div class="mt-8 max-w-2xl rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
                  <p class="font-semibold">
                    Maps that follow these switches live only in memory.
                  </p>
                  <p>
                    Export a backup of each one before closing or reloading its
                    tab.
                  </p>
                </div>
              </Show>
              <Show
                when={
                  props.scope === "map" &&
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
                  props.scope === "map" &&
                  !props.saving.local &&
                  props.saving.cloud &&
                  props.signedIn
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
              <ColorSettings
                colors={props.colors}
                onChange={props.onColors}
                scope={props.scope}
              />
            </Show>
            <Show when={current() === "connections"}>
              <p class="mb-6 max-w-2xl text-sm leading-6 text-stone-600">
                {props.scope === "map"
                  ? "Choose how lines run from an idea to its children in this map."
                  : "Choose how lines run from an idea to its children in every map without a connection style of its own."}
              </p>
              <fieldset class="grid max-w-2xl gap-2 sm:grid-cols-3">
                <legend class="sr-only">Connection style</legend>
                <For each={LINK_STYLES}>
                  {(option) => (
                    <label class="choice-card flex-col">
                      <LinkPreview style={option.style} />
                      <span class="flex items-start gap-2">
                        <input
                          type="radio"
                          name="link-style"
                          checked={props.links === option.style}
                          onChange={() => props.onLinks(option.style)}
                        />
                        <span>
                          <span class="block font-medium text-stone-800">
                            {option.label}
                          </span>
                          <span class="block text-xs text-stone-500">
                            {option.description}
                          </span>
                        </span>
                      </span>
                    </label>
                  )}
                </For>
              </fieldset>
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
            <Show when={current() === "shortcuts"}>
              <ShortcutsSettings
                wheelMode={props.wheelMode}
                onWheelMode={props.onWheelMode}
              />
            </Show>
            <Show when={current() === "privacy"}>
              <p class="mb-6 max-w-2xl text-sm leading-6 text-stone-600">
                With your permission, we use cookies to learn how Mindgrab is
                used, such as how many ideas a map has and which features are
                opened, and link this to your account when you sign in. Your
                maps, notes, and project names are never sent. If you decline,
                we only count usage anonymously, without cookies.
              </p>
              <fieldset class="max-w-xs">
                <legend id="analytics-choice" class="mb-2 font-medium">
                  Usage analytics
                </legend>
                <div class="style-segments">
                  <button
                    type="button"
                    class="style-segment"
                    aria-pressed={consent() === "granted"}
                    {...press(() => setConsent("granted"))}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    class="style-segment"
                    aria-pressed={consent() === "denied"}
                    {...press(() => setConsent("denied"))}
                  >
                    Decline
                  </button>
                </div>
              </fieldset>
              <p class="mt-4 max-w-2xl text-sm leading-6 text-stone-500">
                {props.signedIn
                  ? "Your answer applies to your account, on every device you sign in on."
                  : "Your answer applies to this browser, and to your account once you sign in."}
              </p>
              <p role="status" class="mt-3 text-sm text-stone-500">
                {consent() === "granted"
                  ? "You accepted analytics."
                  : consent() === "denied"
                    ? "You declined analytics."
                    : "You have not chosen yet."}
              </p>
            </Show>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// Which maps the section's settings apply to, and whether this map sets
// them itself. A map that does can go back to the settings for all maps.
function ScopeRow(props: {
  scope: PreferenceScope;
  onScope: (scope: PreferenceScope) => void;
  own: PreferenceLevel;
  onReset: (names: PreferenceName[]) => void;
  names: PreferenceName[];
  what: string;
}) {
  const own = () => props.names.some((name) => props.own[name] !== undefined);
  return (
    <div class="preferences-scope">
      <div class="flex flex-wrap items-center gap-2">
        <label for="preference-scope" class="text-sm text-stone-600">
          Applying settings for
        </label>
        <select
          id="preference-scope"
          class="scope-select"
          value={props.scope}
          onChange={(e) =>
            props.onScope(e.currentTarget.value as PreferenceScope)
          }
        >
          <option value="map">This map</option>
          <option value="global">All maps</option>
        </select>
      </div>
      <Show when={props.scope === "map"}>
        <div class="mt-2 flex flex-wrap items-center gap-x-2 text-sm text-stone-500">
          <Show
            when={own()}
            fallback={
              <p>
                This map uses your {props.what} for all maps until you change it
                here.
              </p>
            }
          >
            <p>This map has its own {props.what}.</p>
            <button
              type="button"
              class="scope-reset"
              {...press(() => props.onReset(props.names))}
            >
              <UndoIcon class="size-3.5" />
              Use the {props.what} for all maps
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}

// The scope row of a section that only has settings for all maps, such as
// Shortcuts: the same control, held at all maps.
function GlobalScopeRow(props: { what: string }) {
  return (
    <div class="preferences-scope">
      <div class="flex flex-wrap items-center gap-2">
        <label for="preference-scope" class="text-sm text-stone-600">
          Applying settings for
        </label>
        <select
          id="preference-scope"
          class="scope-select"
          disabled
          aria-describedby="preference-scope-fixed"
        >
          <option value="global">All maps</option>
        </select>
      </div>
      <p id="preference-scope-fixed" class="mt-2 text-sm text-stone-500">
        {props.what}
      </p>
    </div>
  );
}

// The sections whose settings apply to this map or to all maps.
const SCOPED: Partial<
  Record<PreferenceTab, { names: PreferenceName[]; what: string }>
> = {
  saving: { names: ["saveLocally", "saveInCloud"], what: "saving" },
  colors: { names: ["quickColors", "newIdeaColor"], what: "colors" },
  connections: { names: ["linkStyle"], what: "connection style" },
};

const LINK_STYLES: { style: LinkStyle; label: string; description: string }[] =
  [
    {
      style: "rounded",
      label: "Rounded",
      description: "Lines share a spine and turn into each child.",
    },
    {
      style: "square",
      label: "Square",
      description: "The same tree with sharp corners.",
    },
    {
      style: "freeform",
      label: "Freeform",
      description: "A curve from the idea to each child.",
    },
  ];

// A parent and three children drawn in a style, with the map's own lines.
function LinkPreview(props: { style: LinkStyle }) {
  const box = (x: number, y: number, width: number) => ({
    id: "",
    text: "",
    x,
    y,
    width,
    height: 14,
  });
  const parent = box(8, 33, 36);
  const children = [box(76, 9, 52), box(76, 33, 40), box(76, 57, 46)];
  return (
    <svg
      viewBox="0 0 136 80"
      class="mb-1 h-20 w-full rounded-md bg-[var(--paper)]"
      aria-hidden="true"
    >
      <For each={children}>
        {(child) => (
          <path
            d={connectionPath({ from: parent, to: child }, props.style)}
            fill="none"
            class="stroke-stone-400"
            stroke-width="1.5"
          />
        )}
      </For>
      <For each={[parent, ...children]}>
        {(node, index) => (
          <rect
            x={node.x}
            y={node.y}
            width={node.width}
            height={node.height}
            rx="1"
            class={index() === 0 ? "fill-stone-800" : "fill-white"}
          />
        )}
      </For>
    </svg>
  );
}
