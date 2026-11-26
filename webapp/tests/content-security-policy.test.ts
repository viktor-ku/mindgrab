import { expect, test } from "bun:test";
import { contentSecurityPolicy } from "../scripts/content-security-policy";

function directive(policy: string, name: string) {
  const found = policy
    .split("; ")
    .map((part) => part.split(" "))
    .find(([first]) => first === name);
  return found?.slice(1);
}

test("an API on another origin is allowed for requests, sockets, PostHog scripts and sign-in", () => {
  // A path or trailing slash on the variable is not part of the origin.
  const policy = contentSecurityPolicy("https://api.mindgrab.app/");
  expect(directive(policy, "connect-src")).toEqual([
    "'self'",
    "https://api.mindgrab.app",
    "wss://api.mindgrab.app",
  ]);
  expect(directive(policy, "script-src")).toEqual([
    "'self'",
    "'wasm-unsafe-eval'",
    "https://api.mindgrab.app/ingest.php/",
  ]);
  expect(directive(policy, "form-action")).toContain(
    "https://api.mindgrab.app",
  );
});

test("a plain HTTP API gets a plain WebSocket source", () => {
  expect(
    directive(contentSecurityPolicy("http://localhost:3000"), "connect-src"),
  ).toEqual(["'self'", "http://localhost:3000", "ws://localhost:3000"]);
});

test("without a backend URL the app's own origin is the only API", () => {
  const policy = contentSecurityPolicy(undefined);
  expect(directive(policy, "connect-src")).toEqual(["'self'"]);
  expect(directive(policy, "script-src")).toEqual([
    "'self'",
    "'wasm-unsafe-eval'",
  ]);
  expect(policy).not.toContain("undefined");
});
