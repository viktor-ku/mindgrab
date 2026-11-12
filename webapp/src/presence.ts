import { type Accessor, createEffect, createSignal, on } from "solid-js";

// Keeps a panel mounted after `open` turns false, until its exit animation
// has played. While it closes, `closing` is true: the panel renders it as
// `data-closing`, which CSS animates, and as `inert`, so it no longer takes
// presses or focus. Focus inside it first goes back through `restoreFocus`.
// Without an animation (reduced motion) it unmounts at once; reopening while
// closing keeps it.
export function createPresence(
  open: Accessor<boolean>,
  options: { restoreFocus: () => void },
) {
  const [mounted, setMounted] = createSignal(open());
  const [closing, setClosing] = createSignal(false);
  let element: HTMLElement | undefined;
  createEffect(
    on(
      open,
      (now) => {
        if (now) {
          setClosing(false);
          setMounted(true);
          return;
        }
        const el = element;
        if (!el?.isConnected) return setMounted(false);
        if (el.contains(document.activeElement)) options.restoreFocus();
        setClosing(true);
        // Once the closing state is on screen, its animation is running.
        queueMicrotask(() =>
          Promise.allSettled(
            el.getAnimations().map((animation) => animation.finished),
          ).then(() => {
            if (open()) return;
            setClosing(false);
            setMounted(false);
          }),
        );
      },
      { defer: true },
    ),
  );
  return {
    mounted,
    closing,
    ref: (el: HTMLElement) => {
      element = el;
    },
  };
}
