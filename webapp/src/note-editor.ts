import type { Editor, Extensions, JSONContent } from "@tiptap/core";
import CodeBlock from "@tiptap/extension-code-block";
import HardBreak from "@tiptap/extension-hard-break";
import Link from "@tiptap/extension-link";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { Marked, type marked } from "marked";
import type { ProjectDocument } from "./project-document";
import { compositionEnded, compositionStarted } from "./text-binding";

// How long a note's Markdown may take to read. A note of the longest size
// reads in a tenth of this; one written to stall the reader would hold the
// page of whoever opens it for most of a minute.
const NOTE_PARSE_MS = 1000;
let parseDeadline = Number.POSITIVE_INFINITY;
// marked asks its extensions for a token at every step, in blocks and in
// lines. These have none to give, and end a reading that ran out of time.
function spendParseTime() {
  if (performance.now() > parseDeadline)
    throw new Error("The note took too long to read.");
  return undefined;
}

// How notes are read. Each editor gets a reader of its own, since Tiptap adds
// its extensions to the one it is given. Notes written as plain text keep
// their lines: a newline is a line break.
export function noteMarkdown() {
  const reader = new Marked({
    extensions: [
      { name: "noteTimeInBlocks", level: "block", tokenizer: spendParseTime },
      { name: "noteTimeInLines", level: "inline", tokenizer: spendParseTime },
    ],
  });
  return {
    marked: reader as unknown as typeof marked,
    markedOptions: { gfm: true, breaks: true },
  };
}

// A link's address as Markdown writes it: in angle brackets when it holds
// spaces, parentheses or brackets that would otherwise end it early.
function linkDestination(href: string) {
  return /[\s()<>\\]/.test(href)
    ? `<${href.replace(/[<>\\]/g, "\\$&")}>`
    : href;
}

// A note is read by people who did not write it: on a shared link, in a
// backup someone sends, on a pasted branch. Nothing its writer chose reaches
// the page except text, the formatting below, and links to these.
const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const LINK_ATTRIBUTES = {
  target: "_blank",
  rel: "noopener noreferrer nofollow",
};

// The address a note's link opens, as the browser reads it, or nothing when a
// note may not link there. Only whole addresses pass. A partial one (`/path`,
// `//host`, `https:path`) is completed from the page it is on, so it could
// open this site's own addresses.
export function noteLinkHref(href: unknown) {
  if (typeof href !== "string") return undefined;
  try {
    const url = new URL(href);
    return LINK_PROTOCOLS.has(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

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
      codeBlock: false,
      // It would add a paragraph to every note just by opening it.
      trailingNode: false,
      heading: { levels: [1, 2, 3] },
    }),
    // A line break is a bare newline: notes written as plain text keep their
    // lines, since they are read with `breaks` on.
    HardBreak.extend({ renderMarkdown: () => "\n" }),
    // A fence's language is whatever follows the backticks. It stays in the
    // Markdown and never becomes a class, which could name any of the app's.
    CodeBlock.extend({
      renderHTML: ({ HTMLAttributes }) => ["pre", HTMLAttributes, ["code", 0]],
    }),
    Link.extend({
      // A link keeps its address and title. Where it opens and how it looks
      // are the app's, so HTML in a note cannot set `target`, `rel` or `class`.
      addAttributes: () => ({
        href: { default: null },
        title: { default: null },
      }),
      parseHTML: () => [
        {
          tag: "a[href]",
          getAttrs: (dom) =>
            noteLinkHref(dom.getAttribute("href")) ? null : false,
        },
      ],
      // The last check before the page: a link that got this far with another
      // address draws as text.
      renderHTML: ({ HTMLAttributes }) => {
        const href = noteLinkHref(HTMLAttributes.href);
        if (!href) return ["a", {}, 0];
        const title = HTMLAttributes.title;
        return [
          "a",
          { ...LINK_ATTRIBUTES, href, ...(title && { title: String(title) }) },
          0,
        ];
      },
      // Markdown for a link a note may not hold reads as its text alone.
      parseMarkdown: (token, helpers) => {
        const content = helpers.parseInline(token.tokens || []);
        return noteLinkHref(token.href)
          ? helpers.applyMark("link", content, {
              href: token.href,
              title: token.title || null,
            })
          : content;
      },
      // The link's text arrives as a placeholder the serializer wraps, so
      // every link is written as `[text](address "title")`.
      renderMarkdown: (node, helpers) => {
        const href = String(node.attrs?.href ?? "");
        const title = node.attrs?.title ? String(node.attrs.title) : "";
        const quoted = title && ` "${title.replace(/["\\]/g, "\\$&")}"`;
        return `[${helpers.renderChildren(node)}](${linkDestination(href)}${quoted})`;
      },
    }).configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      protocols: [],
      // Typed and pasted text: an address a note may hold, or a bare domain,
      // which becomes an `http` one.
      isAllowedUri: (url) =>
        !!noteLinkHref(url) ||
        (!url.includes(":") && !!noteLinkHref(`http://${url}`)),
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Markdown.configure(noteMarkdown()),
    ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
  ];
}

// How deep a note's blocks may nest and still show formatted. Far past any
// note a person writes, and far short of what overflows the stack to draw.
const MAX_NOTE_DEPTH = 100;

function nesting(json: JSONContent) {
  let depth = 0;
  for (let level = [json]; level.length; depth++)
    level = level.flatMap((node) => node.content ?? []);
  return depth;
}

// A note as its lines, unformatted.
const plainNote = (markdown: string): JSONContent => ({
  type: "doc",
  content: markdown.split(/\r?\n/).map((line) => ({
    type: "paragraph",
    ...(line && { content: [{ type: "text", text: line }] }),
  })),
});

// How many HTML tags a note may hold and still show formatted. Tiptap looks
// through the rest of a line for the end of each one, so tens of thousands
// take it many seconds. Notes written here hold none: the editor writes `<`
// as text.
const MAX_NOTE_TAGS = 1000;
const TAG = /<\/?[a-z]/gi;

function tooManyTags(markdown: string) {
  TAG.lastIndex = 0;
  for (let count = 0; TAG.test(markdown); )
    if (++count > MAX_NOTE_TAGS) return true;
  return false;
}

// A note's Markdown as the editor's document. It never throws, and never
// holds the page for long: a note nested thousands deep overflows the stack
// to parse or to draw, which took the app down for whoever opened it, and
// one written to stall the reader froze it. Such a note shows as plain text.
// Markdown for an empty note parses to a document without blocks, which the
// schema does not allow.
export function parseNote(
  editor: { markdown?: { parse(markdown: string): JSONContent } | null },
  markdown: string,
): JSONContent {
  if (tooManyTags(markdown)) return plainNote(markdown);
  try {
    parseDeadline = performance.now() + NOTE_PARSE_MS;
    const json = editor.markdown?.parse(markdown);
    if (!json?.content?.length)
      return { type: "doc", content: [{ type: "paragraph" }] };
    if (nesting(json) <= MAX_NOTE_DEPTH) return json;
  } catch {
    // Shown as plain text, below.
  } finally {
    parseDeadline = Number.POSITIVE_INFINITY;
  }
  return plainNote(markdown);
}

// Opens links with Ctrl or Cmd held, as code editors do; a plain press puts
// the caret in the link to edit it.
export function openLinkOnModClick(event: MouseEvent) {
  if (!(event.metaKey || event.ctrlKey)) return false;
  const link =
    event.target instanceof Element ? event.target.closest("a[href]") : null;
  const href = noteLinkHref(link?.getAttribute("href"));
  if (!href) return false;
  window.open(href, "_blank", "noopener,noreferrer");
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
  // An edit made in the editor and not yet written to the note. Only edits
  // are written: a note opened and left as it was keeps its stored text, even
  // where the editor would write the same note differently.
  let dirty = false;
  editor.commands.setContent(parseNote(editor, synced), { emitUpdate: false });

  // Replaces only the part of the editor's document that differs, so the
  // selection maps through the change. When only formatting changed there,
  // positions inside still point at the same text, so the selection stays.
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
      const { selection } = editor.state;
      const tr = editor.state.tr
        .replace(start, a, next.slice(start, b))
        .setMeta("addToHistory", false);
      if (
        a === b &&
        selection.from >= start &&
        selection.to <= a &&
        current.textBetween(start, a, "\n", "\n") ===
          next.textBetween(start, b, "\n", "\n")
      )
        tr.setSelection(selection.getBookmark().resolve(tr.doc));
      editor.view.dispatch(tr);
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
    if (!doc.ready || !dirty) return;
    dirty = false;
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
    if (patching) return;
    dirty = true;
    if (!composing && !editor.view.composing) commit();
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
    if (!editor.isDestroyed) commit();
    doc.off("snapshot", observe);
    editor.off("update", onUpdate);
    dom.removeEventListener("compositionstart", onStart);
    dom.removeEventListener("compositionend", onEnd);
  };
}
