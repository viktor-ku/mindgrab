export function backendEndpoint(path: string): string {
  const base =
    import.meta.env.VITE_BACKEND_URL ||
    globalThis.location?.origin ||
    "http://localhost:5173";
  return new URL(path, base).toString();
}
