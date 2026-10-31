import type { ProjectDocument } from "./project-document";

// The DOM adapter keeps composition local. Rust computes the text delta and
// resolves Loro cursors, including edits received while an IME draft is open.
export function bindTextarea(
  input: HTMLTextAreaElement,
  doc: ProjectDocument,
  id: string,
  onValue: (value: string) => void = () => {},
  field: "text" | "note" = "text",
) {
  const cursor = (index: number, after: boolean) =>
    field === "note"
      ? doc.native().noteCursor(id, index, after)
      : doc.native().cursor(id, index, after);
  const resolveCursor = (bytes: Uint8Array) =>
    field === "note"
      ? doc.native().resolveNoteCursor(id, bytes)
      : doc.native().resolveCursor(id, bytes);
  let base = doc.snapshot();
  let synced = doc.view().nodes.find((node) => node.id === id)?.[field] ?? "";
  let composing = false;
  let applying = false;
  let selection:
    | {
        start: Uint8Array;
        end: Uint8Array;
        direction: HTMLTextAreaElement["selectionDirection"];
      }
    | undefined;
  input.value = synced;
  onValue(synced);
  const capture = () => {
    if (composing || input.value !== synced) return;
    try {
      selection = {
        start: cursor(
          input.selectionStart,
          input.selectionStart !== input.selectionEnd,
        ),
        end: cursor(input.selectionEnd, false),
        direction: input.selectionDirection,
      };
    } catch {
      selection = undefined;
    }
  };
  function render(caret?: number) {
    const next = doc.view().nodes.find((node) => node.id === id)?.[field];
    if (next === undefined) return;
    synced = next;
    base = doc.snapshot();
    if (input.value !== next) {
      let start = caret;
      let end = caret;
      try {
        if (start === undefined && selection) {
          start = resolveCursor(selection.start);
          end = resolveCursor(selection.end);
        }
      } catch {
        /* A deleted cursor falls back to the browser caret. */
      }
      input.value = next;
      if (start !== undefined && end !== undefined)
        input.setSelectionRange(
          start,
          Math.max(start, end),
          selection?.direction,
        );
    }
    onValue(next);
  }
  function commit() {
    applying = true;
    let caret: number | undefined;
    try {
      caret = doc.change(() =>
        field === "note"
          ? doc
              .native()
              .editNoteDraft(id, base, input.value, input.selectionEnd)
          : doc.native().editDraft(id, base, input.value, input.selectionEnd),
      );
    } catch {
      /* Rejected drafts are replaced by the accepted state. */
    } finally {
      applying = false;
    }
    render(caret);
  }
  const observe = () => {
    if (!composing && !applying) render();
  };
  const onInput = (event: Event) => {
    if (!composing && !(event as InputEvent).isComposing) commit();
    onValue(input.value);
  };
  const onStart = () => {
    composing = true;
  };
  const onEnd = () => {
    composing = false;
    commit();
  };
  doc.on("beforeChange", capture);
  doc.on("snapshot", observe);
  input.addEventListener("input", onInput);
  input.addEventListener("compositionstart", onStart);
  input.addEventListener("compositionend", onEnd);
  return () => {
    if (input.value !== synced) commit();
    doc.off("beforeChange", capture);
    doc.off("snapshot", observe);
    input.removeEventListener("input", onInput);
    input.removeEventListener("compositionstart", onStart);
    input.removeEventListener("compositionend", onEnd);
  };
}
