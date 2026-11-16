import type { Editor, Extensions, JSONContent } from "@tiptap/core";
import HardBreak from "@tiptap/extension-hard-break";
import Link from "@tiptap/extension-link";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import type { ProjectDocument } from "./project-document";
import { compositionEnded, compositionStarted } from "./text-binding";

// Notes are Markdown in the shared note text, so they stay readable wherever
// they go as text (copies, exports, older clients), and the rich editor only
// shows them formatted. The extensions are limited to what Markdown can hold:
// sizes are headings, and there is no underline or color.
export function noteExtensions(placeholder?: string): Extensions {
  return [
    StarterKit.configure({
      // Undo and redo go through the map's history, which covers notes.
      undoRedo: false,
      underline: false,
      hardBreak: false,
      link: false,
      // It would add a paragraph to every note just by opening it.
      trailingNode: false,
      heading: { levels: [1, 2, 3] },
    }),
    // A line break is a bare newline: notes written as plain text keep their
    // lines, since they are read with `breaks` on.
    HardBreak.extend({ renderMarkdown: () => "\n" }),
    Link.extend({
      // A pasted or typed address stays a bare address, as it was written.
      renderMarkdown: (node, helpers) => {
        const href = String(node.attrs?.href ?? "");
        const text = helpers.renderChildren(node);
        if (text.replace(/\\(.)/g, "$1") !== href) return `[${text}](${href})`;
        return /[\\*_~`<>[\]()]/.test(href) ? `<${href}>` : href;
      },
    }).configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
  ];
}

// Markdown for an empty note parses to a document without blocks, which the
// schema does not allow.
export function parseNote(editor: Editor, markdown: string): JSONContent {
  const json = editor.markdown?.parse(markdown);
  return json?.content?.length
    ? json
    : { type: "doc", content: [{ type: "paragraph" }] };
}

// Opens links with Ctrl or Cmd held, as code editors do; a plain press puts
// the caret in the link to edit it.
export function openLinkOnModClick(event: MouseEvent) {
  if (!(event.metaKey || event.ctrlKey)) return false;
  const link =
    event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!link) return false;
  window.open(link.getAttribute("href") ?? "", "_blank", "noopener,noreferrer");
  return true;
}

const noteOf = (doc: ProjectDocument, id: string) =>
  doc.view().nodes.find((node) => node.id === id)?.note;

// The end of the changed region in `next`, in UTF-16 units, so Rust diffs
// the draft into the smallest edit and keeps concurrent edits around it.
function changeEnd(previous: string, next: string) {
  const a = Array.from(previous);
  const b = Array.from(next);
  let prefix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < Math.min(a.length, b.length) - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  return b.slice(0, b.length - suffix).join("").length;
}

// Binds the rich notes editor to an idea's shared note, like bindTextarea
// does for the title. The editor is the source of truth for what it shows:
// Markdown cannot hold every state it passes through while typing (an empty
// last line, a break at the end of a line), so its own edits are never read
// back into it. Edits from elsewhere are patched in where they differ, which
// keeps the caret where it was.
export function bindNoteEditor(
  editor: Editor,
  doc: ProjectDocument,
  id: string,
) {
  let base = doc.snapshot();
  // The note as the editor shows it; unknown after a rejected draft.
  let synced: string | undefined = noteOf(doc, id) ?? "";
  let applying = false;
  let patching = false;
  let composing = false;
  editor.commands.setContent(parseNote(editor, synced), { emitUpdate: false });

  // Replaces only the part of the editor's document that differs, so the
  // selection maps through the change.
  function show(markdown: string) {
    patching = true;
    try {
      const next = editor.schema.nodeFromJSON(parseNote(editor, markdown));
      const current = editor.state.doc;
      const start = current.content.findDiffStart(next.content);
      if (start === null) return;
      const end = current.content.findDiffEnd(next.content);
      if (!end) return;
      let { a, b } = end;
      const overlap = start - Math.min(a, b);
      if (overlap > 0) {
        a += overlap;
        b += overlap;
      }
      editor.view.dispatch(
        editor.state.tr
          .replace(start, a, next.slice(start, b))
          .setMeta("addToHistory", false),
      );
    } catch {
      editor.commands.setContent(parseNote(editor, markdown), {
        emitUpdate: false,
      });
    } finally {
      patching = false;
    }
  }
  function render() {
    const next = noteOf(doc, id);
    if (next === undefined) return;
    base = doc.snapshot();
    if (next === synced) return;
    synced = next;
    show(next);
  }
  function commit() {
    // The doc under an open editor can be replaced (an adopted placeholder);
    // the owner rebinds, and a late event on the old doc has nowhere to go.
    if (!doc.ready) return;
    const next = editor.getMarkdown();
    if (next === synced) return;
    const previous = synced ?? "";
    applying = true;
    try {
      doc.change(() =>
        doc.native().editNoteDraft(id, base, next, changeEnd(previous, next)),
      );
      // Accepted as written: the editor already shows it.
      synced = next;
    } catch {
      // Rejected drafts (over the size limit) are replaced by the accepted
      // state, which the editor no longer shows.
      synced = undefined;
    } finally {
      applying = false;
    }
    render();
  }
  const onUpdate = () => {
    if (!patching && !composing && !editor.view.composing) commit();
  };
  const observe = () => {
    if (!applying && !composing) render();
  };
  const onStart = () => {
    if (!composing) compositionStarted();
    composing = true;
  };
  // ProseMirror reads the composed text into its document in a microtask
  // after the composition ends; the commit comes after that.
  const onEnd = () => {
    queueMicrotask(() => {
      if (!composing || editor.view.composing) return;
      composing = false;
      commit();
      // Only now: whoever waits for the composition must see the committed text.
      compositionEnded();
    });
  };
  const dom = editor.view.dom;
  doc.on("snapshot", observe);
  editor.on("update", onUpdate);
  dom.addEventListener("compositionstart", onStart);
  dom.addEventListener("compositionend", onEnd);
  return () => {
    if (composing) compositionEnded();
    composing = false;
    if (doc.ready && !editor.isDestroyed) commit();
    doc.off("snapshot", observe);
    editor.off("update", onUpdate);
    dom.removeEventListener("compositionstart", onStart);
    dom.removeEventListener("compositionend", onEnd);
  };
}
