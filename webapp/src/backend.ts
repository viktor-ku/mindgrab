export function backendDeployment(): string {
  const base =
    import.meta.env.VITE_BACKEND_URL ||
    globalThis.location?.origin ||
    "http://localhost:5173";
  return new URL(base).origin;
}

export function backendEndpoint(path: string): string {
  // Vite proxies requests in development. Keep cookies and auth redirects on
  // the browser's origin, while retaining the configured storage namespace.
  const base =
    (import.meta.env.DEV && globalThis.location?.origin) || backendDeployment();
  return new URL(path, base).toString();
}
