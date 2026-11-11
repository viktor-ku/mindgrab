// Screen space kept clear of floating toolbars when fitting or following
// nodes.
const VIEW_INSETS = { top: 76, right: 24, bottom: 72, left: 24 } as const;

// How far the side panel reaches in from each canvas edge, 0 when closed. This
// repeats its wrapper's classes: 12px from the right edge, `w-96 xl:w-[28rem]`.
// Phones show it over the whole map, so it takes no room there.
export function panelEdges(width: number, open: boolean) {
  const wide = width >= 640;
  return { left: 0, right: wide && open ? (width >= 1280 ? 460 : 396) : 0 };
}

// The map fits and follows the selection in the room left beside the panel.
export function panelInsets(width: number, open: boolean) {
  const edges = panelEdges(width, open);
  return {
    ...VIEW_INSETS,
    left: edges.left ? edges.left + 16 : VIEW_INSETS.left,
    right: edges.right ? edges.right + 16 : VIEW_INSETS.right,
  };
}
