import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { CrdtApi } from "../../src/crdt-api";
import * as project from "../../src/project-document";
import { ProjectRepository } from "../../src/project-repository";
import type { ProjectHandle } from "../../src/project-repository";
import { discoverProjects, ProjectSync } from "../../src/project-sync";

let repository: ProjectRepository;
let handle: ProjectHandle;
let sync: ProjectSync;
const api = new CrdtApi((path) => new URL(path, location.origin).href);
let socketUrl = "";
const mg = {
  project,
  Y,
  async open(ws: string, id?: string) {
    socketUrl = ws;
    repository = new ProjectRepository({
      deployment: location.origin,
      namespace: "account-1",
    });
    handle = id
      ? await repository.open(id)
      : await repository.create({ name: "Shared", root: { text: "Root" } });
    return handle.id;
  },
  async discover() {
    await discoverProjects(repository, api, new AbortController().signal);
    return repository.list();
  },
  async use(id: string) {
    sync?.destroy();
    await handle?.close();
    handle = await repository.open(id);
    return handle.state();
  },
  async start() {
    sync?.destroy();
    sync = new ProjectSync(handle, repository, {
      api,
      online: () => sessionStorage.getItem("test-offline") !== "true",
      provider: (id, doc) => {
        const provider = new WebsocketProvider(socketUrl, id, doc, {
          connect: false,
          disableBc: true,
          shouldReconnect: () => false,
        });
        provider.awareness.setLocalState(null);
        return provider;
      },
      debounceMs: 100,
      retryMs: 100,
    });
    await sync.syncNow();
  },
  status: () => sync?.status,
  content: () => project.materializeProject(handle.doc),
  root: () => Object.keys(project.materializeProject(handle.doc).nodes)[0],
  edit(text: string) {
    project.editNodeText(handle.doc, mg.root(), 0, 0, text);
  },
  deleteText() {
    const node = project.materializeProject(handle.doc).nodes[mg.root()];
    project.editNodeText(handle.doc, mg.root(), 0, node.text.length, "");
  },
  child(text: string) {
    project.createChild(handle.doc, mg.root(), { text });
  },
  async large() {
    // Exceeds one HTTP update while remaining comfortably within backend limits.
    for (let i = 0; i < 25; i++)
      project.createChild(handle.doc, mg.root(), {
        text: `Node ${i} ` + "z".repeat(50_000),
      });
    await handle.flush();
  },
  async flush() {
    await handle.flush();
  },
  networkFault(offline: boolean) {
    sessionStorage.setItem("test-offline", String(offline));
    window.dispatchEvent(new Event(offline ? "offline" : "online"));
  },
  async stop() {
    sync?.destroy();
    await handle.flush();
  },
  async sync() {
    await sync.syncNow();
  },
};
export type CloudHarness = typeof mg;
Object.assign(globalThis, { mg });
