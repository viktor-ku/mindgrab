// Screen space kept clear of floating toolbars when fitting or following
// nodes.
const VIEW_INSETS = { top: 76, right: 24, bottom: 72, left: 24 } as const;

// The notes sit beside the outline drawer from this width; below it they
// cover the drawer while open.
const NOTES_BESIDE_OUTLINE = 1024;

// How far the notes reach in from the right canvas edge to their own right
// edge: 12px, or 8px clear of the outline drawer when they sit beside it.
// This repeats the notes wrapper's `lg:right-[25.25rem] xl:right-[29.25rem]`.
function notesRight(width: number, outline: boolean) {
  if (!outline || width < NOTES_BESIDE_OUTLINE) return 12;
  return width >= 1280 ? 468 : 404;
}

// How far the open side panels reach in from each canvas edge, 0 when closed.
// Both panels open on the right. These repeat the panel wrappers' classes:
// 12px from the edge, the outline drawer `w-96 xl:w-[28rem]` and the notes
// `w-80 xl:w-96`. Phones show a panel over the whole map, so it takes no room
// there.
export function panelEdges(width: number, outline: boolean, notes: boolean) {
  const wide = width >= 640;
  const xl = width >= 1280;
  const drawer = wide && outline ? (xl ? 460 : 396) : 0;
  const note =
    wide && notes ? notesRight(width, outline) + (xl ? 384 : 320) : 0;
  return { left: 0, right: Math.max(drawer, note) };
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
