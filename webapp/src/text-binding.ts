import { createSignal } from "solid-js";
import type { ProjectDocument } from "./project-document";

// Text being composed belongs to the browser until the composition ends, so a
// document swap has to wait for it: it can neither be read reliably nor moved.
const [compositions, setCompositions] = createSignal(0);
export const composing = () => compositions() > 0;

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
  let active = false;
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
    if (active || input.value !== synced) return;
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
    // The doc under an open editor can be replaced (an adopted placeholder);
    // the owner rebinds, and a late event on the old doc has nowhere to go.
    if (!doc.ready) return;
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
    if (!active && !applying) render();
  };
  const onInput = (event: Event) => {
    if (!active && !(event as InputEvent).isComposing) commit();
    onValue(input.value);
  };
  const onStart = () => {
    if (!active) setCompositions((count) => count + 1);
    active = true;
  };
  const finish = () => {
    if (active) setCompositions((count) => count - 1);
    active = false;
  };
  const onEnd = () => {
    const ended = active;
    active = false;
    commit();
    // Only now: whoever waits for the composition must see the committed text.
    if (ended) setCompositions((count) => count - 1);
  };
  doc.on("beforeChange", capture);
  doc.on("snapshot", observe);
  input.addEventListener("input", onInput);
  input.addEventListener("compositionstart", onStart);
  input.addEventListener("compositionend", onEnd);
  return () => {
    finish();
    if (input.value !== synced && doc.ready) commit();
    doc.off("beforeChange", capture);
    doc.off("snapshot", observe);
    input.removeEventListener("input", onInput);
    input.removeEventListener("compositionstart", onStart);
    input.removeEventListener("compositionend", onEnd);
  };
}
