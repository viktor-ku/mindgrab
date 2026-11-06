import { makeEventListener } from "@solid-primitives/event-listener";
import { closeOnEscape } from "./escape-key";

// The one contract for menus and popovers: the project menu, the account menu,
// the idea menu and the color popover. Call it from the layer's `ref`.
//
// - A press outside the layer closes it. A press on its trigger is left to the
//   trigger's own click, which toggles.
// - Esc closes it wherever focus is (inside, on the trigger or on the canvas)
//   and goes no further, so the selection behind it stays. Focus returns to
//   the trigger, or to `returnFocus` for a layer opened some other way.
// - Focus moving to another tab stop closes it, like a native menu. The canvas
//   is focusable but not a tab stop, and it takes focus from any press on
//   plain content (in Safari from a press on a button too), so it never counts
//   as leaving.
// - The layer is focusable itself, so a press on its padding, a divider or its
//   text keeps focus inside instead of handing it to the canvas.
export function transientLayer(
  element: HTMLElement,
  options: {
    trigger: () => HTMLElement | null | undefined;
    close: () => void;
    returnFocus?: () => HTMLElement | null | undefined;
  },
) {
  const outside = (target: EventTarget | null) =>
    !(target instanceof Node) ||
    !(element.contains(target) || options.trigger()?.contains(target));
  const dismiss = () => {
    const back = options.returnFocus?.() ?? options.trigger();
    options.close();
    back?.focus({ preventScroll: true });
  };
  element.tabIndex = -1;
  closeOnEscape(element, dismiss);
  // Esc pressed outside the layer. Anything nearer the key that handles Esc
  // itself stopped it before it got here; a text field keeps its own Esc.
  makeEventListener(document, "keydown", (e) => {
    if (
      e.key !== "Escape" ||
      e.defaultPrevented ||
      (e.target instanceof Element &&
        e.target.closest("textarea, input, [contenteditable=true]"))
    )
      return;
    e.preventDefault();
    e.stopPropagation();
    dismiss();
  });
  makeEventListener(window, "pointerdown", (e) => {
    if (outside(e.target)) options.close();
  });
  makeEventListener(document, "focusin", (e) => {
    const next = e.target;
    if (next instanceof HTMLElement && next.tabIndex >= 0 && outside(next))
      options.close();
  });
}

// Arrow keys, Home and End move between a menu's items. From the menu itself
// (after a press on its padding) Down starts at the first item and Up at the
// last.
export function menuArrowKeys(
  e: KeyboardEvent & { currentTarget: HTMLElement },
) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  const items = Array.from(
    e.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    ),
  );
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const last = items.length - 1;
  const next =
    e.key === "Home" || (current < 0 && e.key === "ArrowDown")
      ? 0
      : e.key === "End" || (current < 0 && e.key === "ArrowUp")
        ? last
        : (current + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
          items.length;
  items[next]?.focus();
}

// Whether a key was pressed in an open menu or on the button that opened it.
// An open menu owns the keyboard, and the account menu keeps its open state to
// itself, so the map asks the event.
export const inOpenMenu = (target: EventTarget | null) =>
  target instanceof Element &&
  !!target.closest(
    '[role="menu"], [aria-haspopup="menu"][aria-expanded="true"]',
  );
