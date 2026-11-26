// The backend's analytics proxy has one URL, /ingest.php. The PostHog SDK
// appends its own path to api_host (/ingest.php/e/), so that path moves into
// the query, where the backend reads it: /ingest.php?r=%2Fe%2F. See
// backend/src/analytics.rs for the paths it forwards.
//
// The SDK calls this for every request it builds and adds its own parameters
// afterwards by splitting on "?" and "=", so the route stays percent-encoded
// and the rest of the query is kept.
export const INGEST_PATH = "/ingest.php";

export function ingestUrl(url: URL) {
  if (!url.pathname.startsWith(`${INGEST_PATH}/`)) return url;
  const route = url.pathname.slice(INGEST_PATH.length);
  url.pathname = INGEST_PATH;
  url.searchParams.set("r", route);
  return url;
}
