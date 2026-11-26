import { afterAll, expect, mock, test } from "bun:test";

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

test("nothing is sent before the visitor chooses, and declining never identifies", async () => {
  expect(analytics.consentOpen()).toBe(true);
  await analytics.startAnalytics();
  analytics.track("idea_added", { kind: "child", depth: 2, idea_count: 3 });
  analytics.identify(user);
  await Bun.sleep(0);
  expect(calls).toEqual([]);

  analytics.setConsent("denied");
  await Bun.sleep(10);
  // The backend's proxy answers only its one URL, so the SDK must be given the
  // hook that moves its paths into the query.
  const [, , options] = calls.find(([name]) => name === "init") as [
    string,
    string,
    { api_host: string; rewriteRequestPath: (url: URL) => URL },
  ];
  expect(options.api_host).toEndWith("/ingest.php");
  expect(
    options.rewriteRequestPath(new URL(`${options.api_host}/e/`)).href,
  ).toBe(`${options.api_host}?r=%2Fe%2F`);
  calls.length = 0;
  analytics.identify(user);
  analytics.track("signed_out");
  expect(names()).toEqual(["capture"]);
  expect(document.cookie).toContain("mindgrab_analytics_consent=denied");
});
