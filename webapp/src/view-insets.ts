// Screen space kept clear of floating toolbars when fitting or following
// nodes.
const VIEW_INSETS = { top: 76, right: 24, bottom: 72, left: 24 } as const;

// The style panel's `w-56`, 12px from the left edge.
export const STYLE_PANEL_LEFT = 12;
export const STYLE_PANEL_WIDTH = 224;

// How far the panels reach in from each canvas edge, 0 when closed. The side
// panel repeats its wrapper's classes: 12px from the right edge,
// `w-96 xl:w-[28rem]`. The style panel stands at the left while an idea is
// selected. Phones show both over the map, so they take no room there.
export function panelEdges(width: number, open: boolean, style = false) {
  const wide = width >= 640;
  return {
    left: wide && style ? STYLE_PANEL_LEFT + STYLE_PANEL_WIDTH : 0,
    right: wide && open ? (width >= 1280 ? 460 : 396) : 0,
  };
}

// The map fits and follows the selection in the room left beside the side
// panel. The style panel takes only a corner of it, which the map keeps the
// selected idea out of on its own.
export function panelInsets(width: number, open: boolean) {
  const edges = panelEdges(width, open);
  return {
    ...VIEW_INSETS,
    left: edges.left ? edges.left + 16 : VIEW_INSETS.left,
    right: edges.right ? edges.right + 16 : VIEW_INSETS.right,
  };
}
