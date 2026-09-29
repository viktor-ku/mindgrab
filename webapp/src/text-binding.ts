import * as Y from "yjs";
import { diffText, editNodeText, nodeText } from "./project-document";
import type { TextChange } from "./project-document";

type Delta = { insert?: unknown; delete?: number; retain?: number }[];

// Maps an index in the text before `delta` to the text after it. With
// `after`, an index at an insertion point moves past the inserted text.
function mapIndex(index: number, delta: Delta, after: boolean) {
  let position = 0;
  let mapped = index;
  for (const op of delta) {
    if (position > index) break;
    if (op.retain) position += op.retain;
    else if (op.delete) {
      mapped -= Math.min(op.delete, Math.max(0, index - position));
      position += op.delete;
    } else if (typeof op.insert === "string" && (position < index || after))
      mapped += op.insert.length;
  }
  return mapped;
}

// Rebases a change computed against older text over a later delta.
export function rebaseChange(change: TextChange, delta: Delta): TextChange {
  const index = mapIndex(change.index, delta, true);
  const end = change.deleteCount
    ? mapIndex(change.index + change.deleteCount, delta, false)
    : index;
  return {
    index,
    deleteCount: Math.max(0, end - index),
    insert: change.insert,
  };
}

// Binds a textarea to a node's shared text until the returned function is
// called. Local input becomes minimal insert/delete operations. Other writers
// rewrite the textarea while the selection stays on the same characters. IME
// composition stays local until it ends; changes that arrive meanwhile are
// rendered afterwards, and the composed text is rebased over them.
export function bindTextarea(
  input: HTMLTextAreaElement,
  doc: Y.Doc,
  id: string,
  onValue: (value: string) => void = () => {},
): () => void {
  const text = nodeText(doc, id);
  if (!text) return () => {};
  let synced = text.toString();
  let composing = false;
  let applying = false;
  let missed: Delta[] = [];
  let selection:
    | {
        start: Y.RelativePosition;
        end: Y.RelativePosition;
        direction: HTMLTextAreaElement["selectionDirection"];
      }
    | undefined;
  input.value = synced;
  onValue(synced);

  function resolve(position: Y.RelativePosition) {
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      position,
      doc,
    );
    return absolute && absolute.type === text ? absolute.index : undefined;
  }

  function render(caret?: number) {
    const next = (text as Y.Text).toString();
    synced = next;
    if (input.value === next) return;
    const start = caret ?? (selection && resolve(selection.start));
    const end = caret ?? (selection && resolve(selection.end));
    input.value = next;
    if (start !== undefined && end !== undefined)
      input.setSelectionRange(
        start,
        Math.max(start, end),
        selection?.direction,
      );
    onValue(next);
  }

  function commit() {
    let change = diffText(synced, input.value, input.selectionEnd);
    for (const delta of missed) change = rebaseChange(change, delta);
    missed = [];
    let applied = false;
    applying = true;
    try {
      applied = editNodeText(
        doc,
        id,
        change.index,
        change.deleteCount,
        change.insert,
      );
    } catch {
      // A rejected edit, such as one over the length limit, is discarded.
    } finally {
      applying = false;
    }
    render(change.index + (applied ? change.insert.length : 0));
  }

  // Captured before each transaction changes the text, while the textarea and
  // the shared text still agree. Collapsed carets stay before remote insertions.
  const capture = () => {
    if (composing || input.value !== synced) return;
    const collapsed = input.selectionStart === input.selectionEnd;
    selection = {
      start: Y.createRelativePositionFromTypeIndex(
        text,
        input.selectionStart,
        collapsed ? -1 : 0,
      ),
      end: Y.createRelativePositionFromTypeIndex(text, input.selectionEnd, -1),
      direction: input.selectionDirection,
    };
  };
  const observe = (event: Y.YTextEvent) => {
    if (composing) missed.push(event.delta as Delta);
    else if (!applying) render();
  };
  const onInput = (event: Event) => {
    if (!composing && !(event as InputEvent).isComposing) commit();
    onValue(input.value);
  };
  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = () => {
    composing = false;
    commit();
    onValue(input.value);
  };

  doc.on("beforeTransaction", capture);
  text.observe(observe);
  input.addEventListener("input", onInput);
  input.addEventListener("compositionstart", onCompositionStart);
  input.addEventListener("compositionend", onCompositionEnd);
  return () => {
    doc.off("beforeTransaction", capture);
    text.unobserve(observe);
    input.removeEventListener("input", onInput);
    input.removeEventListener("compositionstart", onCompositionStart);
    input.removeEventListener("compositionend", onCompositionEnd);
    composing = false;
    if (input.value !== synced || missed.length) commit();
  };
}
