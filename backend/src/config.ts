export interface Config {
  databaseUrl: string;
  clientId: string;
  apiKey: string;
  redirectUri: string;
  appUrl: string;
  issuer: string;
  secureCookies: boolean;
}

export const loopback = (host: string) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(host);
export const defaultIssuer = (clientId: string) =>
  `https://api.workos.com/user_management/${clientId}`;
export const origin = (config: Config) => new URL(config.appUrl).origin;

function authenticationUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid authentication URL");
  }
  if (
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && loopback(url.hostname))
    ) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Authentication URLs require HTTPS (HTTP is allowed on loopback only), with no credentials, query, or fragment",
    );
  }
  return url;
}

export function readConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const required = (key: string) => {
    const value = env[key];
    if (!value?.trim())
      throw new Error(`Missing ${key}; configure it in the root .env`);
    return value;
  };
  const clientId = required("WORKOS_CLIENT_ID");
  const redirectUri = required("WORKOS_REDIRECT_URI");
  const redirect = authenticationUrl(redirectUri);
  if (redirect.pathname !== "/api/auth/callback")
    throw new Error("WORKOS_REDIRECT_URI must end with /api/auth/callback");
  const app = authenticationUrl(env.APP_URL ?? `${redirect.origin}/`);
  if (app.origin !== redirect.origin || app.pathname !== "/")
    throw new Error("APP_URL must be the root URL on the callback's origin");
  return {
    databaseUrl:
      env.DATABASE_URL ?? "postgres://postgres@localhost:5432/mindgrab",
    clientId,
    apiKey: required("WORKOS_API_KEY"),
    redirectUri,
    appUrl: app.href,
    issuer: (env.WORKOS_ISSUER ?? defaultIssuer(clientId)).replace(/\/+$/, ""),
    secureCookies: app.protocol === "https:",
  };
}

export function isLocalDatabase(value: string) {
  try {
    const url = new URL(value);
    return (
      ["postgres:", "postgresql:"].includes(url.protocol) &&
      loopback(url.hostname) &&
      url.pathname === "/mindgrab"
    );
  } catch {
    return false;
  }
}
