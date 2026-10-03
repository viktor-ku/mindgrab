import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  type Auth,
  cookie,
  publicUser,
  SESSION_COOKIE,
  type User,
} from "./auth";
import type { Config } from "./config";
import { one } from "./db";
import { ApiError, AuthError, projectError } from "./errors";
import { parameters, readBody, sameOrigin } from "./http";
import type { Catalog } from "./project/catalog";
import { MAX_UPDATE_BYTES } from "./project/document";
import type { ReadModels } from "./project/read-model";
import {
  type Project,
  parseNewProjectId,
  parseProjectId,
  type Storage,
  sequence,
} from "./project/storage";
import type { RateLimits } from "./rate-limits";

export interface Services {
  config: Config;
  auth: Auth;
  storage: Storage;
  catalog: Catalog;
  readModels: ReadModels;
  limits: RateLimits;
}
interface Environment {
  Bindings: { peerIp?: string };
}
type ApiContext = Context<Environment>;
const projectRequest = z.strictObject({ projectId: z.string() });
const pageSize = z.number().int().min(1).max(100).optional();

async function json<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  try {
    const media = request.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    if (
      !(
        media === "application/json" ||
        (media?.startsWith("application/") && media.endsWith("+json"))
      )
    )
      throw new ApiError("invalid_request");
    return schema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readBody(request, 2097152),
        ),
      ),
    );
  } catch {
    throw new ApiError("invalid_request");
  }
}

export function accountFence(user: User, expected: string | null) {
  if (expected === null) return;
  if (
    !/^[1-9][0-9]*$/.test(expected) ||
    BigInt(expected) > 9223372036854775807n
  )
    throw new ApiError("invalid_request");
  if (BigInt(expected) !== user.id) throw new ApiError("account_changed");
}

export function createApi(services: Services) {
  const { auth, config, storage, catalog, readModels, limits } = services;
  const app = new Hono<Environment>();
  app.onError((error, context) => {
    if (error instanceof ApiError) return error.response();
    const path = context.req.path;
    if (["/api/getMe", "/api/startLogin", "/api/logout"].includes(path))
      return (
        error instanceof AuthError ? error : new AuthError("unavailable")
      ).response();
    return projectError(error).response();
  });
  app.get("/", () => new Response("Mindgrab API"));
  app.post("/api/getHealth", async () => {
    const started = performance.now();
    const probe = storage.db`SELECT 1 AS value`;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let reachable = false;
    try {
      reachable = await Promise.race([
        probe.then((rows) => rows[0]?.value === 1).catch(() => false),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => {
            probe.cancel();
            resolve(false);
          }, 2000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    const elapsed = performance.now() - started;
    return Response.json(
      {
        status: reachable ? "ok" : "degraded",
        database: {
          status: reachable ? "up" : "down",
          latency_ms: reachable ? Math.round(elapsed * 10) / 10 : null,
        },
      },
      {
        status: reachable ? 200 : 503,
        headers: { "Server-Timing": `db;dur=${elapsed.toFixed(3)}` },
      },
    );
  });
  app.post("/api/startLogin", async (context) => {
    try {
      sameOrigin(context.req.raw, config);
    } catch {
      return new Response("Invalid request origin", { status: 403 });
    }
    limits.take("login", context.env.peerIp);
    return auth.start(context.req.raw);
  });
  app.get("/api/auth/callback", async (context) => {
    limits.take("login", context.env.peerIp);
    return auth.callback(context.req.raw);
  });
  app.post("/api/logout", async (context) => {
    try {
      sameOrigin(context.req.raw, config);
    } catch {
      return new Response("Invalid request origin", { status: 403 });
    }
    return auth.logout(context.req.raw);
  });
  app.post("/api/getMe", async (context) => {
    try {
      return Response.json(publicUser(await auth.identify(context.req.raw)));
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      const response = error.response();
      if (error.kind === "unauthorized")
        response.headers.set(
          "Set-Cookie",
          cookie(config, SESSION_COOKIE, "", 0),
        );
      return response;
    }
  });

  const protectedRpc = (
    name: string,
    handler: (context: ApiContext, user: User) => Promise<Response>,
    mutation = false,
    upload = false,
  ) => {
    app.post(`/api/${name}`, async (context) => {
      if (mutation) sameOrigin(context.req.raw, config);
      if (upload) limits.take("uploadPeers", context.env.peerIp);
      const user = await auth.identify(context.req.raw);
      accountFence(user, context.req.header("X-Mindgrab-Account") ?? null);
      if (upload) limits.take("uploads", user.id.toString());
      return handler(context, user);
    });
  };
  protectedRpc(
    "createProject",
    async (context, user) => {
      const args = await json(
        context.req.raw,
        z.strictObject({
          projectId: z.string(),
          schemaVersion: z.number().int(),
        }),
      );
      const id = parseNewProjectId(args.projectId);
      if (args.schemaVersion !== 1) throw new ApiError("unsupported_schema");
      const result = await catalog.create(user.id, id);
      return Response.json(result.project, {
        status: result.created ? 201 : 200,
      });
    },
    true,
  );
  protectedRpc("listProjects", async (context, user) => {
    const args = await json(
      context.req.raw,
      z.strictObject({
        limit: pageSize.nullable(),
        cursor: z.string().nullable().optional(),
      }),
    );
    return Response.json(
      await catalog.list(user.id, args.limit ?? 50, args.cursor),
    );
  });
  protectedRpc("getProject", async (context, user) => {
    const args = await json(context.req.raw, projectRequest);
    return Response.json(
      await catalog.get(user.id, parseProjectId(args.projectId)),
    );
  });
  protectedRpc("getProjectBaseline", async (context, user) => {
    const args = await json(context.req.raw, projectRequest);
    const baseline = await storage.baseline(
      user.id,
      parseProjectId(args.projectId),
    );
    return Response.json({
      schemaVersion: 1,
      lastSequence: baseline.sequence.toString(),
      validation: baseline.validation,
      encoding: "yjs-v1",
      data: Buffer.from(baseline.bytes).toString("base64"),
      stateVector: Buffer.from(baseline.stateVector).toString("base64"),
    });
  });
  protectedRpc("getProjectStatus", async (context, user) => {
    const args = await json(context.req.raw, projectRequest);
    const project = await one<Project>(
      storage.db,
      "SELECT schema_version, protocol_version, last_sequence, validation FROM crdt_project WHERE id = $1 AND owner_id = $2",
      [parseProjectId(args.projectId), user.id],
    );
    if (!project) throw new ApiError("project_not_found");
    return Response.json({
      schemaVersion: project.schema_version,
      lastSequence: project.last_sequence.toString(),
      validation: project.validation,
    });
  });
  protectedRpc("getProjectState", async (context, user) => {
    const args = await json(context.req.raw, projectRequest);
    return Response.json(
      await readModels.current(user.id, parseProjectId(args.projectId)),
    );
  });
  protectedRpc("getProjectUpdates", async (context, user) => {
    const args = await json(
      context.req.raw,
      z.strictObject({
        projectId: z.string(),
        after: z.string().nullable().optional(),
        limit: pageSize.nullable(),
      }),
    );
    return Response.json(
      await storage.updates(
        user.id,
        parseProjectId(args.projectId),
        sequence(args.after ?? "0"),
        args.limit ?? 100,
      ),
    );
  });
  protectedRpc(
    "submitProjectUpdate",
    async (context, user) => {
      const result = z
        .strictObject({ projectId: z.string(), updateId: z.string() })
        .safeParse(parameters(new URL(context.req.url)));
      if (!result.success) throw new ApiError("invalid_request");
      const id = parseProjectId(result.data.projectId);
      const update = parseNewProjectId(result.data.updateId);
      if (context.req.header("X-Mindgrab-Schema-Version") !== "1")
        throw new ApiError("unsupported_schema");
      if (context.req.header("Content-Type") !== "application/octet-stream")
        throw new ApiError("invalid_request");
      const submitted = await storage.ingest(
        user.id,
        id,
        update,
        await readBody(context.req.raw, MAX_UPDATE_BYTES),
      );
      return Response.json(submitted.receipt, {
        status: submitted.created ? 201 : 200,
      });
    },
    true,
    true,
  );

  // Match method rejection before auth/body work for known private routes.
  app.all(
    "/api/*",
    (context) =>
      new Response(null, {
        status: app.routes.some((route) => route.path === context.req.path)
          ? 405
          : 404,
      }),
  );
  return app;
}
