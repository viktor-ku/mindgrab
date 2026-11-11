// Screen space kept clear of floating toolbars when fitting or following
// nodes.
const VIEW_INSETS = { top: 76, right: 24, bottom: 72, left: 24 } as const;

// How far the open notes reach in from the right canvas edge, 0 when closed.
// `width` is the window's, which picks the breakpoints. This repeats the notes
// wrapper's classes: 12px from the edge, `w-80 xl:w-96`. Phones show the notes
// over the whole map, so they take no room there. The outline docks beside the
// canvas instead, so it narrows the canvas itself.
export function panelEdges(width: number, notes: boolean) {
  const wide = width >= 640;
  return { left: 0, right: wide && notes ? (width >= 1280 ? 396 : 332) : 0 };
}

// The map fits and follows the selection in the room left beside the notes.
export function panelInsets(width: number, notes: boolean) {
  const edges = panelEdges(width, notes);
  return {
    ...VIEW_INSETS,
    left: edges.left ? edges.left + 16 : VIEW_INSETS.left,
    right: edges.right ? edges.right + 16 : VIEW_INSETS.right,
  };
}
