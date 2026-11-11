import {
  createEffect,
  createSignal,
  type JSX,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { LocateIcon } from "./icons";
import type { ProjectDocument } from "./project-document";
import { bindTextarea } from "./text-binding";
import { press } from "./press";

// The selected idea's notes, shown in the side panel's Notes tab, so they
// never cover the map while writing. The idea's title heads them, editable
// here as on the map, with a way to find the idea on the map. Both fields are
// bound to the shared text, so remote edits merge while typing and undo works
// like it does on the map.
export function NotesPanel(props: {
  doc: ProjectDocument;
  id?: string;
  onFocusChange: () => void;
  onShowOnMap: () => void;
}) {
  let title: HTMLTextAreaElement | undefined;
  let input: HTMLTextAreaElement | undefined;
  const [titleText, setTitleText] = createSignal("");
  createEffect(
    on([() => props.doc, () => props.id], ([doc, id]) => {
      if (!input || !title || !id) return;
      onCleanup(bindTextarea(title, doc, id, setTitleText));
      onCleanup(bindTextarea(input, doc, id, undefined, "note"));
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
      <NoteHeading onShowOnMap={props.onShowOnMap}>
        {/* The title grows with its text, as on the map: an invisible copy
            sizes it and the field lies over the copy. */}
        <div class="note-title-field relative">
          <span class="note-title invisible block" aria-hidden="true">
            {(titleText() || "New idea") + "\u200b"}
          </span>
          <textarea
            ref={title}
            rows={1}
            aria-label="Idea title"
            placeholder="New idea"
            class="note-title absolute inset-0 size-full resize-none bg-transparent outline-none select-text cursor-text"
            onFocus={props.onFocusChange}
            onBlur={props.onFocusChange}
            onKeyDown={(e) => {
              // Enter goes on to the notes; Shift+Enter breaks the line, as
              // on the map.
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                input?.focus();
              }
            }}
          />
        </div>
      </NoteHeading>
      <textarea
        ref={input}
        aria-label="Idea notes"
        placeholder="Add details, links, or context…"
        class="min-h-0 flex-1 resize-none bg-transparent px-3.5 py-3 text-sm leading-6 text-stone-900 outline-none select-text placeholder:text-stone-400"
        onFocus={props.onFocusChange}
        onBlur={props.onFocusChange}
      />
    </Show>
  );
}

// The idea's title as the notes' title, and the way back to the idea.
export function NoteHeading(props: {
  children: JSX.Element;
  onShowOnMap: () => void;
}) {
  return (
    <div class="flex items-start gap-3 border-b border-stone-100 px-3.5 pt-3 pb-3">
      <div class="min-w-0 flex-1">{props.children}</div>
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
