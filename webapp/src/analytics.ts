import type { PostHog } from "posthog-js";
import { createSignal } from "solid-js";
import { backendEndpoint } from "./backend";

// Product analytics. Disabled unless VITE_POSTHOG_KEY is set at build time, so
// local worktrees and browser tests never send events.
//
// Maps are private writing: events carry counts and choices only, never idea
// text, notes, or project names. Autocapture is off because it records the
// text of clicked elements, and replay (enabled from the PostHog dashboard)
// masks all text and inputs.
//
// GDPR: nothing loads or leaves the browser until the visitor chooses.
// Accepting enables cookies and links activity to the account. Declining keeps
// PostHog in cookieless mode: anonymous counts with no stored identifier.
// Events go through the backend's /ingest proxy to PostHog's EU region.
type IdeaKind = "child" | "sibling" | "root" | "parent";
export interface AnalyticsEvents {
  project_created: { trigger: "first_open" | "menu"; project_count?: number };
  project_opened: { idea_count: number };
  project_renamed: Record<string, never>;
  project_saved: { local: boolean };
  project_exported: { format: "json" | "markdown"; idea_count: number };
  project_imported: { idea_count: number; file_kb: number };
  project_list_opened: { project_count: number };
  saving_changed: { local: boolean; cloud: boolean };
  idea_added: { kind: IdeaKind; depth: number; idea_count: number };
  idea_deleted: { removed: number };
  idea_moved: { to_top_level: boolean };
  idea_colored: { scope: "node" | "branch" };
  outline_pasted: { idea_count: number; flattened: boolean };
  search_used: { kept_result: boolean };
  branch_focused: Record<string, never>;
  outline_opened: Record<string, never>;
  notes_opened: Record<string, never>;
  shortcuts_opened: Record<string, never>;
  sign_in_started: { project_count: number };
  signed_out: Record<string, never>;
  anonymous_maps_claimed: { count: number };
  anonymous_maps_claim_dismissed: { count: number };
}
export type AnalyticsEvent = keyof AnalyticsEvents;

export type Consent = "granted" | "denied" | "pending";
export const analyticsEnabled = Boolean(import.meta.env.VITE_POSTHOG_KEY);
const CONSENT_KEY = "mindgrab/analytics-consent";
// Read by the backend to decide whether a sign-up may be linked to the person.
const CONSENT_COOKIE = "mindgrab_analytics_consent";
const QUEUE_LIMIT = 200;

function storedConsent(): Consent {
  try {
    const value = localStorage.getItem(CONSENT_KEY);
    return value === "granted" || value === "denied" ? value : "pending";
  } catch {
    return "pending";
  }
}
const [consent, setConsentState] = createSignal<Consent>(
  analyticsEnabled ? storedConsent() : "denied",
);
const [consentOpen, setConsentOpen] = createSignal(
  analyticsEnabled && consent() === "pending",
);
export { consent, consentOpen };
// Reopens the choice so it can be withdrawn as easily as it was given.
export const reviewConsent = () => analyticsEnabled && setConsentOpen(true);

export interface AnalyticsUser {
  id: number;
  email: string;
  name: string;
}
let client: PostHog | undefined;
let loading: Promise<void> | undefined;
let user: AnalyticsUser | undefined;
// Holds events until the SDK has loaded and the visitor has chosen.
const queue: ((posthog: PostHog) => void)[] = [];

function writeConsentCookie(value: Consent) {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${CONSENT_COOKIE}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

function applyConsent(posthog: PostHog) {
  const status = posthog.get_explicit_consent_status();
  if (consent() === "granted" && status !== "granted")
    posthog.opt_in_capturing({ captureEventName: false });
  else if (consent() === "denied" && status !== "denied")
    posthog.opt_out_capturing();
}

// Identity needs consent; declining keeps every event anonymous.
function syncIdentity(posthog: PostHog) {
  if (consent() !== "granted") return;
  const current =
    posthog.get_property("$user_state") === "identified"
      ? posthog.get_distinct_id()
      : undefined;
  const id = user && String(user.id);
  if (user && id && id !== current)
    posthog.identify(id, { email: user.email, name: user.name });
  else if (!id && current) posthog.reset();
}

function flush() {
  if (!client || consent() === "pending") return;
  syncIdentity(client);
  for (const action of queue.splice(0)) action(client);
}

function run(action: (posthog: PostHog) => void) {
  if (!analyticsEnabled) return;
  queue.push(action);
  if (queue.length > QUEUE_LIMIT) queue.shift();
  flush();
}

async function load() {
  // The literal check lets the bundler drop the SDK from keyless builds.
  if (!import.meta.env.VITE_POSTHOG_KEY || consent() === "pending") return;
  loading ??= (async () => {
    try {
      const { default: posthog } = await import("posthog-js");
      posthog.init(import.meta.env.VITE_POSTHOG_KEY, {
        api_host: backendEndpoint("/ingest"),
        ui_host: "https://eu.posthog.com",
        defaults: "2026-08-30",
        cookieless_mode: "on_reject",
        person_profiles: "identified_only",
        capture_pageview: "history_change",
        autocapture: false,
        rageclick: false,
        capture_dead_clicks: false,
        enable_heatmaps: false,
        capture_exceptions: true,
        session_recording: {
          maskAllInputs: true,
          maskTextSelector: "*",
        },
      });
      applyConsent(posthog);
      client = posthog;
      flush();
    } catch {
      // Analytics never blocks the editor, including offline or blocked hosts.
      loading = undefined;
    }
  })();
  await loading;
}

export function startAnalytics() {
  if (!analyticsEnabled) return Promise.resolve();
  // Another tab may answer the prompt first.
  window.addEventListener("storage", (event) => {
    if (event.key !== CONSENT_KEY) return;
    const next = storedConsent();
    if (next === "pending" || next === consent()) return;
    setConsentState(next);
    setConsentOpen(false);
    if (client) applyConsent(client);
    void load().then(flush);
  });
  if (consent() !== "pending") writeConsentCookie(consent());
  return load();
}

export function setConsent(next: "granted" | "denied") {
  if (!analyticsEnabled) return;
  try {
    localStorage.setItem(CONSENT_KEY, next);
  } catch {
    // The choice still applies to this visit.
  }
  writeConsentCookie(next);
  setConsentState(next);
  setConsentOpen(false);
  if (client) {
    applyConsent(client);
    flush();
  } else void load();
}

export function track<E extends AnalyticsEvent>(
  event: E,
  ...[properties]: AnalyticsEvents[E] extends Record<string, never>
    ? []
    : [AnalyticsEvents[E]]
) {
  run((posthog) => posthog.capture(event, properties));
}

// Links this browser's history to the account after sign-in (with consent).
// After a sign-out, here or in another tab, the identity is reset.
export function identify(next: AnalyticsUser | undefined) {
  user = next;
  if (client) flush();
}
