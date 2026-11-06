// Screen space kept clear of floating toolbars when fitting or following
// nodes.
const VIEW_INSETS = { top: 76, right: 24, bottom: 72, left: 24 } as const;

// How far the open side panels reach in from each canvas edge, 0 when closed.
// These repeat the panel wrappers' classes: 12px from the edge, the outline
// `w-72 xl:w-80` and the notes `w-80 xl:w-96`. Phones show a panel over the
// whole map, so it takes no room there.
export function panelEdges(width: number, outline: boolean, notes: boolean) {
  const wide = width >= 640;
  const xl = width >= 1280;
  return {
    left: wide && outline ? (xl ? 332 : 300) : 0,
    right: wide && notes ? (xl ? 396 : 332) : 0,
  };
}

// The map fits and follows the selection in the room left beside the panels.
export function panelInsets(width: number, outline: boolean, notes: boolean) {
  const edges = panelEdges(width, outline, notes);
  return {
    ...VIEW_INSETS,
    left: edges.left ? edges.left + 16 : VIEW_INSETS.left,
    right: edges.right ? edges.right + 16 : VIEW_INSETS.right,
  };
}
