import type { JSX } from "solid-js";

type PressEvent<T extends HTMLElement> = MouseEvent & {
  currentTarget: T;
  target: Element;
};

// What a press focuses: the nearest of these around the pressed point.
const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex], [contenteditable]:not([contenteditable="false"])';

// Runs a control's action the moment the mouse button goes down, instead of
// on release like `onClick`. Spread it on the control:
// `<button {...press(() => …)}>`.
//
// - The main mouse button acts on `mousedown`; the click that follows is
//   skipped. Ctrl+press is left to the click: on a Mac it opens the context
//   menu instead.
// - Touch acts on the tap. Browsers send `mousedown` only after the finger
//   lifts, so a drag or scroll that starts on a control does not press it.
// - Enter and Space still reach the action through `click`, as does
//   `element.click()`.
// - Focus leaves before the action and goes to the control after it, as with
//   a click, unless the action took focus itself, even a microtask later:
//   into a menu it opens, or back to the map.
// - An action that stops its event from reaching the controls around it
//   stops the skipped click too, so a button inside a pressable row does not
//   press the row on release.
export function press<T extends HTMLElement = HTMLElement>(
  run: (e: PressEvent<T>) => void,
): {
  onMouseDown: JSX.EventHandler<T, MouseEvent>;
  onClick: JSX.EventHandler<T, MouseEvent>;
} {
  let pressed = false;
  let stopped = false;
  return {
    onMouseDown(e) {
      pressed =
        e.button === 0 && !e.ctrlKey && !e.currentTarget.matches(":disabled");
      if (!pressed) return;
      // The browser would focus the control once this handler returns and
      // take focus back from the action, so the press moves focus itself.
      e.preventDefault();
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
      run(e);
      stopped = e.cancelBubble;
      const target = e.target.closest<HTMLElement>(FOCUSABLE);
      queueMicrotask(() => {
        if (document.activeElement === document.body && target?.isConnected)
          target.focus({ preventScroll: true });
      });
    },
    onClick(e) {
      // A click with no pointer behind it (detail 0) comes from the keyboard
      // or from script, even right after a press that never released here.
      const handled = pressed && e.detail > 0;
      pressed = false;
      if (!handled) run(e);
      else if (stopped) e.stopPropagation();
    },
  };
}
