import { For, type JSX } from "solid-js";
import { closeOnEscape } from "./escape-key";
import { CloseIcon } from "./icons";
import { press } from "./press";

export type SideTab = "outline" | "notes";

const TABS: { id: SideTab; label: string }[] = [
  { id: "outline", label: "Outline" },
  { id: "notes", label: "Notes" },
];

// The drawer on the right of the map. The outline and the selected idea's
// notes are its two tabs, so they never cover each other. It follows the W3C
// tabs pattern: one tab stop, Left/Right move between tabs; Esc closes it.
export function SidePanel(props: {
  tab: SideTab;
  onTab: (tab: SideTab) => void;
  onClose: () => void;
  // The close button's tooltip for each tab, with its shortcut if any.
  closeTitle: (tab: SideTab) => string;
  outline: JSX.Element;
  notes: JSX.Element;
}) {
  let tabs!: HTMLDivElement;
  const label = () => (props.tab === "outline" ? "Outline" : "Notes");
  function keydown(e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const index = TABS.findIndex((tab) => tab.id === props.tab);
    const next = TABS[(index + (e.key === "ArrowRight" ? 1 : -1) + 2) % 2];
    props.onTab(next.id);
    queueMicrotask(() =>
      tabs.querySelector<HTMLElement>('[aria-selected="true"]')?.focus(),
    );
  }
  return (
    <aside
      data-no-pan
      data-toolbar
      aria-label={label()}
      // Focusable, so a press on the header keeps focus in the panel, where
      // Esc closes it, instead of handing it to the map.
      tabIndex={-1}
      class="map-toolbar side-panel pointer-events-auto flex flex-col cursor-default outline-none"
      ref={(el) => closeOnEscape(el, () => props.onClose())}
    >
      <header class="flex items-center gap-2 border-b border-stone-100 py-1.5 pr-1.5 pl-1.5">
        <div
          ref={tabs}
          role="tablist"
          aria-label="Side panel"
          class="flex min-w-0 flex-1 items-center gap-0.5"
          onKeyDown={keydown}
        >
          <For each={TABS}>
            {(tab) => (
              <button
                type="button"
                role="tab"
                id={`side-tab-${tab.id}`}
                aria-controls="side-tab-panel"
                aria-selected={props.tab === tab.id}
                tabIndex={props.tab === tab.id ? 0 : -1}
                class="panel-tab"
                {...press(() => props.onTab(tab.id))}
              >
                {tab.label}
              </button>
            )}
          </For>
        </div>
        <button
          type="button"
          class="icon-button size-8!"
          aria-label={`Close ${label().toLowerCase()}`}
          title={props.closeTitle(props.tab)}
          {...press(props.onClose)}
        >
          <CloseIcon class="size-4" />
        </button>
      </header>
      <div
        id="side-tab-panel"
        role="tabpanel"
        aria-labelledby={`side-tab-${props.tab}`}
        class="flex min-h-0 flex-1 flex-col"
      >
        {props.tab === "outline" ? props.outline : props.notes}
      </div>
    </aside>
  );
}
