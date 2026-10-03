import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SQL } from "bun";
import type { Config } from "./config";
import { type Database, one } from "./db";
import { AuthError } from "./errors";
import { type IdentityProvider, userName, type WorkOsUser } from "./workos";

export const SESSION_COOKIE = "mindgrab_session_v2";
export const STATE_COOKIE = "mindgrab_login";
export const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
export const randomToken = () => randomBytes(32).toString("base64url");

export interface User {
  id: bigint;
  name: string;
  email: string;
  external_id: string;
  session: string;
}

interface ProviderSession {
  token_hash: string;
  user_id: bigint;
  workos_session_id: string;
  access_token: string;
  refresh_token: string;
}

export function cookies(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  for (const field of (request.headers.get("cookie") ?? "").split(";")) {
    const index = field.indexOf("=");
    if (index < 0) continue;
    const key = field.slice(0, index).trim();
    if (result.has(key)) {
      result.set(key, "");
      continue;
    }
    result.set(key, field.slice(index + 1).trim());
  }
  return result;
}

export function cookie(
  config: Config,
  name: string,
  value: string,
  seconds: number,
) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${config.secureCookies ? "; Secure" : ""}`;
}

export class Auth {
  constructor(
    readonly db: SQL,
    readonly config: Config,
    readonly provider: IdentityProvider,
  ) {}

  async start(request: Request) {
    try {
      const nonce = randomToken();
      const verifier = randomToken();
      const previous = cookies(request).get(STATE_COOKIE);
      await this.db.begin(async (tx) => {
        if (previous)
          await tx`DELETE FROM auth_login_attempts WHERE state_hash = ${tokenHash(previous)}`;
        await tx`INSERT INTO auth_login_attempts (state_hash, code_verifier) VALUES (${tokenHash(nonce)}, ${verifier})`;
      });
      return new Response(null, {
        status: 303,
        headers: {
          Location: this.provider.authorizationUrl(
            this.config.redirectUri,
            nonce,
            tokenHash(verifier),
          ).href,
          "Set-Cookie": cookie(this.config, STATE_COOKIE, nonce, 600),
        },
      });
    } catch {
      throw new AuthError("unavailable");
    }
  }

  async callback(request: Request) {
    const url = new URL(request.url);
    for (const key of ["code", "state", "error"]) {
      if (url.searchParams.getAll(key).length > 1)
        return new Response("Invalid callback", { status: 400 });
    }
    const jar = cookies(request);
    const headers = new Headers({
      "Set-Cookie": cookie(this.config, STATE_COOKIE, "", 0),
    });
    let destination = this.config.appUrl;
    try {
      const nonce = url.searchParams.get("state");
      const browserNonce = jar.get(STATE_COOKIE);
      if (
        !nonce ||
        !browserNonce ||
        !timingSafeEqual(
          Buffer.from(tokenHash(nonce)),
          Buffer.from(tokenHash(browserNonce)),
        )
      )
        throw new AuthError("unauthorized");
      const attempt = await one<{ code_verifier: string }>(
        this.db,
        "DELETE FROM auth_login_attempts WHERE state_hash = $1 AND expires_at > NOW() RETURNING code_verifier",
        [tokenHash(nonce)],
      );
      if (!attempt || url.searchParams.has("error"))
        throw new AuthError("unauthorized");
      const code = url.searchParams.get("code");
      if (!code) throw new AuthError("unauthorized");
      const authentication = await this.provider.exchange(
        code,
        attempt.code_verifier,
      );
      const claims = await this.provider.verify(authentication.access_token);
      if (
        claims.exp <= Date.now() / 1000 ||
        claims.sub !== authentication.user.id
      )
        throw new AuthError("unauthorized");
      const credential = randomToken();
      const authority = tokenHash(randomToken());
      await this.db.begin(async (tx) => {
        const user = await this.upsert(tx, authentication.user);
        await tx`INSERT INTO auth_sessions (token_hash, user_id, workos_session_id, access_token, refresh_token, browser_hash)
          VALUES (${authority}, ${user.id}, ${claims.sid}, ${authentication.access_token}, ${authentication.refresh_token}, ${tokenHash(credential)})`;
        const previous = jar.get(SESSION_COOKIE);
        if (previous)
          await tx`DELETE FROM auth_sessions WHERE browser_hash = ${tokenHash(previous)} AND token_hash <> ${authority}`;
      });
      // Publish a browser credential only after the complete transaction commits.
      headers.append(
        "Set-Cookie",
        cookie(this.config, SESSION_COOKIE, credential, 2592000),
      );
    } catch (error) {
      destination = `${this.config.appUrl}?auth_error=${error instanceof AuthError && error.kind === "unauthorized" ? "sign_in_failed" : "unavailable"}`;
    }
    headers.set("Location", destination);
    return new Response(null, { status: 303, headers });
  }

  private async upsert(tx: Database, user: WorkOsUser) {
    const stored = await one<Omit<User, "session">>(
      tx,
      "INSERT INTO users (name, email, external_id) VALUES ($1, $2, $3) ON CONFLICT (external_id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email RETURNING id, name, email, external_id",
      [userName(user), user.email, user.id],
    );
    if (!stored) throw new AuthError("unavailable");
    return stored;
  }

  async identify(request: Request): Promise<User> {
    const credential = cookies(request).get(SESSION_COOKIE);
    if (!credential) throw new AuthError("unauthorized");
    try {
      const record = await one<{ token_hash: string }>(
        this.db,
        "SELECT token_hash FROM auth_sessions WHERE browser_hash = $1 AND expires_at > NOW()",
        [tokenHash(credential)],
      );
      if (!record) throw new AuthError("unauthorized");
      return await this.validate(record.token_hash);
    } catch (error) {
      throw error instanceof AuthError ? error : new AuthError("unavailable");
    }
  }

  // Refresh rotation remains serialized by the database even across processes.
  // Cached browser identity never bypasses provider/session verification.
  async validate(session: string): Promise<User> {
    try {
      const result = await this.db.begin(async (tx) => {
        const record = await one<ProviderSession>(
          tx,
          "SELECT token_hash, user_id, workos_session_id, access_token, refresh_token FROM auth_sessions WHERE token_hash = $1 AND expires_at > NOW() FOR UPDATE",
          [session],
        );
        if (!record) return new AuthError("unauthorized");
        try {
          const claims = await this.provider.verify(record.access_token);
          const user = await one<Omit<User, "session">>(
            tx,
            "SELECT id, name, email, external_id FROM users WHERE id = $1",
            [record.user_id],
          );
          if (
            !user ||
            claims.sub !== user.external_id ||
            claims.sid !== record.workos_session_id
          )
            throw new AuthError("unauthorized");
          if (claims.exp > Date.now() / 1000 + 30) return { ...user, session };
          const authentication = await this.provider.refresh(
            record.refresh_token,
          );
          const refreshed = await this.provider.verify(
            authentication.access_token,
          );
          if (
            refreshed.exp <= Date.now() / 1000 ||
            refreshed.sub !== user.external_id ||
            refreshed.sid !== record.workos_session_id ||
            authentication.user.id !== user.external_id
          )
            throw new AuthError("unauthorized");
          await tx`UPDATE auth_sessions SET access_token = ${authentication.access_token}, refresh_token = ${authentication.refresh_token} WHERE token_hash = ${session}`;
          return { ...(await this.upsert(tx, authentication.user)), session };
        } catch (error) {
          if (error instanceof AuthError && error.kind === "unauthorized") {
            await tx`DELETE FROM auth_sessions WHERE token_hash = ${session}`;
            return error;
          }
          throw error;
        }
      });
      if (result instanceof AuthError) throw result;
      return result;
    } catch (error) {
      throw error instanceof AuthError ? error : new AuthError("unavailable");
    }
  }

  async logout(request: Request) {
    const jar = cookies(request);
    let destination = this.config.appUrl;
    try {
      await this.db.begin(async (tx) => {
        const credential = jar.get(SESSION_COOKIE);
        if (credential) {
          const row = await one<{ workos_session_id: string }>(
            tx,
            "DELETE FROM auth_sessions WHERE browser_hash = $1 RETURNING workos_session_id",
            [tokenHash(credential)],
          );
          if (row)
            destination = this.provider.logoutUrl(
              row.workos_session_id,
              this.config.appUrl,
            ).href;
        }
        const nonce = jar.get(STATE_COOKIE);
        if (nonce)
          await tx`DELETE FROM auth_login_attempts WHERE state_hash = ${tokenHash(nonce)}`;
      });
    } catch {
      throw new AuthError("unavailable");
    }
    const headers = new Headers({ Location: destination });
    for (const name of [SESSION_COOKIE, STATE_COOKIE])
      headers.append("Set-Cookie", cookie(this.config, name, "", 0));
    return new Response(null, { status: 303, headers });
  }

  async cleanup() {
    await this.db`DELETE FROM auth_sessions WHERE expires_at <= NOW()`;
    await this.db`DELETE FROM auth_login_attempts WHERE expires_at <= NOW()`;
  }
}

export function publicUser(user: User) {
  if (user.id > BigInt(Number.MAX_SAFE_INTEGER))
    throw new AuthError("unavailable");
  return {
    id: Number(user.id),
    name: user.name,
    email: user.email,
    external_id: user.external_id,
  };
}
