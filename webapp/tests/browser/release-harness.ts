// Bundled only by the release test's Vite plugin. Operates on the shipped App's
// active document; the normal build has no globals, fault hooks, or extra entry.
import * as Y from "yjs";
import * as project from "../../src/project-document";
import { serializeProjectFile } from "../../src/project-import-export";

declare global {
  var __releaseDoc: Y.Doc;
}
let failWrites = false;
for (const method of ["add", "put"] as const) {
  const original = IDBObjectStore.prototype[method];
  IDBObjectStore.prototype[method] = function (
    ...args: [unknown, IDBValidKey?]
  ) {
    const request = original.apply(this, args);
    if (failWrites && this.name === "updates")
      request.addEventListener("success", () => this.transaction.abort());
    return request;
  };
}
const mg = {
  Y,
  project,
  doc: () => globalThis.__releaseDoc,
  content: () => project.materializeProject(mg.doc()),
  canonical() {
    if (project.readProject(mg.doc()).status !== "ready") return undefined;
    const sort = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(sort);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => [key, sort(value)]),
        );
      return value;
    };
    return JSON.stringify(sort(mg.content()));
  },
  forest: () => project.projectForest(mg.content()),
  root: () => mg.forest()[0].id,
  edit(text: string) {
    project.editNodeText(mg.doc(), mg.root(), 0, 0, text);
  },
  child(text: string) {
    return project.createChild(mg.doc(), mg.root(), { text });
  },
  export: () => serializeProjectFile(mg.content()),
  storageFault(enabled: boolean) {
    failWrites = enabled;
  },
  updates() {
    const updates: number[][] = [];
    const listener = (update: Uint8Array) => updates.push(Array.from(update));
    mg.doc().on("update", listener);
    return {
      stop: () => {
        mg.doc().off("update", listener);
        return updates;
      },
    };
  },
  benchmark(edits: number) {
    const samples: number[] = [];
    for (let i = 0; i < edits; i++) {
      const start = performance.now();
      mg.edit(`e${i} `);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return {
      p95: samples[Math.ceil(samples.length * 0.95) - 1],
      max: samples.at(-1),
    };
  },
};
export type ReleaseHarness = typeof mg;
Object.assign(globalThis, { mg });
