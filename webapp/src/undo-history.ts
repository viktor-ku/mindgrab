import type { ProjectDocument } from "./project-document";

export type HistoryEntry<Selection> = { before?: Selection; after?: Selection };
type RestoreEvent<Selection> = {
  entry: HistoryEntry<Selection>;
  direction: "undo" | "redo";
};
// Only selection metadata is browser-owned. Loro's native UndoManager owns
// grouping, the 100-step bound, and transformations over remote edits.
export class EditHistory<Selection> {
  #doc: ProjectDocument;
  #undo: HistoryEntry<Selection>[] = [];
  #redo: HistoryEntry<Selection>[] = [];
  #recordListeners = new Set<(entry: HistoryEntry<Selection>) => void>();
  #restoreListeners = new Set<(event: RestoreEvent<Selection>) => void>();
  #popping = false;
  constructor(doc: ProjectDocument) {
    this.#doc = doc;
    if (doc.ready) doc.native().startGroup();
    doc.on("snapshot", this.#changed);
  }
  #changed = () => {
    if (this.#popping || !this.#doc.ready) return;
    const count = this.#doc.native().undoCount();
    if (count > this.#undo.length) {
      const entry: HistoryEntry<Selection> = {};
      this.#undo.push(entry);
      this.#redo = [];
      for (const listener of this.#recordListeners) listener(entry);
    }
    while (this.#undo.length > count) this.#undo.shift();
    while (this.#undo.length > 100) this.#undo.shift();
  };
  onRecord(listener: (entry: HistoryEntry<Selection>) => void) {
    this.#recordListeners.add(listener);
  }
  onRestore(listener: (event: RestoreEvent<Selection>) => void) {
    this.#restoreListeners.add(listener);
  }
  finishGroup() {
    // Restore listeners may resume writing during undo/redo; #pop starts the
    // next group itself once they finish, and Loro rejects a second start.
    if (this.#doc.ready && !this.#popping) {
      this.#doc.native().stopGroup();
      this.#doc.native().startGroup();
    }
  }
  undo() {
    this.#pop("undo");
  }
  redo() {
    this.#pop("redo");
  }
  #pop(type: "undo" | "redo") {
    if (!(type === "undo" ? this.canUndo() : this.canRedo())) return;
    this.#doc.native().stopGroup();
    this.#popping = true;
    const source = type === "undo" ? this.#undo : this.#redo;
    const destination = type === "undo" ? this.#redo : this.#undo;
    const native = this.#doc.native();
    const counts = () =>
      type === "undo"
        ? [native.undoCount(), native.redoCount()]
        : [native.redoCount(), native.undoCount()];
    const [sourceBefore, destinationBefore] = counts();
    try {
      this.#doc.dispatch({ type });
      // Loro skips steps whose changes a collaborator already removed and
      // reverts an older one in the same call. Keep entries paired with
      // Loro's steps: drop the skipped ones and restore the one reverted.
      const [sourceAfter, destinationAfter] = counts();
      let entry: HistoryEntry<Selection> = {};
      for (let i = Math.max(1, sourceBefore - sourceAfter); i > 0; i--)
        entry = source.pop() ?? {};
      for (let i = destinationAfter - destinationBefore; i > 1; i--)
        destination.push({});
      if (destinationAfter > destinationBefore) destination.push(entry);
      for (const listener of this.#restoreListeners)
        listener({ entry, direction: type });
    } finally {
      this.#popping = false;
      this.#doc.native().startGroup();
    }
  }
  canUndo() {
    return this.#doc.ready && this.#doc.native().canUndo();
  }
  canRedo() {
    return this.#doc.ready && this.#doc.native().canRedo();
  }
  destroy() {
    this.#doc.off("snapshot", this.#changed);
    if (this.#doc.ready) this.#doc.native().stopGroup();
    this.#recordListeners.clear();
    this.#restoreListeners.clear();
  }
}
