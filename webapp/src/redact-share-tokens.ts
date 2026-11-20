import type { CaptureResult } from "posthog-js";

// A share link's token is its only credential, and PostHog copies the page
// URL into most event properties ($current_url, $pathname, $referrer, their
// $initial_ and $set copies, exception frames) and into replay recordings.
// Every string an event carries is rewritten before it leaves the browser:
// share paths become /s/:token, and "token" fields in recorded request bodies
// are blanked the same way.
const SHARE_PATH = /(\/(?:s|ws\/share)\/)[A-Za-z0-9_-]+/g;
const TOKEN_FIELD = /("token"\s*:\s*")[A-Za-z0-9_-]+/g;
const PLACEHOLDER = "$1:token";

export function redactShareTokens(text: string) {
  return text
    .replace(SHARE_PATH, PLACEHOLDER)
    .replace(TOKEN_FIELD, PLACEHOLDER);
}

// Returns the same reference when nothing changed, so large replay payloads
// are not copied.
function redact(value: unknown): unknown {
  if (typeof value === "string") return redactShareTokens(value);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = redact(item);
      if (result !== item) changed = true;
      return result;
    });
    return changed ? next : value;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    let next: Record<string, unknown> | undefined;
    for (const [key, item] of Object.entries(value)) {
      const result = redact(item);
      if (result === item) continue;
      next ??= { ...value };
      next[key] = result;
    }
    return next ?? value;
  }
  return value;
}

export function redactEvent(event: CaptureResult | null) {
  if (!event) return event;
  const next = {
    ...event,
    properties: redact(event.properties) as CaptureResult["properties"],
  };
  if (event.$set) next.$set = redact(event.$set) as CaptureResult["$set"];
  if (event.$set_once)
    next.$set_once = redact(event.$set_once) as CaptureResult["$set_once"];
  return next;
}
