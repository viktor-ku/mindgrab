import { createEffect, createUniqueId, type JSX } from "solid-js";
import { backdropDismiss } from "./dialog-backdrop";
import { CloseIcon } from "./icons";

// A modal dialog with a title bar. `open` decides whether it shows: Esc, the
// close button and a click on the backdrop all go through `onClose`.
export function Dialog(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  // The close button's accessible name, such as "Close sharing".
  closeLabel: string;
  // "center" floats mid-screen and leaves the body to scroll itself. "side"
  // slides in from the right, pads its content and scrolls as a whole.
  variant: "center" | "side";
  size?: "small";
  children: JSX.Element;
}) {
  let dialog!: HTMLDialogElement;
  const titleId = createUniqueId();
  createEffect(() => {
    if (props.open && !dialog.open) dialog.showModal();
    else if (!props.open && dialog.open) dialog.close();
  });
  return (
    <dialog
      ref={dialog}
      class={props.variant === "side" ? "dialog-side" : "dialog-center"}
      data-size={props.size}
      aria-labelledby={titleId}
      data-no-pan
      onClose={props.onClose}
      onCancel={props.onClose}
      {...backdropDismiss(() => props.onClose())}
    >
      <header
        class={`flex items-center justify-between gap-4 border-b border-stone-100 ${
          props.variant === "side" ? "pb-4" : "px-6 py-4"
        }`}
      >
        <h2 id={titleId} class="font-display text-xl font-semibold">
          {props.title}
        </h2>
        <button
          type="button"
          class="icon-button"
          aria-label={props.closeLabel}
          onClick={props.onClose}
        >
          <CloseIcon />
        </button>
      </header>
      {props.children}
    </dialog>
  );
}
