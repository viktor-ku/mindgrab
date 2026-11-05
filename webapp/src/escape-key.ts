import { makeEventListener } from "@solid-primitives/event-listener";

// Closes a panel, menu or popover when Esc is pressed inside it. The key stops
// here, so the layers behind it keep their state: closing a menu does not also
// clear the selection.
//
// Solid delegates `onKeyDown` to the document, so this listener runs before any
// `onKeyDown` inside the element. A nested layer with its own Esc behavior must
// use closeOnEscape too.
//
// This looks at each event on purpose. `createShortcut` from
// @solid-primitives/keyboard tracks held keys and pairs keydown with keyup by
// `e.key`: release Shift before 1 and "!" stays held, and Esc stops matching.
export function closeOnEscape(element: HTMLElement, close: () => void) {
  makeEventListener(element, "keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  });
}
