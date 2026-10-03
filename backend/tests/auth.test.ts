import { afterEach, beforeEach, expect, test } from "bun:test";
import { SESSION_COOKIE, STATE_COOKIE, tokenHash } from "../src/auth";
import { readConfig } from "../src/config";
import { AuthError } from "../src/errors";
import { RateLimits } from "../src/rate-limits";
import { type Fixture, fixture, ORIGIN, signedToken } from "./fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f?.close();
});
const callbackCookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${STATE_COOKIE}=`))!
    .split(";")[0];
async function start() {
  const response = await f.request("/api/startLogin", { method: "POST" });
  const url = new URL(response.headers.get("Location")!);
  return {
    response,
    url,
    cookie: callbackCookie(response),
    callback: `/api/auth/callback?code=valid-code&state=${url.searchParams.get("state")}`,
  };
}

test("configuration requires HTTPS outside loopback and an exact callback origin", () => {
  const env = {
    WORKOS_CLIENT_ID: "client_test",
    WORKOS_API_KEY: "secret",
    WORKOS_REDIRECT_URI: `${ORIGIN}/api/auth/callback`,
  };
  expect(readConfig(env).appUrl).toBe(`${ORIGIN}/`);
  expect(() =>
    readConfig({ ...env, APP_URL: "https://attacker.example/" }),
  ).toThrow();
  for (const redirect of [
    "http://example.com/api/auth/callback",
    `${ORIGIN}/auth/callback`,
    "https://user:password@example.com/api/auth/callback",
    "https://example.com/api/auth/callback?x=1",
  ])
    expect(() =>
      readConfig({ ...env, WORKOS_REDIRECT_URI: redirect }),
    ).toThrow();
});

test("anonymous and forged browser credentials cannot authenticate", async () => {
  expect((await f.rpc("getMe", {})).status).toBe(401);
  expect((await f.rpc("getMe", {}, `${SESSION_COOKIE}=forged`)).status).toBe(
    401,
  );
  expect(
    (
      await f.rpc("createProject", {
        projectId: crypto.randomUUID(),
        schemaVersion: 1,
      })
    ).status,
  ).toBe(401);
});

test("login attempts are PKCE-bound, browser-bound, one-use and expiring", async () => {
  const login = await start();
  expect(login.response.status).toBe(303);
  expect(login.url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(login.url.searchParams.get("provider")).toBe("authkit");
  expect(login.url.href).not.toContain("test-secret");
  const [row] = await f.db`SELECT code_verifier FROM auth_login_attempts`;
  expect(login.url.searchParams.get("code_challenge")).toBe(
    tokenHash(row.code_verifier),
  );
  const wrong = await f.request(login.callback, {}, `${STATE_COOKIE}=wrong`);
  expect(wrong.headers.get("Location")).toContain("sign_in_failed");
  expect(f.mock.requests).toHaveLength(0);
  const valid = await f.request(login.callback, {}, login.cookie);
  expect(valid.headers.get("Location")).toBe(f.config.appUrl);
  expect(
    (await f.request(login.callback, {}, login.cookie)).headers.get("Location"),
  ).toContain("sign_in_failed");
  expect(f.mock.requests).toHaveLength(1);
  const expired = await start();
  await f.db`UPDATE auth_login_attempts SET expires_at = NOW() - INTERVAL '1 second'`;
  expect(
    (await f.request(expired.callback, {}, expired.cookie)).headers.get(
      "Location",
    ),
  ).toContain("sign_in_failed");
});

test("provider cancellation consumes the attempt and duplicate callback parameters fail", async () => {
  const login = await start();
  const cancelled = await f.request(
    `${login.callback}&error=access_denied`,
    {},
    login.cookie,
  );
  expect(cancelled.headers.get("Location")).toContain("sign_in_failed");
  expect(f.mock.requests).toHaveLength(0);
  expect(
    (await f.db`SELECT COUNT(*) AS count FROM auth_login_attempts`)[0].count,
  ).toBe(0n);
  expect(
    (await f.request(`${login.callback}&code=duplicate`, {}, login.cookie))
      .status,
  ).toBe(400);
});

test("login publishes hashed credentials only after commit and survives later requests", async () => {
  const login = await start();
  const response = await f.request(login.callback, {}, login.cookie);
  const raw = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${SESSION_COOKIE}=`))!;
  for (const attribute of [
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=2592000",
  ])
    expect(raw).toContain(attribute);
  const credential = raw.split(";")[0];
  expect(await (await f.rpc("getMe", {}, credential)).json()).toMatchObject({
    name: "Test User",
    external_id: "user_test",
  });
  const [stored] =
    await f.db`SELECT token_hash, browser_hash FROM auth_sessions`;
  expect(stored.browser_hash).toBe(tokenHash(credential.split("=")[1]));
  expect(stored.token_hash).not.toBe(stored.browser_hash);
});

test("signature, issuer, client, audience, subject, sid and nbf are verified", async () => {
  expect((await f.provider.verify(await signedToken({ exp: 1 }))).exp).toBe(1);
  for (const override of [
    { iss: "https://attacker.example" },
    { client_id: "other" },
    { aud: "other" },
    { sid: "" },
    { sub: "" },
    { nbf: Math.floor(Date.now() / 1000) + 600 },
  ]) {
    const failure = await f.provider
      .verify(await signedToken(override))
      .catch((error) => error);
    expect(failure).toBeInstanceOf(AuthError);
    expect(failure.kind).toBe("unauthorized");
  }
  const valid = await signedToken();
  expect(
    await f.provider
      .verify(`${valid.slice(0, -10)}AAAAAAAAAA`)
      .catch((error) => error),
  ).toBeInstanceOf(AuthError);
});

test("provider refresh is serialized across concurrent requests", async () => {
  const credential = await f.signIn();
  await f.db`UPDATE auth_sessions SET access_token = ${await signedToken({ exp: 1 })}`;
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => f.rpc("getMe", {}, credential)),
  );
  expect(responses.every((response) => response.status === 200)).toBe(true);
  expect(f.mock.refreshCalls).toBe(1);
  expect(
    (await f.db`SELECT refresh_token FROM auth_sessions`)[0].refresh_token,
  ).toBe("rotated-refresh");
});

test("transient refresh failures retain authority; explicit invalid grants revoke it", async () => {
  const credential = await f.signIn();
  await f.db`UPDATE auth_sessions SET access_token = ${await signedToken({ exp: 1 })}`;
  f.mock.refreshStatus = 503;
  expect((await f.rpc("getMe", {}, credential)).status).toBe(503);
  expect(
    (await f.db`SELECT COUNT(*) AS count FROM auth_sessions`)[0].count,
  ).toBe(1n);
  f.mock.refreshStatus = 400;
  expect((await f.rpc("getMe", {}, credential)).status).toBe(401);
  expect(
    (await f.db`SELECT COUNT(*) AS count FROM auth_sessions`)[0].count,
  ).toBe(0n);
});

test("session subject mismatch and local expiry fail closed", async () => {
  const credential = await f.signIn();
  await f.db`UPDATE auth_sessions SET access_token = ${await signedToken({ sub: "other" })}`;
  expect((await f.rpc("getMe", {}, credential)).status).toBe(401);
  const other = await f.sessionFor("user_other");
  await f.db`UPDATE auth_sessions SET expires_at = NOW() - INTERVAL '1 second'`;
  expect((await f.rpc("getMe", {}, other)).status).toBe(401);
});

test("logout requires same-origin POST, revokes authority and tolerates provider outages", async () => {
  const credential = await f.signIn();
  expect((await f.request("/api/logout", {}, credential)).status).toBe(405);
  expect(
    (
      await f.request(
        "/api/logout",
        { method: "POST", headers: { Origin: "null" } },
        credential,
      )
    ).status,
  ).toBe(403);
  f.mock.refreshStatus = 503;
  await f.db`UPDATE auth_sessions SET access_token = ${await signedToken({ exp: 1 })}`;
  const response = await f.request(
    "/api/logout",
    { method: "POST" },
    credential,
  );
  expect(response.status).toBe(303);
  expect(response.headers.get("Location")).toContain(
    "/user_management/sessions/logout",
  );
  expect((await f.rpc("getMe", {}, credential)).status).toBe(401);
});

test("Secure cookies and atomic replacement preserve earlier authority on failed commit", async () => {
  f.config.secureCookies = true;
  const login = await start();
  expect(login.response.headers.getSetCookie()[0]).toContain("Secure");
  const previous = await f.signIn();
  const fresh = await start();
  await f.db.unsafe(
    "CREATE FUNCTION fail_login() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected login failure'; END; $$; CREATE CONSTRAINT TRIGGER fail_login AFTER INSERT ON auth_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_login()",
  );
  const failed = await f.request(
    fresh.callback,
    {},
    `${fresh.cookie}; ${previous}`,
  );
  expect(failed.headers.get("Location")).toContain("unavailable");
  expect(
    failed.headers
      .getSetCookie()
      .some((value) => value.startsWith(`${SESSION_COOKIE}=`)),
  ).toBe(false);
  expect((await f.rpc("getMe", {}, previous)).status).toBe(200);
});

test("per-instance quotas reject before mutations and refill without changing upload bytes", async () => {
  await f.close();
  f = await fixture({
    limits: new RateLimits({ uploads: { burst: 1, periodMs: 30 } }),
  });
  const credential = await f.signIn();
  const id = await f.register(credential);
  const empty = new Uint8Array([0, 0]);
  const first = await f.submit(credential, id, empty, crypto.randomUUID(), {
    "X-Mindgrab-Schema-Version": "2",
  });
  expect(first.status).toBe(426);
  const updateId = crypto.randomUUID();
  const limited = await f.submit(credential, id, empty, updateId);
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect(
    (await f.db`SELECT COUNT(*) AS count FROM crdt_receipt`)[0].count,
  ).toBe(0n);
  await Bun.sleep(35);
  // Empty updates do not install a schema; the important contract here is that
  // retry reaches validation with the exact same UUID and bytes.
  expect((await f.submit(credential, id, empty, updateId)).status).toBe(422);
});
