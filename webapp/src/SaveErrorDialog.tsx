import { For, Show } from "solid-js";
import { Dialog } from "./Dialog";

// What the red save dot opens: why saving failed and how to act on it.
export function SaveErrorDialog(props: {
  open: boolean;
  onClose: () => void;
  problems: string[];
  safeInBrowser: boolean;
  retryingAlone: boolean;
  onRetryLocal?: () => void;
  onRetryCloud?: () => void;
}) {
  return (
    <Dialog
      variant="center"
      size="small"
      open={props.open}
      onClose={props.onClose}
      title="Couldn’t save"
      closeLabel="Close save error"
    >
      <Show when={props.open}>
        <div class="flex flex-col gap-2 px-6 pt-4 pb-6 text-sm leading-6 text-stone-600">
          <For each={props.problems}>{(problem) => <p>{problem}</p>}</For>
          <Show when={props.safeInBrowser}>
            <p>Your map is still saved in this browser.</p>
          </Show>
          <Show when={props.retryingAlone}>
            <p class="text-xs text-stone-500">
              Saving keeps retrying on its own.
            </p>
          </Show>
          <div class="mt-2 flex flex-wrap gap-2 empty:hidden">
            <Show when={props.onRetryLocal}>
              {(retry) => (
                <button type="button" class="primary-button" onClick={retry()}>
                  Retry local saving
                </button>
              )}
            </Show>
            <Show when={props.onRetryCloud}>
              {(retry) => (
                // One primary action: beside the local retry this one steps
                // back and says what it retries.
                <button
                  type="button"
                  class={
                    props.onRetryLocal
                      ? "map-control outlined"
                      : "primary-button"
                  }
                  onClick={retry()}
                >
                  {props.onRetryLocal ? "Retry cloud saving" : "Retry"}
                </button>
              )}
            </Show>
          </div>
        </div>
      </Show>
    </Dialog>
  );
}
