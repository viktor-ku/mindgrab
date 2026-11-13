import { createSignal, For, onCleanup, Show } from "solid-js";
import { ColorGrid } from "./ColorGrid";
import { PlusIcon } from "./icons";
import { colorLabel, isPickable, nodeLook } from "./node-colors";
import type { NodeColor } from "./node-colors";
import { press } from "./press";
import { transientLayer } from "./transient-layer";

export type ColorScope = "node" | "branch";

// Everything about how the selected idea looks. The quick colors are small
// copies of an idea card in that color, so each shows its fill, edge and text;
// the plus opens every color. Pointing at a color (or reaching it from the
// keyboard) previews it on the map, on the idea or the whole branch.
export function StylePanel(props: {
  color: NodeColor;
  // Central ideas take the strong fill of a named color, and so do their
  // swatches.
  root: boolean;
  // Ideas under the selected one; a branch of none is just the idea.
  descendants: number;
  scope: ColorScope;
  // The map's quick colors, in its order.
  quick: readonly NodeColor[];
  onScope: (scope: ColorScope, event: MouseEvent) => void;
  onPick: (color: NodeColor, event: MouseEvent) => void;
  onPreview: (color: NodeColor | undefined) => void;
  onAddQuick: (color: NodeColor) => void;
  onManage: () => void;
  // Every color opens inside the panel instead of beside it: on phones, and
  // where there is no room beside.
  palette?: "inline";
  class?: string;
  ref?: (element: HTMLElement) => void;
}) {
  onCleanup(() => props.onPreview(undefined));
  const scope = (): ColorScope => (props.descendants ? props.scope : "node");
  const target = () => (scope() === "node" ? "this idea" : "this branch");
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const custom = () => !props.quick.includes(props.color);
  let more!: HTMLButtonElement;

  // Read as it draws, so the chip follows the idea: its color, and whether
  // it is a central one.
  const chip = (color: () => NodeColor) => {
    const look = () => nodeLook(color(), props.root);
    return (
      <span
        aria-hidden="true"
        class={`style-chip ${props.root ? "style-chip-root " : ""}${look().class}`}
        style={look().style}
      >
        Aa
      </span>
    );
  };

  return (
    <section
      ref={props.ref}
      data-no-pan
      data-toolbar
      data-palette={props.palette}
      aria-label="Idea style"
      class={`map-toolbar style-panel pointer-events-auto cursor-default ${props.class ?? ""}`}
    >
      <fieldset class="style-section">
        <legend class="style-label">Apply to</legend>
        <div class="style-segments">
          <button
            type="button"
            class="style-segment"
            aria-pressed={scope() === "node"}
            {...press((e) => props.onScope("node", e))}
          >
            This idea
          </button>
          <button
            type="button"
            class="style-segment"
            aria-pressed={scope() === "branch"}
            disabled={!props.descendants}
            title={
              props.descendants
                ? `This idea and the ${props.descendants === 1 ? "idea" : `${props.descendants} ideas`} under it`
                : "Nothing under this idea yet"
            }
            {...press((e) => props.onScope("branch", e))}
          >
            This branch
          </button>
        </div>
      </fieldset>
      <fieldset class="style-section relative">
        <legend class="style-label">Color</legend>
        <button
          type="button"
          class="style-manage"
          title="Choose this map's quick colors"
          {...press(() => props.onManage())}
        >
          Manage
        </button>
        <div
          class="style-colors"
          onPointerLeave={() => props.onPreview(undefined)}
        >
          <For each={props.quick}>
            {(color) => (
              <button
                type="button"
                class="style-swatch"
                aria-label={colorLabel(color, props.root)}
                aria-pressed={props.color === color}
                title={`${colorLabel(color, props.root)} for ${target()}`}
                onPointerEnter={() => props.onPreview(color)}
                onFocus={(e) => {
                  if (e.currentTarget.matches(":focus-visible"))
                    props.onPreview(color);
                }}
                onBlur={() => props.onPreview(undefined)}
                {...press((e) => props.onPick(color, e))}
              >
                {chip(() => color)}
              </button>
            )}
          </For>
          <button
            ref={more}
            type="button"
            class="style-swatch"
            aria-label="Other color"
            aria-pressed={custom()}
            aria-expanded={paletteOpen()}
            title={
              custom()
                ? `Other color: ${colorLabel(props.color, props.root)}`
                : "Other color"
            }
            {...press(() => setPaletteOpen((open) => !open))}
          >
            <Show
              when={custom()}
              fallback={
                <span aria-hidden="true" class="style-chip style-chip-more">
                  <PlusIcon class="size-3.5" />
                </span>
              }
            >
              {chip(() => props.color)}
            </Show>
          </button>
        </div>
        <Show when={paletteOpen()}>
          <Palette
            color={props.color}
            root={props.root}
            quick={props.quick}
            target={target()}
            trigger={() => more}
            onClose={() => setPaletteOpen(false)}
            onPreview={props.onPreview}
            onPick={(color, e) => {
              setPaletteOpen(false);
              props.onPick(color, e);
              // Picked from the keyboard, focus goes back to the plus; a
              // press hands it to the map.
              if (e.detail === 0) more.focus({ preventScroll: true });
            }}
            onAddQuick={props.onAddQuick}
          />
        </Show>
      </fieldset>
    </section>
  );
}

// Every color, in a popover beside the panel (inside it on phones). The idea's
// own color, when it is not a quick color yet, can become one from here.
function Palette(props: {
  color: NodeColor;
  root: boolean;
  quick: readonly NodeColor[];
  target: string;
  trigger: () => HTMLElement;
  onClose: () => void;
  onPreview: (color: NodeColor | undefined) => void;
  onPick: (color: NodeColor, event: MouseEvent) => void;
  onAddQuick: (color: NodeColor) => void;
}) {
  // The color the head names: the one pointed at, else the idea's own.
  const [pointed, setPointed] = createSignal<NodeColor>();
  const named = () => {
    const color = pointed() ?? props.color;
    return isPickable(color) ? colorLabel(color, props.root) : "";
  };
  const addable = () =>
    isPickable(props.color) && !props.quick.includes(props.color);
  let grid!: HTMLElement;
  // However it closes, the color pointed at stops showing on the map.
  onCleanup(() => props.onPreview(undefined));
  const focusGrid = () =>
    grid
      .querySelector<HTMLButtonElement>('button[tabindex="0"]')
      ?.focus({ preventScroll: true });

  return (
    <section
      aria-label="Other colors"
      class="style-palette"
      ref={(el) => {
        transientLayer(el, { trigger: props.trigger, close: props.onClose });
        queueMicrotask(focusGrid);
      }}
    >
      <p class="style-palette-head">
        <span>Tailwind colors</span>
        <span class="text-stone-500 tabular-nums">{named()}</span>
      </p>
      <ColorGrid
        ref={(el) => {
          grid = el;
        }}
        label="Every color"
        pressed={(color) => color === props.color}
        onPress={props.onPick}
        onPoint={(color) => {
          setPointed(color);
          props.onPreview(color);
        }}
        root={props.root}
        title={(color) =>
          `${colorLabel(color, props.root)} for ${props.target}`
        }
      />
      <Show when={addable()}>
        <button
          type="button"
          class="style-add-quick"
          {...press(() => {
            props.onAddQuick(props.color);
            // This button goes away with the press.
            focusGrid();
          })}
        >
          <PlusIcon class="size-3.5" />
          Add {colorLabel(props.color, props.root)} to quick colors
        </button>
      </Show>
    </section>
  );
}
