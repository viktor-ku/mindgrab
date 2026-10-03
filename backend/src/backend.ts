import type { Server, SQL } from "bun";
import { createApi, type Services } from "./api";
import { Auth } from "./auth";
import type { Config } from "./config";
import { projectError } from "./errors";
import { responseHeaders } from "./http";
import { Backups } from "./project/backup";
import { Catalog } from "./project/catalog";
import { Maintenance } from "./project/maintenance";
import { ReadModels } from "./project/read-model";
import { Storage } from "./project/storage";
import { type SocketData, Synchronization } from "./project/sync";
import { RateLimits } from "./rate-limits";
import { type IdentityProvider, WorkOs } from "./workos";

export class Backend {
  readonly services: Services;
  readonly maintenance: Maintenance;
  readonly backups: Backups;
  readonly synchronization: Synchronization;
  private api: ReturnType<typeof createApi>;
  private server?: Server<SocketData>;
  private timers: ReturnType<typeof setInterval>[] = [];
  private jobs = new Set<Promise<unknown>>();

  constructor(
    db: SQL,
    config: Config,
    provider: IdentityProvider = new WorkOs(config),
    limits = new RateLimits(),
  ) {
    const storage = new Storage(db);
    this.services = {
      config,
      storage,
      auth: new Auth(db, config, provider),
      catalog: new Catalog(db),
      readModels: new ReadModels(storage),
      limits,
    };
    this.maintenance = new Maintenance(storage);
    this.backups = new Backups(storage);
    this.synchronization = new Synchronization(this.services);
    this.api = createApi(this.services);
  }

  async fetch(request: Request, peerIp?: string, server?: Server<SocketData>) {
    const started = performance.now();
    let response: Response | undefined;
    try {
      if (request.method === "OPTIONS")
        response = new Response(null, { status: 200 });
      else if (new URL(request.url).pathname.startsWith("/sync/v1/")) {
        response =
          request.method !== "GET"
            ? new Response(null, { status: 405 })
            : server
              ? await this.synchronization.upgrade(request, server, peerIp)
              : new Response(null, { status: 400 });
      } else response = await this.api.fetch(request, { peerIp });
    } catch (error) {
      response = projectError(error).response();
    }
    return response
      ? responseHeaders(response, request, this.services.config, started)
      : undefined;
  }

  listen(port = 3000, hostname = "0.0.0.0", workers = true) {
    if (this.server) throw new Error("Backend is already listening");
    const server = Bun.serve<SocketData>({
      port,
      hostname,
      maxRequestBodySize: 16 * 1048576,
      fetch: (request, server) =>
        this.fetch(request, server.requestIP(request)?.address, server),
      websocket: this.synchronization.handlers(),
    });
    this.server = server;
    if (workers) this.startWorkers();
    return server;
  }

  private repeat(interval: number, job: () => Promise<unknown>) {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      const promise = job()
        .catch(() => {
          console.error(
            "Background maintenance unavailable; retrying next sweep",
          );
        })
        .finally(() => {
          running = false;
          this.jobs.delete(promise);
        });
      this.jobs.add(promise);
    }, interval);
    timer.unref();
    this.timers.push(timer);
  }

  private startWorkers() {
    let projectionCursor: string | null = null;
    let compactionCursor: string | null = null;
    this.repeat(1000, async () => {
      projectionCursor = await this.services.readModels.sweep(projectionCursor);
    });
    this.repeat(5000, async () => {
      compactionCursor = await this.maintenance.sweep(compactionCursor);
    });
    this.repeat(3600000, () => this.services.auth.cleanup());
    this.repeat(60000, async () => {
      this.services.limits.cleanup();
    });
  }

  async close() {
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    await this.server?.stop(true);
    this.server = undefined;
    await Promise.all(this.jobs);
    await this.services.storage.documents.close();
  }
}
