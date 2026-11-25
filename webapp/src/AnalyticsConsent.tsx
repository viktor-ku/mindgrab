import { createEffect, Show } from "solid-js";
import { consentOpen, setConsent } from "./analytics";
import { press } from "./press";

// "Accept all" has focus when the banner opens, so one click or Enter accepts.
// "Decline" has the same size and style, as EU consent guidance requires.
// The first visit is a forced choice between those two. Preferences
// show the choice afterwards and change it.
export function AnalyticsConsent() {
  let accept: HTMLButtonElement | undefined;
  createEffect(() => {
    if (consentOpen()) queueMicrotask(() => accept?.focus());
  });
  return (
    <Show when={consentOpen()}>
      <section
        data-no-pan
        data-toolbar
        aria-label="Analytics choice"
        // On desktop it sits above the selection toolbar's and the notice's
        // slots, and under the color popover, which opens up into it.
        class="map-toolbar absolute bottom-3 left-1/2 z-40 w-[30rem] max-w-[calc(100%-1.5rem)] -translate-x-1/2 p-3! cursor-default sm:bottom-[7.5rem] sm:z-30"
      >
        <p class="text-sm font-semibold text-stone-800">
          Help improve Mindgrab?
        </p>
        <p class="mt-0.5 text-xs leading-5 text-stone-600">
          With your permission, we use cookies to learn how Mindgrab is used,
          such as how many ideas a map has and which features are opened, and
          link this to your account when you sign in. Your maps, notes, and
          project names are never sent. If you decline, we only count usage
          anonymously, without cookies. You can change this anytime in project
          preferences.
        </p>
        <div class="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            ref={accept}
            type="button"
            class="map-control outlined"
            {...press(() => setConsent("granted"))}
          >
            Accept all
          </button>
          <button
            type="button"
            class="map-control outlined"
            {...press(() => setConsent("denied"))}
          >
            Decline
          </button>
        </div>
      </section>
    </Show>
  );
}
