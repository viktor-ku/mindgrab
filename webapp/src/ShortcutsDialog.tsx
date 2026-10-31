import { createEffect, For } from "solid-js";
import { CloseIcon } from "./icons";

const APPLE =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD_LABEL = APPLE ? "⌘" : "Ctrl+";
export const ALT_LABEL = APPLE ? "⌥" : "Alt+";

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: "Write",
    items: [
      ["Type", "Replace the selected idea's text"],
      ["Tab", "Add a child idea (also while editing)"],
      ["Enter", "Add a sibling (a child for the central idea)"],
      ["⇧Tab", "Insert a parent above the idea"],
      ["F2 · Space · double-click", "Edit the selected idea"],
      ["Enter · Esc", "Finish editing"],
      ["⇧Enter", "New line while editing"],
    ],
  },
  {
    title: "Move and organize",
    items: [
      ["Arrow keys", "Select a nearby idea"],
      [`${ALT_LABEL}↑ · ${ALT_LABEL}↓`, "Reorder among siblings"],
      [`${ALT_LABEL}→`, "Move under the idea above"],
      [`${ALT_LABEL}←`, "Move out to the parent's level"],
      ["Drag onto an idea", "Move under it, or before/after at its edges"],
      [`${ALT_LABEL}G`, "Collapse or expand children"],
      ["⌫ · Delete", "Delete the idea and its children"],
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
      [`${MOD_LABEL}⇧Z`, "Redo"],
      [`${MOD_LABEL}S`, "Save now (saving is automatic)"],
    ],
  },
];

export function ShortcutsDialog(props: {
  open: boolean;
  onClose: () => void;
  wheelMode: "pan" | "zoom";
  onWheelMode: (mode: "pan" | "zoom") => void;
}) {
  let dialog!: HTMLDialogElement;
  createEffect(() => {
    if (props.open && !dialog.open) dialog.showModal();
    else if (!props.open && dialog.open) dialog.close();
  });
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Clicking the backdrop closes the dialog; Escape is handled natively.
    <dialog
      ref={dialog}
      class="shortcuts-dialog"
      aria-labelledby="shortcuts-title"
      data-no-pan
      onClose={props.onClose}
      onCancel={props.onClose}
      onClick={(e) => {
        if (e.target === dialog) props.onClose();
      }}
    >
      <header class="flex items-center justify-between gap-4 border-b border-stone-200 px-6 py-4">
        <h2 id="shortcuts-title" class="text-lg font-semibold">
          Shortcuts and navigation
        </h2>
        <button
          type="button"
          class="icon-button"
          aria-label="Close shortcuts"
          onClick={props.onClose}
        >
          <CloseIcon />
        </button>
      </header>
      <div class="scroll-fade grid min-h-0 gap-x-8 gap-y-6 overflow-y-auto px-6 pt-5 pb-8 sm:grid-cols-2">
        <For each={GROUPS}>
          {(group) => (
            <section>
              <h3 class="mb-2 text-xs font-semibold tracking-wide text-stone-500 uppercase">
                {group.title}
              </h3>
              <dl class="space-y-1.5 text-sm">
                <For each={group.items}>
                  {([keys, action]) => (
                    <div class="flex items-baseline justify-between gap-4">
                      <dt class="text-stone-700">{action}</dt>
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
        <section class="sm:col-span-2">
          <h3 class="mb-2 text-xs font-semibold tracking-wide text-stone-500 uppercase">
            Scrolling on the canvas
          </h3>
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
    </dialog>
  );
}
