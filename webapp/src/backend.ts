export function backendEndpoint(path: string): string {
  return new URL(path, import.meta.env.VITE_BACKEND_URL).toString();
}
