import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const calls: unknown[][] = [];
let userState = "anonymous";
let distinctId = "anon";
let consentStatus: "granted" | "denied" | "pending" = "pending";
const posthog = {
  init: (...args: unknown[]) => calls.push(["init", ...args]),
  capture: (...args: unknown[]) => calls.push(["capture", ...args]),
  identify: (id: string, ...args: unknown[]) => {
    userState = "identified";
    distinctId = id;
    calls.push(["identify", id, ...args]);
  },
  reset: () => {
    userState = "anonymous";
    distinctId = "anon";
    calls.push(["reset"]);
  },
  opt_in_capturing: () => {
    consentStatus = "granted";
    calls.push(["opt_in"]);
  },
  opt_out_capturing: () => {
    consentStatus = "denied";
    userState = "anonymous";
    distinctId = "anon";
    calls.push(["opt_out"]);
  },
  get_explicit_consent_status: () => consentStatus,
  get_distinct_id: () => distinctId,
  get_property: (name: string) =>
    name === "$user_state" ? userState : undefined,
};
mock.module("posthog-js", () => ({ default: posthog }));
const storage = new Map<string, string>();
const originalGlobals = Object.getOwnPropertyDescriptors(globalThis);
afterAll(() => {
  for (const key of ["localStorage", "document", "location", "window"]) {
    const descriptor = originalGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
  document: { cookie: "" },
  location: { protocol: "https:", origin: "https://mindgrab.example" },
  window: { addEventListener: () => {} },
});
process.env.VITE_POSTHOG_KEY = "phc_test";
const analytics = await import("../src/analytics");
const names = () => calls.map(([name]) => name);
const user = { id: 7, email: "ada@example.com", name: "Ada" };

beforeEach(() => {
  calls.length = 0;
});

test("nothing loads or is sent before the visitor chooses", async () => {
  expect(analytics.consentOpen()).toBe(true);
  await analytics.startAnalytics();
  analytics.track("idea_added", { kind: "child", depth: 2, idea_count: 3 });
  analytics.identify(user);
  await Bun.sleep(0);
  expect(calls).toEqual([]);
});

test("accepting loads the SDK through the proxy, then identifies and sends held events", async () => {
  analytics.setConsent("granted");
  await Bun.sleep(10);
  expect(names()).toEqual(["init", "opt_in", "identify", "capture"]);
  expect(calls[0]?.[1]).toBe("phc_test");
  expect(calls[0]?.[2]).toMatchObject({
    api_host: "https://mindgrab.example/ingest",
    cookieless_mode: "on_reject",
    autocapture: false,
  });
  expect(calls[2]).toEqual([
    "identify",
    "7",
    { email: "ada@example.com", name: "Ada" },
  ]);
  expect(storage.get("mindgrab/analytics-consent")).toBe("granted");
  expect(document.cookie).toContain("mindgrab_analytics_consent=granted");
  expect(analytics.consentOpen()).toBe(false);
});

test("repeat account checks identify once, and sign-out resets", () => {
  analytics.identify(user);
  expect(calls).toEqual([]);
  analytics.identify(undefined);
  expect(calls).toEqual([["reset"]]);
});

test("declining keeps capturing cookieless and never identifies", () => {
  analytics.setConsent("denied");
  analytics.identify(user);
  analytics.track("signed_out");
  expect(names()).toEqual(["opt_out", "capture"]);
  expect(document.cookie).toContain("mindgrab_analytics_consent=denied");
});
