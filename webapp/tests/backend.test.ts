import { afterAll, beforeEach, expect, test } from "bun:test";
import { backendCookieDomain } from "../src/backend";

const location = Object.getOwnPropertyDescriptor(globalThis, "location");
const backend = process.env.VITE_BACKEND_URL;

function visit(url: string) {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: new URL(url),
  });
}

beforeEach(() => {
  delete process.env.VITE_BACKEND_URL;
});

afterAll(() => {
  if (location) Object.defineProperty(globalThis, "location", location);
  else Reflect.deleteProperty(globalThis, "location");
  if (backend === undefined) delete process.env.VITE_BACKEND_URL;
  else process.env.VITE_BACKEND_URL = backend;
});

test("cookies reach a backend on a subdomain of the page", () => {
  visit("https://mindgrab.app/");
  process.env.VITE_BACKEND_URL = "https://api.mindgrab.app";
  expect(backendCookieDomain()).toBe("mindgrab.app");
});

test("cookies stay host-only on the page's own origin and on other sites", () => {
  visit("http://localhost:5173/");
  expect(backendCookieDomain()).toBeUndefined();
  visit("https://mindgrab.app/");
  process.env.VITE_BACKEND_URL = "https://notmindgrab.app";
  expect(backendCookieDomain()).toBeUndefined();
});
