import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { LocateIcon } from "./icons";
import type { ProjectDocument } from "./project-document";
import { bindTextarea } from "./text-binding";
import { press } from "./press";

// The selected idea's notes, shown in the side panel's Notes tab, so they
// never cover the map while writing. The idea's title heads them, with a way
// to find the idea on the map. The textarea is bound to the shared note text,
// so remote edits merge while typing and undo works like it does for idea
// titles.
export function NotesPanel(props: {
  doc: ProjectDocument;
  id?: string;
  title: string;
  onFocusChange: () => void;
  onShowOnMap: () => void;
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
    <Show
      when={props.id}
      fallback={
        <p class="p-4 text-sm text-stone-500">
          Select an idea to read or write its notes.
        </p>
      }
    >
      <NoteHeading title={props.title} onShowOnMap={props.onShowOnMap} />
      <textarea
        ref={input}
        aria-label="Idea notes"
        placeholder="Add details, links, or context…"
        class="min-h-0 flex-1 resize-none bg-transparent px-3.5 py-3 text-sm leading-6 text-stone-900 outline-none select-text placeholder:text-stone-400 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
        onFocus={props.onFocusChange}
        onBlur={props.onFocusChange}
      />
      <p class="border-t border-stone-100 px-3 py-1.5 text-[11px] text-stone-500">
        {length()
          ? `${length().toLocaleString()} characters · saved with the map`
          : "Notes are saved with the map and included in exports."}
      </p>
    </Show>
  );
}

// The idea's title as the notes' title, and the way back to the idea.
export function NoteHeading(props: { title: string; onShowOnMap: () => void }) {
  return (
    <div class="flex items-start gap-3 border-b border-stone-100 px-3.5 pt-3 pb-3">
      <h2 class="note-title min-w-0 flex-1">{props.title}</h2>
      <button
        type="button"
        class="map-control outlined flex shrink-0 items-center gap-1.5"
        {...press(props.onShowOnMap)}
      >
        <LocateIcon class="size-4" />
        Show on map
      </button>
    </div>
  );
}
