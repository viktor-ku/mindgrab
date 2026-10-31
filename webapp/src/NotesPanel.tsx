import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { CloseIcon } from "./icons";
import type { ProjectDocument } from "./project-document";
import { bindTextarea } from "./text-binding";

// Details for the selected idea, opened deliberately so notes never cover the
// map while writing. The textarea is bound to the shared note text, so remote
// edits merge while typing and undo works like it does for idea titles.
export function NotesPanel(props: {
  doc: ProjectDocument;
  id?: string;
  title: string;
  onFocusChange: () => void;
  onClose: () => void;
}) {
  let input: HTMLTextAreaElement | undefined;
  const [length, setLength] = createSignal(0);
  createEffect(
    on([() => props.doc, () => props.id], ([doc, id]) => {
      if (!input || !id) return;
      const dispose = bindTextarea(
        input,
        doc,
        id,
        (value) => setLength(value.length),
        "note",
      );
      onCleanup(dispose);
    }),
  );

  return (
    <aside
      data-no-pan
      data-toolbar
      aria-label="Notes"
      class="map-toolbar notes-panel pointer-events-auto flex flex-col cursor-default"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <header class="flex items-start justify-between gap-2 border-b border-stone-100 py-2 pr-1 pl-3">
        <div class="min-w-0">
          <h2 class="text-xs font-semibold tracking-wide text-stone-500 uppercase">
            Notes
          </h2>
          <p class="truncate text-sm font-medium text-stone-800">
            {props.id ? props.title : "No idea selected"}
          </p>
        </div>
        <button
          type="button"
          class="icon-button size-8!"
          aria-label="Close notes"
          title="Close notes (N)"
          onClick={props.onClose}
        >
          <CloseIcon class="size-4" />
        </button>
      </header>
      <Show
        when={props.id}
        fallback={
          <p class="p-4 text-sm text-stone-500">
            Select an idea to read or write its notes.
          </p>
        }
      >
        <textarea
          ref={input}
          aria-label="Idea notes"
          placeholder="Add details, links, or context…"
          class="min-h-0 flex-1 resize-none bg-transparent px-3 py-2.5 text-sm leading-6 text-stone-800 outline-none select-text placeholder:text-stone-400"
          onFocus={props.onFocusChange}
          onBlur={props.onFocusChange}
        />
        <p class="border-t border-stone-100 px-3 py-1.5 text-[11px] text-stone-400">
          {length()
            ? `${length().toLocaleString()} characters · saved with the map`
            : "Notes are saved with the map and included in exports."}
        </p>
      </Show>
    </aside>
  );
}
