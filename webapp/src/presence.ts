import { type Accessor, createEffect, createSignal, on } from "solid-js";

// Resolves once the element's own animations have played, at once when it has
// none (reduced motion), and also when one is cancelled.
const animated = (el: HTMLElement) =>
  Promise.allSettled(el.getAnimations().map((a) => a.finished));

// Keeps a panel mounted after `open` turns false, until its exit animation
// has played. While closing, the element gets `data-closing`, which CSS
// animates, and `inert`, so it no longer takes presses or focus; focus inside
// it goes back through `restoreFocus`. Reopening while closing keeps it.
// `onShown` runs once an opening has played.
export function createPresence(
  open: Accessor<boolean>,
  options: { restoreFocus: () => void; onShown?: () => void },
) {
  const [mounted, setMounted] = createSignal(open());
  let element: HTMLElement | undefined;
  // Once in the document, the opening animation has started.
  const shown = (el: HTMLElement) =>
    queueMicrotask(() =>
      animated(el).then(() => {
        if (open() && element === el) options.onShown?.();
      }),
    );
  createEffect(
    on(
      open,
      (now) => {
        const el = element?.isConnected ? element : undefined;
        if (now) {
          // Reopened while closing; a new element reports from its ref.
          if (el) {
            el.removeAttribute("data-closing");
            el.inert = false;
            shown(el);
          }
          setMounted(true);
          return;
        }
        if (!el) return setMounted(false);
        const hadFocus = el.contains(document.activeElement);
        el.setAttribute("data-closing", "");
        el.inert = true;
        if (hadFocus) options.restoreFocus();
        void animated(el).then(() => {
          if (!open()) setMounted(false);
        });
      },
      { defer: true },
    ),
  );
  return {
    mounted,
    ref: (el: HTMLElement) => {
      element = el;
      if (open()) shown(el);
    },
  };
}
