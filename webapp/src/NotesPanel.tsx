import { type ChainedCommands, Editor } from "@tiptap/core";
import {
  createEffect,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  BoldIcon,
  BulletListIcon,
  ChecklistIcon,
  ItalicIcon,
  LocateIcon,
  NumberedListIcon,
  QuoteIcon,
  StrikeIcon,
} from "./icons";
import {
  bindNoteEditor,
  noteExtensions,
  openLinkOnModClick,
  parseNote,
} from "./note-editor";
import type { ProjectDocument } from "./project-document";
import { bindTextarea } from "./text-binding";
import { press } from "./press";
import { MOD_LABEL, SHIFT_LABEL } from "./ShortcutsSettings";

// The panel's arrow cursor would carry into the notes: unlike a textarea, an
// editable element shows the text cursor only when asked to.
const NOTE_CONTENT =
  "note-content min-h-full px-3.5 py-3 text-sm leading-6 text-stone-900 outline-none select-text cursor-text wrap-anywhere";

// The selected idea's notes, shown in the side panel's Notes tab, so they
// never cover the map while writing. The idea's title heads them, editable
// here as on the map, with a way to find the idea on the map. Both fields are
// bound to the shared text, so remote edits merge while typing and undo works
// like it does on the map. The notes are rich text, kept as Markdown.
export function NotesPanel(props: {
  doc: ProjectDocument;
  id?: string;
  onFocusChange: () => void;
  onShowOnMap: () => void;
}) {
  let title: HTMLTextAreaElement | undefined;
  const [editor, setEditor] = createSignal<Editor>();
  const [titleText, setTitleText] = createSignal("");
  createEffect(
    on([() => props.doc, () => props.id, editor], ([doc, id, editor]) => {
      if (!editor || !title || !id) return;
      onCleanup(bindTextarea(title, doc, id, setTitleText));
      onCleanup(bindNoteEditor(editor, doc, id));
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
            {(titleText() || "New idea") + "​"}
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
                editor()?.view.focus();
              }
            }}
          />
        </div>
      </NoteHeading>
      <NoteEditor onEditor={setEditor} onFocusChange={props.onFocusChange} />
    </Show>
  );
}

// The notes' rich text editor, under its formatting toolbar.
function NoteEditor(props: {
  onEditor: (editor: Editor | undefined) => void;
  onFocusChange: () => void;
}) {
  let host!: HTMLDivElement;
  const [editor, setEditor] = createSignal<Editor>();
  // Bumped on every transaction, so the toolbar follows the selection.
  const [revision, setRevision] = createSignal(0);
  onMount(() => {
    const instance = new Editor({
      element: host,
      extensions: noteExtensions("Add details, links, or context…"),
      editorProps: {
        attributes: {
          "aria-label": "Idea notes",
          "aria-multiline": "true",
          role: "textbox",
          class: NOTE_CONTENT,
        },
        handleClick: (_view, _pos, event) => openLinkOnModClick(event),
      },
      onTransaction: () => setRevision((n) => n + 1),
      onFocus: props.onFocusChange,
      onBlur: props.onFocusChange,
    });
    setEditor(instance);
    props.onEditor(instance);
    onCleanup(() => {
      props.onEditor(undefined);
      instance.destroy();
    });
  });
  return (
    <>
      <Show when={editor()}>
        {(editor) => (
          <NoteToolbar
            editor={editor()}
            revision={revision()}
            onStep={props.onFocusChange}
          />
        )}
      </Show>
      <div ref={host} class="min-h-0 flex-1 overflow-y-auto" />
    </>
  );
}

type Style = { label: string; level?: 1 | 2 | 3 };
// Sizes are headings, the one size Markdown can hold.
const STYLES: Style[] = [
  { label: "Normal" },
  { label: "Heading 1", level: 1 },
  { label: "Heading 2", level: 2 },
  { label: "Heading 3", level: 3 },
];

type Format = {
  label: string;
  keys: string;
  icon: (props: { class?: string }) => JSX.Element;
  active: (editor: Editor) => boolean;
  run: (chain: ChainedCommands) => ChainedCommands;
};
const FORMATS: Format[][] = [
  [
    {
      label: "Bold",
      keys: `${MOD_LABEL}B`,
      icon: BoldIcon,
      active: (e) => e.isActive("bold"),
      run: (c) => c.toggleBold(),
    },
    {
      label: "Italic",
      keys: `${MOD_LABEL}I`,
      icon: ItalicIcon,
      active: (e) => e.isActive("italic"),
      run: (c) => c.toggleItalic(),
    },
    {
      label: "Strikethrough",
      keys: `${MOD_LABEL}${SHIFT_LABEL}S`,
      icon: StrikeIcon,
      active: (e) => e.isActive("strike"),
      run: (c) => c.toggleStrike(),
    },
  ],
  [
    {
      label: "Bulleted list",
      keys: `${MOD_LABEL}${SHIFT_LABEL}8`,
      icon: BulletListIcon,
      active: (e) => e.isActive("bulletList"),
      run: (c) => c.toggleBulletList(),
    },
    {
      label: "Numbered list",
      keys: `${MOD_LABEL}${SHIFT_LABEL}7`,
      icon: NumberedListIcon,
      active: (e) => e.isActive("orderedList"),
      run: (c) => c.toggleOrderedList(),
    },
    {
      label: "Checklist",
      keys: `${MOD_LABEL}${SHIFT_LABEL}9`,
      icon: ChecklistIcon,
      active: (e) => e.isActive("taskList"),
      run: (c) => c.toggleTaskList(),
    },
    {
      label: "Quote",
      keys: `${MOD_LABEL}${SHIFT_LABEL}B`,
      icon: QuoteIcon,
      active: (e) => e.isActive("blockquote"),
      run: (c) => c.toggleBlockquote(),
    },
  ],
];

function NoteToolbar(props: {
  editor: Editor;
  revision: number;
  // Ends the undo step in progress, so each format undoes on its own.
  onStep: () => void;
}) {
  // Formatting acts on the selection the editor kept when the toolbar took
  // focus, and hands focus back to the editor.
  const apply = (run: (chain: ChainedCommands) => ChainedCommands) => {
    props.onStep();
    props.editor.view.focus();
    run(props.editor.chain()).run();
    props.onStep();
  };
  const style = () => {
    void props.revision;
    const index = STYLES.findIndex(
      (style) =>
        style.level !== undefined &&
        props.editor.isActive("heading", { level: style.level }),
    );
    return String(Math.max(0, index));
  };
  const active = (format: Format) => {
    void props.revision;
    return format.active(props.editor);
  };
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      aria-orientation="horizontal"
      class="flex flex-wrap items-center gap-0.5 border-b border-stone-100 px-2 py-1"
    >
      <select
        aria-label="Text size"
        title="Text size"
        class="note-style-select"
        value={style()}
        onChange={(e) => {
          const level = STYLES[Number(e.currentTarget.value)]?.level;
          apply((c) => (level ? c.setHeading({ level }) : c.setParagraph()));
        }}
      >
        <For each={STYLES}>
          {(style, index) => <option value={index()}>{style.label}</option>}
        </For>
      </select>
      <For each={FORMATS}>
        {(group) => (
          <>
            <span class="mx-1 h-5 w-px bg-stone-200" aria-hidden="true" />
            <For each={group}>
              {(format) => (
                <button
                  type="button"
                  class="icon-button size-8!"
                  aria-label={format.label}
                  title={`${format.label} (${format.keys})`}
                  aria-pressed={active(format)}
                  {...press(() => apply(format.run))}
                >
                  <format.icon class="size-4.5" />
                </button>
              )}
            </For>
          </>
        )}
      </For>
    </div>
  );
}

// An idea's notes, formatted and read only.
export function NoteView(props: { note: string }) {
  let host!: HTMLDivElement;
  onMount(() => {
    const editor = new Editor({
      element: host,
      editable: false,
      extensions: noteExtensions(),
      editorProps: {
        attributes: { "aria-label": "Idea notes", class: NOTE_CONTENT },
      },
    });
    createEffect(() =>
      editor.commands.setContent(parseNote(editor, props.note), {
        emitUpdate: false,
      }),
    );
    onCleanup(() => editor.destroy());
  });
  return <div ref={host} class="min-h-0 flex-1 overflow-y-auto" />;
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
