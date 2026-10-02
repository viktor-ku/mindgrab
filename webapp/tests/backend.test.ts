import { expect, test } from "bun:test";
import type * as Backend from "../src/backend";

async function backend(dev: boolean, url: string): Promise<typeof Backend> {
  const result = await Bun.build({
    entrypoints: [`${import.meta.dir}/../src/backend.ts`],
    target: "browser",
    format: "esm",
    define: {
      "import.meta.env.DEV": JSON.stringify(dev),
      "import.meta.env.VITE_BACKEND_URL": JSON.stringify(url),
      "globalThis.location": JSON.stringify({
        origin: "http://localhost:5173",
      }),
    },
  });
  if (!result.success) throw new AggregateError(result.logs);
  return import(
    `data:text/javascript;base64,${Buffer.from(await result.outputs[0].text()).toString("base64")}`
  );
}

test("development uses the browser origin for requests and retains the configured storage deployment", async () => {
  const api = await backend(true, "http://localhost:3000");
  expect(api.backendEndpoint("/api/getMe")).toBe(
    "http://localhost:5173/api/getMe",
  );
  expect(api.backendEndpoint("/api/startLogin")).toBe(
    "http://localhost:5173/api/startLogin",
  );
  expect(api.backendEndpoint("/sync/v1")).toBe("http://localhost:5173/sync/v1");
  expect(api.backendDeployment()).toBe("http://localhost:3000");
});

test("production keeps an explicitly configured API origin", async () => {
  const api = await backend(false, "https://api.example.com/");
  expect(api.backendEndpoint("/api/getMe")).toBe(
    "https://api.example.com/api/getMe",
  );
  expect(api.backendDeployment()).toBe("https://api.example.com");
});

test("same-origin deployments use the browser origin for requests and storage", async () => {
  const api = await backend(false, "");
  expect(api.backendEndpoint("/api/getMe")).toBe(
    "http://localhost:5173/api/getMe",
  );
  expect(api.backendDeployment()).toBe("http://localhost:5173");
});
