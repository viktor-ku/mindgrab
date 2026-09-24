// Development requests go through Vite's proxy to preserve same-origin auth.
const backendUrl = import.meta.env.DEV
  ? ""
  : (import.meta.env.VITE_BACKEND_URL ?? "").replace(/\/+$/, "");

export function backendEndpoint(path: string): string {
  return `${backendUrl}${path}`;
}
