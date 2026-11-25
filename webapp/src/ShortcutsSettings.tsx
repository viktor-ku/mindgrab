import { For } from "solid-js";

const APPLE =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD_LABEL = APPLE ? "⌘" : "Ctrl+";
export const ALT_LABEL = APPLE ? "⌥" : "Alt+";
export const SHIFT_LABEL = APPLE ? "⇧" : "Shift+";
export const DELETE_LABEL = APPLE ? "⌫" : "Backspace";

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: "Write",
    items: [
      ["Type", "Replace the selected idea’s text"],
      ["Tab", "Add a child idea (also while editing)"],
      ["Enter", "Add a sibling (a child for the central idea)"],
      [`${SHIFT_LABEL}Tab`, "Insert a parent above the idea"],
      ["F2 · Space · double-click", "Edit the selected idea"],
      ["Enter · Esc", "Finish editing"],
      [`${SHIFT_LABEL}Enter`, "New line while editing"],
    ],
  },
  {
    title: "Move and organize",
    items: [
      ["Arrow keys", "Select a nearby idea"],
      [
        `${SHIFT_LABEL}↑ · ${SHIFT_LABEL}↓`,
        "Select neighboring sibling ideas too",
      ],
      [`${MOD_LABEL}A`, "Select all ideas to color, delete or copy them"],
      [`${ALT_LABEL}↑ · ${ALT_LABEL}↓`, "Reorder among siblings"],
      [`${ALT_LABEL}→`, "Move under the idea above"],
      [`${ALT_LABEL}←`, "Move out to the parent’s level"],
      ["Drag onto an idea", "Move under it, or before/after at its edges"],
      [`${ALT_LABEL}G`, "Collapse or expand children"],
      [`${DELETE_LABEL} · Delete`, "Delete the idea and its children"],
      [
        `${MOD_LABEL}C · ${MOD_LABEL}X · ${MOD_LABEL}V`,
        "Copy, cut, paste branches as outlines",
      ],
    ],
  },
  {
    title: "Find your way",
    items: [
      [`${MOD_LABEL}F`, "Search; Esc returns to where you were"],
      ["/ · ?", "Search · shortcuts (when no idea is selected)"],
      [`${ALT_LABEL}F`, "Focus on the selected branch"],
      [`${ALT_LABEL}N`, "Open notes for the selected idea"],
      [`${ALT_LABEL}O`, "Show or hide the outline"],
      [`${ALT_LABEL}1`, "Fit the whole map"],
      [`${ALT_LABEL}2`, "Fit the selected branch"],
      [`${MOD_LABEL}+ · ${MOD_LABEL}−`, "Zoom around the selection"],
      [`${MOD_LABEL}0`, "Zoom to 100%"],
      ["Esc", "Clear selection, then leave focus"],
      ["F6", "Move between the map and the toolbars"],
    ],
  },
  {
    title: "Safety",
    items: [
      [`${MOD_LABEL}Z`, "Undo"],
      [`${MOD_LABEL}${SHIFT_LABEL}Z`, "Redo"],
      [`${MOD_LABEL}S`, "Save now (saving is automatic)"],
      [`${MOD_LABEL}${SHIFT_LABEL}E`, "Export an image of the map"],
    ],
  },
];

// The Shortcuts preferences section: the keys there are, and what a scroll
// wheel does on the canvas. The keys cannot be changed yet.
export function ShortcutsSettings(props: {
  wheelMode: "pan" | "zoom";
  onWheelMode: (mode: "pan" | "zoom") => void;
}) {
  return (
    <>
      <p class="mb-6 max-w-2xl text-sm leading-6 text-stone-600">
        Press ? with nothing selected to open this list from the map. The keys
        cannot be changed yet.
      </p>
      <div class="grid gap-x-8 gap-y-6 lg:grid-cols-2">
        <For each={GROUPS}>
          {(group) => (
            <section>
              <h4 class="mb-2.5 text-sm font-semibold text-stone-900">
                {group.title}
              </h4>
              <dl class="space-y-2 text-sm">
                <For each={group.items}>
                  {([keys, action]) => (
                    <div class="flex items-baseline justify-between gap-4">
                      <dt class="text-stone-600">{action}</dt>
                      <dd class="shrink-0">
                        <kbd>{keys}</kbd>
                      </dd>
                    </div>
                  )}
                </For>
              </dl>
            </section>
          )}
        </For>
        <section class="lg:col-span-2">
          <h4 class="mb-2.5 text-sm font-semibold text-stone-900">
            Scrolling on the canvas
          </h4>
          <fieldset class="grid gap-2 sm:grid-cols-2">
            <legend class="sr-only">What scrolling does</legend>
            <label class="choice-card">
              <input
                type="radio"
                name="wheel-mode"
                checked={props.wheelMode === "pan"}
                onChange={() => props.onWheelMode("pan")}
              />
              <span>
                <span class="block font-medium text-stone-800">
                  Scroll moves the map
                </span>
                <span class="block text-xs text-stone-500">
                  Best for trackpads. Pinch or hold {MOD_LABEL.replace("+", "")}{" "}
                  to zoom.
                </span>
              </span>
            </label>
            <label class="choice-card">
              <input
                type="radio"
                name="wheel-mode"
                checked={props.wheelMode === "zoom"}
                onChange={() => props.onWheelMode("zoom")}
              />
              <span>
                <span class="block font-medium text-stone-800">
                  Scroll zooms
                </span>
                <span class="block text-xs text-stone-500">
                  Best for mouse wheels. Drag the background to move.
                </span>
              </span>
            </label>
          </fieldset>
        </section>
      </div>
    </>
  );
}
