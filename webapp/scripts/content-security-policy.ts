// Prints the Caddy snippet that webapp/Caddyfile imports: the app's Content
// Security Policy. webapp/Dockerfile runs it with the same VITE_BACKEND_URL
// the bundle is built with, so the policy always names the API the app calls.
//
// The header's name comes from CSP_HEADER when Caddy starts. It defaults to
// the Report-Only header, which blocks nothing and logs what the policy would
// have blocked to the browser console.

// The API when it is on another origin. Left unset, the app calls its own
// origin, which 'self' covers, WebSocket included.
function apiOrigins(backendUrl: string | undefined) {
  if (!backendUrl) return undefined;
  const http = new URL(backendUrl).origin;
  return { http, ws: http.replace(/^http/, "ws") };
}

export function contentSecurityPolicy(backendUrl: string | undefined) {
  const api = apiOrigins(backendUrl);
  const directives: [string, ...(string | undefined)[]][] = [
    ["default-src", "'self'"],
    [
      "script-src",
      "'self'",
      // The Rust state module is WebAssembly.
      "'wasm-unsafe-eval'",
      // PostHog loads its config and lazy scripts (replay, exceptions) through
      // the API's proxy.
      api && `${api.http}/ingest.php/`,
    ],
    // Tiptap adds a style element, and ProseMirror and the image export write
    // style attributes.
    ["style-src", "'self'", "'unsafe-inline'"],
    // The image export draws the map from a data: URL and previews a blob:.
    ["img-src", "'self'", "data:", "blob:"],
    ["font-src", "'self'"],
    ["connect-src", "'self'", api?.http, api?.ws],
    // PostHog's replay recorder starts its worker from a blob:.
    ["worker-src", "'self'", "blob:"],
    [
      "form-action",
      "'self'",
      // Signing in and out posts a form to the API, which redirects through
      // WorkOS and its hosted AuthKit page. Chromium checks every redirect
      // that follows a form post, so each host on the way must be listed.
      api?.http,
      "https://api.workos.com",
      "https://*.authkit.app",
    ],
    ["frame-ancestors", "'none'"],
    // Not 'none': the image export resolves the stylesheet's font URLs with a
    // base element in a scratch document, which this policy also covers.
    ["base-uri", "'self'"],
    ["object-src", "'none'"],
  ];
  return directives
    .map((directive) => directive.filter(Boolean).join(" "))
    .join("; ");
}

if (import.meta.main) {
  const policy = contentSecurityPolicy(process.env.VITE_BACKEND_URL);
  process.stdout.write(
    `header {$CSP_HEADER:Content-Security-Policy-Report-Only} "${policy}"\n`,
  );
}
