import { createEffect, For, Show } from "solid-js";
import { ChevronRightIcon, CloseIcon } from "./icons";
import { ALT_LABEL } from "./ShortcutsDialog";
import type { MindMapNode } from "./mind-map";

// A synchronized tree view of the map. It shares selection and folding with
// the canvas and follows the W3C tree pattern: one tab stop, arrow keys move,
// Left/Right fold and unfold, Enter edits on the map.
export function Outline(props: {
  roots: readonly MindMapNode[];
  text: (id: string) => string;
  selectedId?: string;
  collapsed: ReadonlySet<string>;
  // `pointer` when a row was clicked; keyboard movement reports `keyboard`.
  onSelect: (id: string, via: "pointer" | "keyboard") => void;
  onToggle: (id: string) => void;
  onEdit: (id: string) => void;
  onClose: () => void;
}) {
  let tree!: HTMLDivElement;
  // Items in display order, honoring folds, for keyboard movement.
  const visible = () => {
    const items: { id: string; parent?: string; children: number }[] = [];
    const visit = (nodes: readonly MindMapNode[], parent?: string) => {
      for (const node of nodes) {
        const children = node.next?.length ?? 0;
        items.push({ id: node.id, parent, children });
        if (!props.collapsed.has(node.id)) visit(node.next ?? [], node.id);
      }
    };
    visit(props.roots);
    return items;
  };
  const focusItem = (id: string) =>
    tree
      .querySelector<HTMLElement>(`[data-outline-id="${CSS.escape(id)}"]`)
      ?.focus({ preventScroll: false });

  createEffect(() => {
    const id = props.selectedId;
    if (!id) return;
    tree
      // The row, not the whole item: an expanded item also contains its children.
      .querySelector<HTMLElement>(
        `[data-outline-id="${CSS.escape(id)}"] > .outline-row`,
      )
      ?.scrollIntoView({ block: "nearest" });
  });

  function keydown(e: KeyboardEvent) {
    const items = visible();
    const current =
      items.findIndex((item) => item.id === props.selectedId) ?? -1;
    const item = items[current];
    const go = (id?: string) => {
      if (!id) return;
      props.onSelect(id, "keyboard");
      queueMicrotask(() => focusItem(id));
    };
    switch (e.key) {
      case "ArrowDown":
        go(items[Math.min(items.length - 1, current + 1)]?.id);
        break;
      case "ArrowUp":
        go(items[Math.max(0, current - 1)]?.id);
        break;
      case "Home":
        go(items[0]?.id);
        break;
      case "End":
        go(items.at(-1)?.id);
        break;
      case "ArrowRight":
        if (!item?.children) return;
        if (props.collapsed.has(item.id)) props.onToggle(item.id);
        else go(items[current + 1]?.id);
        break;
      case "ArrowLeft":
        if (!item) return;
        if (item.children && !props.collapsed.has(item.id))
          props.onToggle(item.id);
        else go(item.parent);
        break;
      case "Enter":
      case "F2":
        if (item) props.onEdit(item.id);
        break;
      case "Escape":
        props.onClose();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  const Branch = (branch: { nodes: readonly MindMapNode[]; level: number }) => (
    <For each={branch.nodes}>
      {(node) => {
        const children = () => node.next ?? [];
        const open = () => !props.collapsed.has(node.id);
        const selected = () => props.selectedId === node.id;
        return (
          <div
            role="treeitem"
            aria-level={branch.level}
            aria-selected={selected()}
            aria-expanded={children().length ? open() : undefined}
            aria-label={props.text(node.id).trim() || "New idea"}
            data-outline-id={node.id}
            tabIndex={
              selected() || (!props.selectedId && node === props.roots[0])
                ? 0
                : -1
            }
            class="outline-item"
            onFocus={(e) => {
              if (e.target === e.currentTarget && !selected())
                props.onSelect(node.id, "keyboard");
            }}
          >
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: The tree handles keyboard selection on the focused treeitem. */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: Pointer selection for the row; the treeitem carries the semantics. */}
            <div
              class="outline-row"
              style={{ "padding-left": `${(branch.level - 1) * 14 + 4}px` }}
              onClick={() => props.onSelect(node.id, "pointer")}
              onDblClick={() => props.onEdit(node.id)}
            >
              <Show
                when={children().length}
                fallback={<span class="outline-dot" aria-hidden="true" />}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden="true"
                  class="outline-toggle"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onToggle(node.id);
                  }}
                >
                  <ChevronRightIcon
                    class={`size-3.5 transition-transform ${open() ? "rotate-90" : ""}`}
                  />
                </button>
              </Show>
              <span class="min-w-0 flex-1 truncate">
                {props.text(node.id).trim() || "New idea"}
              </span>
              <Show when={!open() && children().length}>
                <span class="shrink-0 text-[11px] text-stone-500">
                  {children().length}
                </span>
              </Show>
            </div>
            <Show when={open() && children().length}>
              {/* biome-ignore lint/a11y/useSemanticElements: The W3C tree pattern nests child treeitems in role=group; a fieldset is not a tree group. */}
              <div role="group">
                <Branch nodes={children()} level={branch.level + 1} />
              </div>
            </Show>
          </div>
        );
      }}
    </For>
  );

  return (
    <aside
      data-no-pan
      data-toolbar
      aria-label="Outline"
      class="map-toolbar outline-panel pointer-events-auto flex flex-col cursor-default"
    >
      <header class="flex items-center justify-between border-b border-stone-100 py-1 pr-1 pl-3">
        <h2 class="text-xs font-semibold tracking-wide text-stone-500 uppercase">
          Outline
        </h2>
        <button
          type="button"
          class="icon-button size-8!"
          aria-label="Close outline"
          title={`Close outline (${ALT_LABEL}O)`}
          onClick={props.onClose}
        >
          <CloseIcon class="size-4" />
        </button>
      </header>
      <div
        ref={tree}
        role="tree"
        aria-label="Map outline"
        class="min-h-0 flex-1 overflow-y-auto p-1 text-sm"
        onKeyDown={keydown}
      >
        <Branch nodes={props.roots} level={1} />
      </div>
    </aside>
  );
}
