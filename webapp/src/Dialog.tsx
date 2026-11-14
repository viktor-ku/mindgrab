import {
  createEffect,
  createUniqueId,
  type JSX,
  onCleanup,
  Show,
} from "solid-js";
import { backdropDismiss } from "./dialog-backdrop";
import { CloseIcon } from "./icons";
import { press } from "./press";

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
  // "large" gives "center" a fixed height, as a settings window with room for
  // sections, so switching what it shows does not resize it.
  size?: "small" | "large";
  // Replaces the visible title, which then only names the dialog.
  heading?: JSX.Element;
  children: JSX.Element;
}) {
  let dialog!: HTMLDialogElement;
  const titleId = createUniqueId();
  // Shows the dialog modally while `open`. Taking a modal dialog out of the
  // page drops it from the top layer, though it stays open: the router puts
  // the app back in place as its first load settles, so a dialog opened from
  // the address on load would end up under the map. While open, it watches
  // for that and reopens on top. Dropping the attribute, unlike close(), does
  // not report a close.
  const sync = () => {
    if (!props.open) {
      if (dialog.open) dialog.close();
      return;
    }
    if (!dialog.isConnected || dialog.matches(":modal")) return;
    if (dialog.open) dialog.removeAttribute("open");
    dialog.showModal();
  };
  const moved = new MutationObserver(sync);
  createEffect(() => {
    sync();
    if (props.open)
      moved.observe(document.body, { childList: true, subtree: true });
    else moved.disconnect();
  });
  onCleanup(() => moved.disconnect());
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
          {
            center: "px-6 py-4",
            // Bleeds through the drawer's padding so the divider spans it.
            side: "-mx-7 -mt-7 px-7 py-4",
            panel: "gap-1! border-b-0!",
          }[props.variant]
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
          title={`${props.closeLabel} (Esc)`}
          {...press(props.onClose)}
        >
          <CloseIcon />
        </button>
      </header>
      {props.children}
    </dialog>
  );
}
