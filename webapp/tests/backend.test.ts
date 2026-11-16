import { afterAll, expect, test } from "bun:test";
import { backendCookieDomain } from "../src/backend";

const location = Object.getOwnPropertyDescriptor(globalThis, "location");
const backend = process.env.VITE_BACKEND_URL;

function visit(url: string) {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: new URL(url),
  });
}

afterAll(() => {
  if (location) Object.defineProperty(globalThis, "location", location);
  else Reflect.deleteProperty(globalThis, "location");
  if (backend === undefined) delete process.env.VITE_BACKEND_URL;
  else process.env.VITE_BACKEND_URL = backend;
});

// Login cookies are SameSite=Lax, so they must be shared with the API's
// subdomain, and with nothing else.
test("cookies reach a backend on a subdomain of the page and nowhere else", () => {
  visit("https://mindgrab.app/");
  process.env.VITE_BACKEND_URL = "https://api.mindgrab.app";
  expect(backendCookieDomain()).toBe("mindgrab.app");
  process.env.VITE_BACKEND_URL = "https://notmindgrab.app";
  expect(backendCookieDomain()).toBeUndefined();
  delete process.env.VITE_BACKEND_URL;
  visit("http://localhost:5173/");
  expect(backendCookieDomain()).toBeUndefined();
});
