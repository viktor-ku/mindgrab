export function backendDeployment(): string {
  const base =
    import.meta.env.VITE_BACKEND_URL ||
    globalThis.location?.origin ||
    "http://localhost:5173";
  return new URL(base).origin;
}

// A cookie the backend reads must be scoped to the page's domain to reach a
// backend on a subdomain of it, such as api.mindgrab.app.
export function backendCookieDomain(): string | undefined {
  const page = globalThis.location?.hostname;
  if (!page) return undefined;
  return new URL(backendDeployment()).hostname.endsWith(`.${page}`)
    ? page
    : undefined;
}

export function backendEndpoint(path: string): string {
  // Vite proxies requests in development. Keep cookies and auth redirects on
  // the browser's origin, while retaining the configured storage namespace.
  const base =
    (import.meta.env.DEV && globalThis.location?.origin) || backendDeployment();
  return new URL(path, base).toString();
}
