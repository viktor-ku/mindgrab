import { createPrivateKey } from "node:crypto";
import type { SQL } from "bun";
import { importPKCS8, SignJWT } from "jose";
import { randomToken, SESSION_COOKIE, tokenHash } from "../src/auth";
import { Backend } from "../src/backend";
import type { Config } from "../src/config";
import { connect, migrate } from "../src/db";
import type { RateLimits } from "../src/rate-limits";
import { WorkOs } from "../src/workos";

export const ORIGIN = "http://localhost:5173";
const privateKey = createPrivateKey(
  await Bun.file(
    new URL("./fixtures/test-private.pem", import.meta.url),
  ).text(),
)
  .export({ format: "pem", type: "pkcs8" })
  .toString();
const signingKey = await importPKCS8(privateKey, "RS256");
const jwks = await Bun.file(
  new URL("./fixtures/jwks.json", import.meta.url),
).json();

export async function signedToken(overrides: Record<string, unknown> = {}) {
  return new SignJWT({
    iss: "https://api.workos.com/user_management/client_test",
    client_id: "client_test",
    sub: "user_test",
    sid: "session_test",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .sign(signingKey);
}

export async function isolatedDatabase() {
  const url = new URL(
    process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/mindgrab",
  );
  const admin = connect(url.href, 2);
  const name = `mindgrab_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`;
  const db = connect(url.href);
  try {
    await migrate(db);
  } catch (error) {
    await db.close();
    await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.close();
    throw error;
  }
  return {
    db,
    url: url.href,
    name,
    async close() {
      await db.close();
      await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.close();
    },
  };
}

export async function fixture(
  options: { limits?: RateLimits; secure?: boolean } = {},
) {
  const database = await isolatedDatabase();
  const mock = {
    refreshStatus: 0,
    refreshCalls: 0,
    requests: [] as Record<string, string>[],
    keyRequests: 0,
  };
  const providerServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/sso/jwks/client_test") {
        mock.keyRequests++;
        return Response.json(jwks);
      }
      const body = (await request.json()) as Record<string, string>;
      mock.requests.push(body);
      const refresh = body.grant_type === "refresh_token";
      if (refresh) {
        mock.refreshCalls++;
        if (mock.refreshStatus)
          return Response.json(
            {
              error:
                mock.refreshStatus === 400 ? "invalid_grant" : "server_error",
            },
            { status: mock.refreshStatus },
          );
      }
      return Response.json({
        user: {
          id: "user_test",
          email: "test@example.com",
          first_name: "Test",
          last_name: "User",
        },
        access_token: await signedToken(),
        refresh_token: refresh ? "rotated-refresh" : "initial-refresh",
      });
    },
  });
  const config: Config = {
    databaseUrl: database.url,
    clientId: "client_test",
    apiKey: "test-secret",
    redirectUri: `${ORIGIN}/api/auth/callback`,
    appUrl: `${ORIGIN}/`,
    issuer: "https://api.workos.com/user_management/client_test",
    secureCookies: options.secure ?? false,
  };
  const provider = new WorkOs(
    config,
    `http://127.0.0.1:${providerServer.port}`,
  );
  const backend = new Backend(database.db, config, provider, options.limits);
  const server = backend.listen(0, "127.0.0.1", false);
  const url = `http://127.0.0.1:${server.port}`;
  const request = (path: string, init: RequestInit = {}, credential = "") => {
    const headers = new Headers(init.headers);
    if (credential) headers.set("Cookie", credential);
    headers.set("Origin", headers.get("Origin") ?? ORIGIN);
    return fetch(`${url}${path}`, { ...init, headers, redirect: "manual" });
  };
  const rpc = (
    method: string,
    args: unknown,
    credential = "",
    headers: HeadersInit = {},
  ) =>
    request(
      `/api/${method}`,
      {
        method: "POST",
        body: JSON.stringify(args),
        headers: {
          ...Object.fromEntries(new Headers(headers)),
          "Content-Type": "application/json",
        },
      },
      credential,
    );
  const signIn = async (previous = "") => {
    const start = await request("/api/startLogin", { method: "POST" });
    if (start.status !== 303)
      throw new Error(`Login start failed: ${start.status}`);
    const stateCookie = start.headers
      .getSetCookie()
      .find((value) => value.startsWith("mindgrab_login="))
      ?.split(";")[0];
    const state = new URL(start.headers.get("Location")!).searchParams.get(
      "state",
    );
    const response = await request(
      `/api/auth/callback?code=valid-code&state=${state}`,
      {},
      `${stateCookie}${previous ? `; ${previous}` : ""}`,
    );
    if (response.headers.get("Location") !== config.appUrl)
      throw new Error(
        `Login callback failed: ${response.headers.get("Location")}`,
      );
    const credential = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${SESSION_COOKIE}=`))
      ?.split(";")[0];
    if (!credential) throw new Error("Login did not publish a credential");
    return credential;
  };
  const sessionFor = async (
    externalId: string,
    tokenOverrides: Record<string, unknown> = {},
  ) => {
    const [user] =
      await database.db`INSERT INTO users (name, email, external_id) VALUES ('Other', ${`${externalId}@example.com`}, ${externalId}) ON CONFLICT (external_id) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
    const credential = randomToken();
    const authority = tokenHash(randomToken());
    const sid = `${externalId}-session`;
    await database.db`INSERT INTO auth_sessions (token_hash, user_id, workos_session_id, access_token, refresh_token, browser_hash) VALUES (${authority}, ${user.id}, ${sid}, ${await signedToken({ sub: externalId, sid, ...tokenOverrides })}, 'refresh', ${tokenHash(credential)})`;
    return `${SESSION_COOKIE}=${credential}`;
  };
  const register = async (
    credential: string,
    id: string = crypto.randomUUID(),
  ) => {
    const response = await rpc(
      "createProject",
      { projectId: id, schemaVersion: 1 },
      credential,
    );
    if (response.status !== 201 && response.status !== 200)
      throw new Error(`Registration failed: ${await response.text()}`);
    return id;
  };
  const submit = (
    credential: string,
    id: string,
    data: Uint8Array,
    updateId: string = crypto.randomUUID(),
    headers: HeadersInit = {},
  ) =>
    request(
      `/api/submitProjectUpdate?${new URLSearchParams({ projectId: id, updateId })}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Mindgrab-Schema-Version": "1",
          ...Object.fromEntries(new Headers(headers)),
        },
        body: Buffer.from(data),
      },
      credential,
    );
  return {
    ...database,
    config,
    backend,
    server,
    url,
    provider,
    providerUrl: `http://127.0.0.1:${providerServer.port}`,
    mock,
    request,
    rpc,
    signIn,
    sessionFor,
    register,
    submit,
    async close() {
      await backend.close();
      await providerServer.stop(true);
      await database.close();
    },
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;
export async function owner(db: SQL, id: string): Promise<bigint> {
  return (await db`SELECT owner_id FROM crdt_project WHERE id = ${id}`)[0]
    .owner_id;
}

export const initial = new Uint8Array(
  await Bun.file(
    new URL("../../webapp/tests/fixtures/yjs/unicode.0.bin", import.meta.url),
  ).arrayBuffer(),
);
