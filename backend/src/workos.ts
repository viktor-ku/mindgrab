import {
  createLocalJWKSet,
  decodeProtectedHeader,
  flattenedVerify,
} from "jose";
import { z } from "zod";
import type { Config } from "./config";
import { AuthError } from "./errors";

const UserSchema = z.object({
  id: z.string().min(1),
  email: z.string(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
});
const AuthenticationSchema = z.object({
  user: UserSchema,
  access_token: z.string(),
  refresh_token: z.string(),
});
export type WorkOsUser = z.infer<typeof UserSchema>;
export type Authentication = z.infer<typeof AuthenticationSchema>;
export interface Claims {
  sub: string;
  sid: string;
  exp: number;
  client_id: string;
}

export interface IdentityProvider {
  authorizationUrl(redirect: string, state: string, challenge: string): URL;
  logoutUrl(sessionId: string, returnTo: string): URL;
  exchange(code: string, verifier: string): Promise<Authentication>;
  refresh(token: string): Promise<Authentication>;
  verify(token: string): Promise<Claims>;
}

export function userName(user: WorkOsUser) {
  return (
    [user.first_name, user.last_name].filter(Boolean).join(" ").trim() ||
    user.email
  );
}

export class WorkOs implements IdentityProvider {
  private keys?: {
    time: number;
    resolve: ReturnType<typeof createLocalJWKSet>;
    kids: Set<string>;
  };
  private fetching?: Promise<void>;

  constructor(
    private config: Config,
    private apiBase = "https://api.workos.com",
  ) {}

  authorizationUrl(redirect: string, state: string, challenge: string) {
    const url = new URL("/user_management/authorize", this.apiBase);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: redirect,
      response_type: "code",
      provider: "authkit",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return url;
  }

  logoutUrl(sessionId: string, returnTo: string) {
    const url = new URL("/user_management/sessions/logout", this.apiBase);
    url.search = new URLSearchParams({
      session_id: sessionId,
      return_to: returnTo,
    }).toString();
    return url;
  }

  exchange(code: string, verifier: string) {
    return this.authenticate({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
    });
  }

  async refresh(token: string) {
    try {
      return await this.authenticate({
        grant_type: "refresh_token",
        refresh_token: token,
      });
    } catch (error) {
      if (!(error instanceof AuthError) || error.kind !== "unavailable")
        throw error;
      await Bun.sleep(250);
      return this.authenticate({
        grant_type: "refresh_token",
        refresh_token: token,
      });
    }
  }

  private async authenticate(
    body: Record<string, string>,
  ): Promise<Authentication> {
    let response: Response;
    try {
      response = await fetch(
        new URL("/user_management/authenticate", this.apiBase),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...body,
            client_id: this.config.clientId,
            client_secret: this.config.apiKey,
          }),
          redirect: "manual",
          signal: AbortSignal.timeout(8000),
        },
      );
    } catch {
      throw new AuthError("unavailable");
    }
    if (!response.ok) {
      const result = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new AuthError(
        response.status === 400 && result?.error === "invalid_grant"
          ? "unauthorized"
          : "unavailable",
      );
    }
    try {
      return AuthenticationSchema.parse(await response.json());
    } catch {
      throw new AuthError("unavailable");
    }
  }

  private async loadKeys() {
    if (this.fetching) return this.fetching;
    this.fetching = (async () => {
      try {
        const response = await fetch(
          new URL(`/sso/jwks/${this.config.clientId}`, this.apiBase),
          { redirect: "manual", signal: AbortSignal.timeout(8000) },
        );
        if (!response.ok) throw new AuthError("unavailable");
        const jwks = (await response.json()) as Parameters<
          typeof createLocalJWKSet
        >[0];
        this.keys = {
          time: Date.now(),
          resolve: createLocalJWKSet(jwks),
          kids: new Set(
            jwks.keys
              .map((key) => key.kid)
              .filter((kid): kid is string => typeof kid === "string"),
          ),
        };
      } catch {
        throw new AuthError("unavailable");
      }
    })();
    try {
      await this.fetching;
    } finally {
      this.fetching = undefined;
    }
  }

  async verify(token: string): Promise<Claims> {
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      throw new AuthError("unauthorized");
    }
    if (header.alg !== "RS256" || !header.kid)
      throw new AuthError("unauthorized");
    if (
      !this.keys ||
      Date.now() - this.keys.time > 3600000 ||
      !this.keys.kids.has(header.kid)
    )
      await this.loadKeys();
    try {
      // Verify signatures independently of expiry: callers refresh a signed,
      // expired token while enforcing issuer, audience, nbf and identity here.
      const [protectedHeader, payload, signature, extra] = token.split(".");
      if (
        extra !== undefined ||
        !protectedHeader ||
        !payload ||
        !signature ||
        !this.keys
      )
        throw new Error("Invalid token");
      const verified = await flattenedVerify(
        { protected: protectedHeader, payload, signature },
        this.keys.resolve,
        { algorithms: ["RS256"] },
      );
      const claims = JSON.parse(new TextDecoder().decode(verified.payload));
      const valid = z
        .object({
          sub: z.string().min(1),
          sid: z.string().min(1),
          exp: z.number().int().nonnegative(),
          client_id: z.literal(this.config.clientId),
          iss: z.enum([this.config.issuer, `${this.config.issuer}/`]),
          aud: z
            .union([
              z.literal(this.config.clientId),
              z
                .array(z.string())
                .refine((values) => values.includes(this.config.clientId)),
            ])
            .optional(),
          nbf: z.number().optional(),
        })
        .parse(claims);
      if (valid.nbf !== undefined && valid.nbf > Date.now() / 1000)
        throw new Error("Token not yet valid");
      return valid;
    } catch {
      throw new AuthError("unauthorized");
    }
  }
}
