import { makeEventListener } from "@solid-primitives/event-listener";
import { createSignal, For, Show } from "solid-js";
import { ColorGrid } from "./ColorGrid";
import { ChevronDownIcon, CloseIcon, PlusIcon } from "./icons";
import type { NodeColor } from "./node-colors";
import { colorLabel, lineLook, nodeLook } from "./node-colors";
import { press } from "./press";
import type { ColorPreferences } from "./project-document";
import { DEFAULT_COLOR_PREFERENCES } from "./project-document";
import { transientLayer } from "./transient-layer";

const moved = (list: readonly NodeColor[], from: number, to: number) => {
  const next = [...list];
  const [color] = next.splice(from, 1);
  next.splice(to, 0, color);
  return next;
};

// A small idea card in the color, as the style panel shows it.
function Chip(props: { color: NodeColor; class: string }) {
  const look = () => nodeLook(props.color, false);
  return (
    <span
      aria-hidden="true"
      class={`${props.class} ${look().class}`}
      style={look().style}
    >
      Aa
    </span>
  );
}

// The map's colors, in project preferences: the whole tab is the map, edited
// in place. The style panel's color row is there to drag into order, prune
// and add to; under it, a new idea in the color new ideas start with. Every
// color opens beside them only when asked for, to add quick colors or to
// choose the new idea's, without moving them. Pointing at a color shows on
// the map what pressing it would do.
export function ColorSettings(props: {
  colors: ColorPreferences;
  onChange: (value: ColorPreferences) => void;
}) {
  // Which choice every color is open for.
  const [picking, setPicking] = createSignal<"quick" | "new">();
  const [pointed, setPointed] = createSignal<NodeColor>();
  // The order while a quick color is being dragged; saved when it is dropped.
  const [dragOrder, setDragOrder] = createSignal<NodeColor[]>();
  const [dragging, setDragging] = createSignal<NodeColor>();
  const [status, setStatus] = createSignal("");
  const quick = () => dragOrder() ?? props.colors.quick;
  const inQuick = (color: NodeColor) => props.colors.quick.includes(color);
  const isDefault = () =>
    props.colors.quick.length === DEFAULT_COLOR_PREFERENCES.quick.length &&
    props.colors.quick.every(
      (color, index) => color === DEFAULT_COLOR_PREFERENCES.quick[index],
    );
  // What pointing at a color would do to the row or the new idea.
  const adding = () => {
    const color = pointed();
    return picking() === "quick" && color && !inQuick(color)
      ? color
      : undefined;
  };
  const removing = () => {
    const color = pointed();
    return picking() === "quick" && color && inQuick(color) ? color : undefined;
  };
  const newIdeas = () =>
    (picking() === "new" && pointed()) || props.colors.newIdeas;
  // A quick color that has the keyboard's focus, to say what its keys do.
  const [keyed, setKeyed] = createSignal(false);
  let map!: HTMLDivElement;
  let row!: HTMLOListElement;
  let add!: HTMLButtonElement;
  let newIdea!: HTMLButtonElement;

  const save = (next: NodeColor[]) =>
    props.onChange({ ...props.colors, quick: next });
  const focusPick = (color: NodeColor | undefined) =>
    queueMicrotask(() =>
      (color
        ? row.querySelector<HTMLButtonElement>(
            `[data-color="${color}"] .quick-pick`,
          )
        : add
      )?.focus(),
    );
  const close = () => {
    setPicking(undefined);
    setPointed(undefined);
  };
  // Opened from the keyboard, every color takes the keyboard's focus on the
  // color already chosen; opened by pointer, it takes focus without pointing
  // at anything, so no color looks chosen or about to be removed.
  let keyboardOpen = false;
  const toggle = (choice: "quick" | "new", event: MouseEvent) => {
    keyboardOpen = event.detail === 0;
    setPointed(undefined);
    setPicking((open) => (open === choice ? undefined : choice));
  };

  function remove(color: NodeColor) {
    const index = props.colors.quick.indexOf(color);
    const next = props.colors.quick.filter((pick) => pick !== color);
    save(next);
    setStatus(`Removed ${colorLabel(color)} from quick colors`);
    focusPick(next[Math.min(index, next.length - 1)]);
  }
  function move(color: NodeColor, by: number) {
    const from = props.colors.quick.indexOf(color);
    const to = Math.min(props.colors.quick.length - 1, Math.max(0, from + by));
    if (from === to) return;
    save(moved(props.colors.quick, from, to));
    setStatus(
      `Moved ${colorLabel(color)} to position ${to + 1} of ${props.colors.quick.length}`,
    );
    focusPick(color);
  }
  function choose(color: NodeColor, event: MouseEvent) {
    if (picking() === "new") {
      props.onChange({ ...props.colors, newIdeas: color });
      setStatus(`New ideas start as ${colorLabel(color)}`);
      close();
      // Chosen from the keyboard (a click with no pointer behind it), focus
      // goes back to where every color was opened from.
      if (event.detail === 0) newIdea.focus({ preventScroll: true });
    } else if (inQuick(color)) {
      save(props.colors.quick.filter((pick) => pick !== color));
      setStatus(`Removed ${colorLabel(color)} from quick colors`);
    } else {
      save([...props.colors.quick, color]);
      setStatus(`Added ${colorLabel(color)} to quick colors`);
    }
  }

  // Dragging a quick color: past a few pixels it follows the pointer, taking
  // the place of the one nearest to it, and drops where it was let go. The
  // window follows the pointer, not the color's button: reordering moves the
  // button in the page, which ends any capture it held.
  let drag:
    | { color: NodeColor; pointer: number; x: number; y: number }
    | undefined;
  function dragMove(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pointer) return;
    if (!dragging()) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
      setDragging(drag.color);
    }
    const items = Array.from(row.querySelectorAll<HTMLElement>("[data-color]"));
    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    items.forEach((item, index) => {
      const box = item.getBoundingClientRect();
      const distance = Math.hypot(
        e.clientX - (box.left + box.width / 2),
        e.clientY - (box.top + box.height / 2),
      );
      if (distance < best) {
        best = distance;
        nearest = index;
      }
    });
    const current = quick();
    const from = current.indexOf(drag.color);
    if (from !== nearest) setDragOrder(moved(current, from, nearest));
  }
  function dragEnd(e: PointerEvent, commit: boolean) {
    if (!drag || e.pointerId !== drag.pointer) return;
    const order = dragOrder();
    const color = drag?.color;
    drag = undefined;
    setDragging(undefined);
    setDragOrder(undefined);
    if (!commit || !order || !color) return;
    if (order.some((pick, index) => pick !== props.colors.quick[index])) {
      save(order);
      setStatus(
        `Moved ${colorLabel(color)} to position ${order.indexOf(color) + 1} of ${order.length}`,
      );
    }
  }
  makeEventListener(window, "pointermove", dragMove);
  makeEventListener(window, "pointerup", (e) => dragEnd(e, true));
  makeEventListener(window, "pointercancel", (e) => dragEnd(e, false));

  return (
    <div class="color-settings">
      <p class="color-settings-intro">
        What this map's style panel offers, for everyone who opens it.
      </p>
      <div ref={map} class="color-map">
        <div class="color-group">
          <section
            class="map-toolbar color-panel"
            aria-labelledby="quick-colors-title"
          >
            <div class="color-panel-head">
              <span class="style-label">Color</span>
              <Show when={!isDefault()}>
                <button
                  type="button"
                  class="style-manage"
                  {...press(() => {
                    save([...DEFAULT_COLOR_PREFERENCES.quick]);
                    setStatus("Restored the default quick colors");
                    // This button goes away with the press.
                    add.focus({ preventScroll: true });
                  })}
                >
                  Restore defaults
                </button>
              </Show>
            </div>
            <ol
              ref={row}
              class="quick-row"
              aria-labelledby="quick-colors-title"
            >
              <For each={quick()}>
                {(color, index) => (
                  <li
                    class="quick-item"
                    data-color={color}
                    data-dragging={dragging() === color ? "" : undefined}
                    data-removing={removing() === color ? "" : undefined}
                  >
                    <button
                      type="button"
                      class="quick-pick"
                      aria-label={`${colorLabel(color)}, ${index() + 1} of ${quick().length}`}
                      aria-describedby="quick-colors-keys"
                      title={`${colorLabel(color)}: drag to move`}
                      onPointerDown={(e) => {
                        if (e.button !== 0 || drag) return;
                        drag = {
                          color,
                          pointer: e.pointerId,
                          x: e.clientX,
                          y: e.clientY,
                        };
                      }}
                      onFocus={(e) =>
                        setKeyed(e.currentTarget.matches(":focus-visible"))
                      }
                      onBlur={() => setKeyed(false)}
                      onKeyDown={(e) => {
                        const back = ["ArrowLeft", "ArrowUp"].includes(e.key);
                        const on = ["ArrowRight", "ArrowDown"].includes(e.key);
                        if (e.altKey && (back || on)) {
                          e.preventDefault();
                          move(color, back ? -1 : 1);
                        } else if (
                          e.key === "Delete" ||
                          e.key === "Backspace"
                        ) {
                          e.preventDefault();
                          remove(color);
                        }
                      }}
                    >
                      <Chip color={color} class="quick-chip" />
                    </button>
                    <button
                      type="button"
                      class="color-badge quick-remove"
                      aria-label={`Remove ${colorLabel(color)}`}
                      title={`Remove ${colorLabel(color)}`}
                      {...press(() => remove(color))}
                    >
                      <CloseIcon class="size-2.5" />
                    </button>
                  </li>
                )}
              </For>
              <li class="quick-item">
                <button
                  ref={add}
                  type="button"
                  class="quick-add"
                  aria-label="Add quick colors"
                  aria-expanded={picking() === "quick"}
                  title="Add quick colors"
                  {...press((e) => toggle("quick", e))}
                >
                  {/* Pointing at a color shows it where it would land. */}
                  <Show
                    when={adding()}
                    fallback={
                      <span
                        aria-hidden="true"
                        class="quick-chip quick-chip-more"
                      >
                        <PlusIcon class="size-4" />
                      </span>
                    }
                  >
                    {(color) => (
                      <Chip
                        color={color()}
                        class="quick-chip quick-chip-ghost"
                      />
                    )}
                  </Show>
                </button>
              </li>
            </ol>
            <p id="quick-colors-keys" class="sr-only">
              Alt and the arrow keys move a color; Delete removes it.
            </p>
          </section>
          <div class="color-note color-quick-note">
            <p id="quick-colors-title" class="color-note-title">
              Quick colors
            </p>
            <p class="color-note-line">
              {!quick().length
                ? "No quick colors. Press + to add some."
                : keyed()
                  ? "Alt + arrow keys move it. Delete removes it."
                  : "Drag to reorder."}
            </p>
          </div>
          <div class="color-new">
            {/* The link an idea hangs from, in the color its link would
                take, coming in level from a parent off to the left. */}
            <svg
              aria-hidden="true"
              class="color-new-link"
              viewBox="0 0 2000 48"
              width="2000"
              height="48"
            >
              <path
                d="M0 2 L1860 2 C 1937 2, 1923 24, 2000 24"
                class={lineLook(newIdeas()).class}
                style={lineLook(newIdeas()).style}
              />
            </svg>
            <button
              ref={newIdea}
              type="button"
              class="color-new-idea"
              aria-expanded={picking() === "new"}
              aria-label={`New ideas start as ${colorLabel(props.colors.newIdeas)}. Choose a color`}
              title="Choose the color new ideas start as"
              {...press((e) => toggle("new", e))}
            >
              <span class="color-new-face">
                <span
                  class={`map-node-card color-new-card ${nodeLook(newIdeas(), false).class}`}
                  style={nodeLook(newIdeas(), false).style}
                >
                  New idea
                </span>
                <span aria-hidden="true" class="color-badge color-new-badge">
                  <ChevronDownIcon class="size-2.5" />
                </span>
              </span>
              <span class="color-note">
                <span class="color-note-title">New ideas</span>
                <span class="color-note-line">
                  Start as <b>{colorLabel(newIdeas())}</b>
                </span>
              </span>
            </button>
          </div>
        </div>
        <Show when={picking()} keyed>
          {(choice) => (
            <ColorPicker
              choice={choice}
              colors={props.colors}
              // The quick colors stay in reach, by pointer and by Tab, while
              // more are added.
              trigger={() => (choice === "quick" ? map : newIdea)}
              returnFocus={() => (choice === "quick" ? add : newIdea)}
              pointed={pointed()}
              onPoint={setPointed}
              onChoose={choose}
              onClose={close}
              focusGrid={keyboardOpen}
            />
          )}
        </Show>
      </div>
      <p role="status" class="sr-only">
        {status()}
      </p>
    </div>
  );
}

// Every color, beside the colors on the map (under them on narrow screens).
// For quick colors a press adds one or takes it out, and it stays open for
// more; for new ideas it is one choice, with the quick colors first.
function ColorPicker(props: {
  choice: "quick" | "new";
  colors: ColorPreferences;
  trigger: () => HTMLElement;
  returnFocus: () => HTMLElement;
  pointed: NodeColor | undefined;
  onPoint: (color: NodeColor | undefined) => void;
  onChoose: (color: NodeColor, event: MouseEvent) => void;
  onClose: () => void;
  focusGrid: boolean;
}) {
  const inQuick = (color: NodeColor) => props.colors.quick.includes(color);
  const title = () =>
    props.choice === "quick" ? "Add quick colors" : "New ideas start as";
  const hint = (color: NodeColor) =>
    props.choice === "new"
      ? `New ideas start as ${colorLabel(color)}`
      : inQuick(color)
        ? `Remove ${colorLabel(color)} from quick colors`
        : `Add ${colorLabel(color)} to quick colors`;
  let grid!: HTMLElement;

  return (
    <section
      aria-label={title()}
      class="color-picker"
      data-choice={props.choice}
      ref={(el) => {
        transientLayer(el, {
          trigger: props.trigger,
          returnFocus: props.returnFocus,
          close: props.onClose,
        });
        queueMicrotask(() =>
          (props.focusGrid
            ? grid.querySelector<HTMLButtonElement>('button[tabindex="0"]')
            : el
          )?.focus({ preventScroll: true }),
        );
      }}
    >
      <div class="color-picker-head">
        <span class="color-picker-title">{title()}</span>
        <span class="color-picker-named">
          {props.pointed ? colorLabel(props.pointed) : ""}
        </span>
        <button
          type="button"
          class="icon-button color-picker-close"
          aria-label="Close colors"
          title="Close colors (Esc)"
          {...press(() => {
            const back = props.returnFocus();
            props.onClose();
            back.focus({ preventScroll: true });
          })}
        >
          <CloseIcon class="size-4" />
        </button>
      </div>
      <Show when={props.choice === "new" && props.colors.quick.length > 0}>
        <fieldset
          class="color-picker-quick"
          onPointerLeave={() => props.onPoint(undefined)}
        >
          <legend class="sr-only">Quick colors</legend>
          <For each={props.colors.quick}>
            {(color) => (
              <button
                type="button"
                class="style-swatch"
                aria-label={colorLabel(color)}
                aria-pressed={color === props.colors.newIdeas}
                title={hint(color)}
                onPointerEnter={() => props.onPoint(color)}
                onFocus={(e) => {
                  if (e.currentTarget.matches(":focus-visible"))
                    props.onPoint(color);
                }}
                onBlur={() => props.onPoint(undefined)}
                {...press((e) => props.onChoose(color, e))}
              >
                <Chip color={color} class="style-chip" />
              </button>
            )}
          </For>
        </fieldset>
      </Show>
      <ColorGrid
        ref={(el) => {
          grid = el;
        }}
        labeled
        label="Every color"
        pressed={(color) =>
          props.choice === "new"
            ? color === props.colors.newIdeas
            : inQuick(color)
        }
        marked={props.choice === "quick" ? inQuick : undefined}
        onPress={props.onChoose}
        onPoint={props.onPoint}
        title={hint}
      />
    </section>
  );
}
