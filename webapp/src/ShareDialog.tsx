import {
  createMutation,
  createQuery,
  useQueryClient,
} from "@tanstack/solid-query";
import { createEffect, on, Show } from "solid-js";
import { Dialog } from "./Dialog";
import { LoroApi, SyncError } from "./loro-api";
import { shareUrl } from "./shared-project";
import { MOD_LABEL } from "./ShortcutsDialog";

// One view-only link per project. The link only exists in Mindgrab Cloud, so
// sharing needs an account and cloud saving.
export function ShareDialog(props: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  // The signed-in account, if any.
  ownerId?: number;
  cloud: boolean;
  onOpenPreferences: () => void;
  onShared?: (enabled: boolean) => void;
}) {
  let linkField: HTMLInputElement | undefined;
  const queryClient = useQueryClient();
  // The link is selected before the clipboard write, so it can always be
  // copied by hand, even when the browser denies or holds the write.
  const copy = createMutation(() => ({
    mutationKey: ["share-link", "copy"],
    mutationFn: async (value: string) => {
      linkField?.focus();
      linkField?.select();
      await navigator.clipboard.writeText(value);
    },
  }));
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) copy.reset();
      },
    ),
  );
  const api = () =>
    new LoroApi(undefined, undefined, props.ownerId, queryClient);
  const key = () => ["share-link", props.ownerId ?? null, props.projectId];
  const available = () => !!props.ownerId && props.cloud;
  const link = createQuery(() => ({
    queryKey: key(),
    enabled: props.open && available(),
    queryFn: ({ signal }) => api().shareLink(props.projectId, signal),
    retry: false,
    gcTime: 0,
  }));
  const toggle = createMutation(() => ({
    mutationKey: ["share-link", "set", props.projectId],
    mutationFn: (enabled: boolean) =>
      api().setShareLink(
        props.projectId,
        enabled,
        new AbortController().signal,
      ),
    onSuccess: (token, enabled) => {
      queryClient.setQueryData(key(), token);
      copy.reset();
      props.onShared?.(enabled);
    },
  }));
  const token = () => link.data ?? undefined;
  const url = () => {
    const value = token();
    return value ? shareUrl(value) : "";
  };
  const busy = () => link.isFetching || toggle.isPending;
  const error = () => {
    const failure = toggle.error ?? link.error;
    if (!failure) return "";
    if (failure instanceof SyncError && failure.kind === "auth")
      return "Sign in again to manage this link.";
    if (failure instanceof SyncError && failure.code === "project_not_found")
      return "This project hasn’t reached Mindgrab Cloud yet. Wait for the green save dot, then retry.";
    return "Could not reach Mindgrab Cloud. Retry in a moment.";
  };

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="Share"
      closeLabel="Close sharing"
      variant="side"
    >
      <Show
        when={available()}
        fallback={
          <div class="my-6 text-sm leading-6 text-stone-600">
            <Show
              when={props.ownerId}
              fallback={
                <p>
                  Sign in to share this project. Shared projects live in
                  Mindgrab Cloud.
                </p>
              }
            >
              <p>
                Turn on “Save in Mindgrab Cloud” to share this project. Shared
                projects live in Mindgrab Cloud.
              </p>
              <button
                type="button"
                class="map-control mt-2 -ml-2.5 text-accent-deep"
                onClick={props.onOpenPreferences}
              >
                Open project preferences
              </button>
            </Show>
          </div>
        }
      >
        <div class="my-6 flex items-start justify-between gap-5">
          <div>
            <p id="share-link-label" class="font-medium">
              Anyone with the link can view
            </p>
            <p
              id="share-link-description"
              class="mt-1 text-sm leading-5 text-stone-500"
            >
              People who open the link see this map and its notes, and changes
              you make appear for them. They can’t edit it and don’t need an
              account.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={!!token()}
            aria-labelledby="share-link-label"
            aria-describedby="share-link-description"
            class="saving-switch"
            disabled={busy() || link.isError}
            onClick={() => toggle.mutate(!token())}
          >
            <span>{token() ? "On" : "Off"}</span>
          </button>
        </div>
        <Show when={url()}>
          <div class="flex items-center gap-2">
            <input
              ref={linkField}
              type="text"
              readOnly
              aria-label="Share link"
              class="search-field min-w-0 flex-1 rounded-md bg-stone-100 px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
              value={url()}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              class="map-control bg-accent-soft text-accent-deep"
              onClick={() => copy.mutate(url())}
            >
              {copy.isSuccess ? "Copied" : "Copy link"}
            </button>
          </div>
          <Show when={copy.isError}>
            <p role="status" class="mt-2 text-sm text-stone-600">
              Couldn’t copy automatically. The link is selected; press{" "}
              {MOD_LABEL}C to copy it.
            </p>
          </Show>
          <p class="mt-4 text-sm leading-6 text-stone-500">
            Turning the link off stops it working. Turning it on again creates a
            new link.
          </p>
        </Show>
        <p role="status" class="mt-4 text-sm text-stone-600">
          {toggle.isPending
            ? "Updating the link…"
            : link.isPending && link.isFetching
              ? "Checking the link…"
              : ""}
        </p>
        <Show when={error()}>
          <p role="alert" class="mt-3 text-sm text-red-700">
            {error()}
          </p>
          <button
            type="button"
            class="map-control mt-2 -ml-2.5"
            disabled={busy()}
            onClick={() => {
              toggle.reset();
              void link.refetch();
            }}
          >
            Retry
          </button>
        </Show>
      </Show>
    </Dialog>
  );
}
