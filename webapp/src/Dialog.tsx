import { createEffect, createUniqueId, type JSX, Show } from "solid-js";
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
  // slides in from the right, pads its content and scrolls as a whole. "panel"
  // does the same from the left, under the phone menu button.
  variant: "center" | "side" | "panel";
  size?: "small";
  // Replaces the visible title, which then only names the dialog.
  heading?: JSX.Element;
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
      class={`dialog-${props.variant}`}
      data-size={props.size}
      aria-labelledby={props.heading ? undefined : titleId}
      aria-label={props.heading ? props.title : undefined}
      data-no-pan
      onClose={props.onClose}
      onCancel={props.onClose}
      {...backdropDismiss(() => props.onClose())}
    >
      <header
        class={`flex items-center justify-between gap-4 border-b border-stone-100 ${
          { center: "px-6 py-4", side: "pb-4", panel: "gap-1! border-b-0!" }[
            props.variant
          ]
        }`}
      >
        <Show
          when={props.heading}
          fallback={
            <h2 id={titleId} class="font-display text-xl font-semibold">
              {props.title}
            </h2>
          }
        >
          {props.heading}
        </Show>
        <button
          type="button"
          class="icon-button"
          // A panel opens with its heading input first; focusing that would
          // raise the phone keyboard.
          autofocus={props.variant === "panel"}
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
