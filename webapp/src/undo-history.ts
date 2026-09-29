import * as Y from "yjs";

export const MAX_UNDO_ACTIONS = 100;

export function retainUndoHistory(
  manager: Y.UndoManager,
  maxItems = MAX_UNDO_ACTIONS,
) {
  const trim = () => {
    while (manager.undoStack.length > maxItems) manager.undoStack.shift();
    while (manager.redoStack.length > maxItems) manager.redoStack.shift();
  };
  manager.on("stack-item-added", trim);
  return () => manager.off("stack-item-added", trim);
}
