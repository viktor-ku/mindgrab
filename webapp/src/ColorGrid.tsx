import { createSignal, For, Show } from "solid-js";
import {
  COLOR_FAMILIES,
  COLOR_SHADES,
  colorLabel,
  shadeValue,
} from "./node-colors";
import type { NodeColor } from "./node-colors";
import { press } from "./press";
import { TAILWIND_PALETTE } from "./tailwind-palette";

const capitalize = (text: string) => text[0].toUpperCase() + text.slice(1);

// Every color a person can choose: the white card on its own row, then
// Tailwind's palette, a row per hue, lightest shade first, the greys last.
// Arrow keys move through it as a grid, so it is one tab stop.
export function ColorGrid(props: {
  label: string;
  // Shows as pressed: the idea's color, the new-idea color.
  pressed: (color: NodeColor) => boolean;
  // Shows a dot: colors that are quick colors.
  marked?: (color: NodeColor) => boolean;
  // Hue names down the side and shade numbers across the top.
  labeled?: boolean;
  // For a central idea, on which the white card is the dark default.
  root?: boolean;
  onPress: (color: NodeColor, event: MouseEvent) => void;
  // The color pointed at or reached from the keyboard, then undefined.
  onPoint?: (color: NodeColor | undefined) => void;
  // The button's tooltip, which says what pressing it does.
  title: (color: NodeColor) => string;
  ref?: (element: HTMLElement) => void;
}) {
  const columns = COLOR_SHADES.length;
  const colors = [
    "slate" as NodeColor,
    ...COLOR_FAMILIES.flatMap((family) =>
      COLOR_SHADES.map((shade) => `${family}-${shade}` as NodeColor),
    ),
  ];
  // One tab stop: the cell that has focus, else the first pressed color,
  // else white.
  const [focused, setFocused] = createSignal<NodeColor>();
  const stop = () =>
    focused() ?? colors.find((color) => props.pressed(color)) ?? "slate";
  let grid!: HTMLElement;

  // White sits above the first row: Down from it starts the palette, Up from
  // the first row returns to it.
  function move(e: KeyboardEvent) {
    const buttons = Array.from(grid.querySelectorAll("button"));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const cell = index - 1;
    const row = cell - (cell % columns);
    const next =
      index === 0
        ? e.key === "ArrowDown" || e.key === "ArrowRight"
          ? 1
          : ["ArrowUp", "ArrowLeft", "Home", "End"].includes(e.key)
            ? 0
            : undefined
        : e.key === "Home"
          ? row + 1
          : e.key === "End"
            ? row + columns
            : e.key === "ArrowLeft"
              ? index - 1
              : e.key === "ArrowRight"
                ? index + 1
                : e.key === "ArrowUp"
                  ? cell < columns
                    ? 0
                    : index - columns
                  : e.key === "ArrowDown"
                    ? index + columns
                    : undefined;
    if (next === undefined) return;
    e.preventDefault();
    // A move off the end of the grid stays where it is.
    buttons[next]?.focus();
  }

  const button = (color: NodeColor, fill?: string, ink = "black") => (
    <button
      type="button"
      class={fill ? "color-cell" : "color-cell color-cell-white"}
      aria-label={colorLabel(color, props.root)}
      aria-pressed={props.pressed(color)}
      title={props.title(color)}
      tabIndex={color === stop() ? 0 : -1}
      style={
        fill
          ? { background: fill }
          : props.root
            ? { background: "var(--color-slate-800)", color: "white" }
            : undefined
      }
      onPointerEnter={() => props.onPoint?.(color)}
      onFocus={(e) => {
        setFocused(color);
        if (e.currentTarget.matches(":focus-visible")) props.onPoint?.(color);
      }}
      onBlur={() => props.onPoint?.(undefined)}
      {...press((e) => props.onPress(color, e))}
    >
      <Show when={!fill}>{colorLabel(color, props.root)}</Show>
      {/* The dot takes the color text would on that fill, so it always shows. */}
      <Show when={props.marked?.(color)}>
        <span
          aria-hidden="true"
          class="color-cell-dot"
          style={{ background: ink }}
        />
      </Show>
    </button>
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Arrow keys move focus between the buttons inside, and leaving the grid ends the preview; the buttons are the controls.
    <fieldset
      ref={(el) => {
        grid = el;
        props.ref?.(el);
      }}
      class="color-grid"
      classList={{ "color-grid-labeled": props.labeled }}
      onKeyDown={move}
      onFocusOut={(e) => {
        // Focus gone from the grid, the tab stop is the pressed color again.
        if (!grid.contains(e.relatedTarget as Node | null))
          setFocused(undefined);
      }}
      onPointerLeave={() => props.onPoint?.(undefined)}
    >
      <legend class="sr-only">{props.label}</legend>
      <Show when={props.labeled}>
        <span aria-hidden="true" />
        <For each={COLOR_SHADES}>
          {(shade) => (
            <span aria-hidden="true" class="color-grid-shade">
              {shade}
            </span>
          )}
        </For>
        <span aria-hidden="true" />
      </Show>
      {button("slate")}
      <For each={COLOR_FAMILIES}>
        {(family) => (
          <>
            <Show when={props.labeled}>
              <span aria-hidden="true" class="color-grid-hue">
                {capitalize(family)}
              </span>
            </Show>
            <For each={COLOR_SHADES}>
              {(shade) =>
                button(
                  `${family}-${shade}` as NodeColor,
                  shadeValue(family, shade),
                  TAILWIND_PALETTE[family][shade].text,
                )
              }
            </For>
          </>
        )}
      </For>
    </fieldset>
  );
}
