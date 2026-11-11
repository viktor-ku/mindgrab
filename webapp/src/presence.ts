import { type Accessor, createEffect, createSignal, on } from "solid-js";

// Keeps a panel mounted after `open` turns false, until its exit animation
// has played. While closing, the element gets `data-closing`, which CSS
// animates, and `inert`, so it no longer takes presses or focus; focus inside
// it goes back through `restoreFocus`. Without an animation (reduced motion)
// it unmounts at once; reopening while closing keeps it.
export function createPresence(
  open: Accessor<boolean>,
  options: { restoreFocus: () => void },
) {
  const [mounted, setMounted] = createSignal(open());
  let element: HTMLElement | undefined;
  createEffect(
    on(
      open,
      (now) => {
        const el = element?.isConnected ? element : undefined;
        if (now) {
          el?.removeAttribute("data-closing");
          if (el) el.inert = false;
          setMounted(true);
          return;
        }
        if (!el) return setMounted(false);
        const hadFocus = el.contains(document.activeElement);
        el.setAttribute("data-closing", "");
        el.inert = true;
        if (hadFocus) options.restoreFocus();
        void Promise.allSettled(
          el.getAnimations().map((animation) => animation.finished),
        ).then(() => {
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
    },
  };
}
