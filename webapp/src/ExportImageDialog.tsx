import {
  createMutation,
  createQuery,
  keepPreviousData,
  queryOptions,
  useQueryClient,
} from "@tanstack/solid-query";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { Dialog } from "./Dialog";
import type { MapImageFormat, MapImageOptions, MapPng } from "./map-image";
import { mapPng, mapSvg, pngScale } from "./map-image";
import { writeImageFile } from "./project-import-export";
import { press } from "./press";

export type MapImageScope = "map" | "branch";

const SCALES = [1, 2, 3];

const cancelled = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

// Drawing failed, as opposed to saving or copying what was drawn.
class DrawingError extends Error {}
const drawing = <T,>(work: Promise<T>) =>
  work.catch((error: unknown) => {
    throw new DrawingError(
      error instanceof Error ? error.message : String(error),
    );
  });

// Saves the map, or one branch of it, as a picture: a preview of exactly the
// PNG that is saved or copied, with the choices that change it.
export function ExportImageDialog(props: {
  open: boolean;
  onClose: () => void;
  // The map's name, for the file.
  name: string;
  // The copy of the map the picture is drawn from, while open.
  scene: HTMLElement | undefined;
  // Changes whenever the scene draws differently.
  signature: string;
  // The scene's size in map points.
  width: number;
  height: number;
  scope: MapImageScope;
  onScope: (scope: MapImageScope) => void;
  // The selected idea's text, when it has a branch to show on its own.
  branch?: string;
  onExported?: (format: MapImageFormat | "clipboard") => void;
}) {
  const queryClient = useQueryClient();
  const [background, setBackground] = createSignal(true);
  const [scale, setScale] = createSignal(2);
  const options = (): MapImageOptions => ({
    background: background(),
    scale: scale(),
  });
  // The scene as it is when the picture is drawn; one closed over earlier may
  // have been replaced.
  const scene = () => {
    const element = props.scene;
    if (!element?.isConnected) throw new Error("The map isn’t ready yet.");
    return element;
  };
  // Counts the scene's changes. A picture is drawn from the live scene, so
  // one asked for a scene that has since changed is dropped rather than kept
  // under the wrong choices (the query for the new ones draws it), and one
  // the scene changed under while it was drawn is drawn again.
  let changes = 0;
  createEffect(
    on(
      () => props.signature,
      () => changes++,
    ),
  );
  const drawn = async <T,>(
    signature: string,
    draw: (scene: HTMLElement) => Promise<T>,
  ) => {
    for (;;) {
      // After the fonts, and after Solid has put a just-opened scene in place.
      await document.fonts.ready;
      if (props.signature !== signature)
        throw new Error("The map changed while drawing.");
      const before = changes;
      const result = await draw(scene());
      if (changes === before) return result;
    }
  };
  const png = (settings: MapImageOptions, signature = props.signature) =>
    queryOptions({
      queryKey: [
        "map-image",
        "png",
        signature,
        settings.background,
        settings.scale,
      ],
      queryFn: () => drawn(signature, (scene) => mapPng(scene, settings)),
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: 30_000,
      retry: false,
    });
  const empty = () => !props.width || !props.height;
  const preview = createQuery(() => ({
    ...png(options()),
    enabled: props.open && !!props.scene && !empty(),
    placeholderData: keepPreviousData,
  }));
  const previewUrl = createMemo(() => {
    // Reading data before there is any suspends the router's boundary, which
    // takes the whole map, this scene included, out of the page meanwhile.
    // Nothing is kept for a closed dialog or an empty map.
    const blob =
      props.open && !empty() && preview.status === "success"
        ? preview.data?.blob
        : undefined;
    if (!blob) return undefined;
    const url = URL.createObjectURL(blob);
    onCleanup(() => URL.revokeObjectURL(url));
    return url;
  });
  const image = () =>
    drawing(queryClient.fetchQuery(png(options()))).then(({ blob }) => blob);

  const save = createMutation(() => ({
    mutationKey: ["map-image", "save"],
    mutationFn: async (format: MapImageFormat) => {
      const settings = options();
      try {
        await writeImageFile(
          props.name,
          format,
          format === "png"
            ? image()
            : drawing(
                drawn(props.signature, (scene) => mapSvg(scene, settings)),
              ),
        );
      } catch (error) {
        if (cancelled(error)) return false;
        throw error;
      }
      return true;
    },
    onSuccess: (saved, format) => {
      if (saved) props.onExported?.(format);
    },
  }));
  // The clipboard takes the picture while it renders, so the press that asked
  // for the copy still counts once it is ready.
  const copy = createMutation(() => ({
    mutationKey: ["map-image", "copy"],
    mutationFn: () =>
      navigator.clipboard.write([new ClipboardItem({ "image/png": image() })]),
    onSuccess: () => props.onExported?.("clipboard"),
  }));
  // What a finished copy or save reported belongs to the picture it was made
  // from, so new choices clear it. One still running stays watched, so its
  // outcome is still reported and a second press still waits for it. (`on`
  // reads `isPending` untracked: finishing doesn't clear its own outcome.)
  createEffect(
    on([() => props.open, () => props.signature, options], () => {
      if (!copy.isPending) copy.reset();
      if (!save.isPending) save.reset();
    }),
  );

  // The PNG's size: the drawn one's, or what it should come to.
  const size = () => {
    const drawn: MapPng | undefined =
      preview.status === "success" && !preview.isPlaceholderData
        ? preview.data
        : undefined;
    const pixels = pngScale(props.width, props.height, scale());
    const [width, height] = drawn
      ? [drawn.width, drawn.height]
      : [Math.floor(props.width * pixels), Math.floor(props.height * pixels)];
    const reduced = width < Math.floor(props.width * scale());
    return `${width} × ${height} px${reduced ? " (reduced to fit)" : ""}`;
  };
  const error = () => {
    const failure = save.error ?? copy.error ?? preview.error;
    if (!failure) return "";
    const reason = failure instanceof Error ? failure.message : "";
    if (failure === preview.error || failure instanceof DrawingError)
      return reason
        ? `Couldn’t make the image: ${reason}`
        : "Couldn’t make the image. Please retry.";
    if (failure === copy.error)
      return "Couldn’t copy the image. Your browser may not allow it here; save it as a file instead.";
    return reason
      ? `Couldn’t save the image: ${reason}`
      : "Couldn’t save the image. Please retry.";
  };

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="Export image"
      closeLabel="Close image export"
      variant="center"
    >
      <div class="flex min-h-0 flex-col gap-5 overflow-y-auto px-6 pt-5 pb-6">
        <figure
          class="image-preview"
          data-transparent={background() ? undefined : ""}
          aria-busy={preview.isFetching}
        >
          <Show
            when={previewUrl()}
            fallback={
              <p class="text-sm text-stone-500">
                {empty()
                  ? "Nothing to export yet. Add an idea first."
                  : preview.isError
                    ? "No preview"
                    : "Drawing the map…"}
              </p>
            }
          >
            {(url) => (
              <img
                src={url()}
                alt={`Preview of ${props.scope === "branch" ? "the branch" : "the map"}`}
                class="max-h-full max-w-full object-contain"
                classList={{ "opacity-60": preview.isPlaceholderData }}
              />
            )}
          </Show>
        </figure>
        <div class="grid gap-4 sm:grid-cols-3">
          <fieldset>
            <legend class="style-label">Include</legend>
            <div class="style-segments">
              <button
                type="button"
                class="style-segment"
                aria-pressed={props.scope === "map"}
                {...press(() => props.onScope("map"))}
              >
                Whole map
              </button>
              <button
                type="button"
                class="style-segment"
                aria-pressed={props.scope === "branch"}
                disabled={!props.branch}
                title={
                  props.branch
                    ? `“${props.branch}” and the ideas under it`
                    : "Select an idea to export its branch"
                }
                {...press(() => props.onScope("branch"))}
              >
                Branch
              </button>
            </div>
          </fieldset>
          <fieldset>
            <legend class="style-label">Background</legend>
            <div class="style-segments">
              <button
                type="button"
                class="style-segment"
                aria-pressed={background()}
                {...press(() => setBackground(true))}
              >
                Paper
              </button>
              <button
                type="button"
                class="style-segment"
                aria-pressed={!background()}
                {...press(() => setBackground(false))}
              >
                Transparent
              </button>
            </div>
          </fieldset>
          <fieldset>
            <legend class="style-label">PNG scale · {size()}</legend>
            <div class="style-segments grid-cols-3!">
              <For each={SCALES}>
                {(value) => (
                  <button
                    type="button"
                    class="style-segment"
                    aria-pressed={scale() === value}
                    title={`${value} pixel${value === 1 ? "" : "s"} per point; sharper on high-density screens`}
                    {...press(() => setScale(value))}
                  >
                    {value}×
                  </button>
                )}
              </For>
            </div>
          </fieldset>
        </div>
        <Show when={error()}>
          <p role="alert" class="text-sm text-red-700">
            {error()}
          </p>
        </Show>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <p role="status" class="mr-auto text-sm text-stone-600">
            {copy.isSuccess ? "Copied to the clipboard" : ""}
          </p>
          <button
            type="button"
            class="map-control outlined"
            disabled={empty()}
            // Not disabled while it works, so it keeps the keyboard focus.
            aria-disabled={copy.isPending}
            {...press(() => {
              if (!copy.isPending) copy.mutate();
            })}
          >
            Copy to clipboard
          </button>
          <button
            type="button"
            class="map-control outlined"
            disabled={empty()}
            aria-disabled={save.isPending}
            title="A vector image that stays sharp at any size"
            {...press(() => {
              if (!save.isPending) save.mutate("svg");
            })}
          >
            SVG
          </button>
          <button
            type="button"
            class="primary-button"
            disabled={empty()}
            aria-disabled={save.isPending}
            {...press(() => {
              if (!save.isPending) save.mutate("png");
            })}
          >
            PNG
          </button>
        </div>
      </div>
    </Dialog>
  );
}
