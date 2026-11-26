import { expect, test } from "bun:test";
import { ingestUrl } from "../src/ingest-url";

const rewritten = (url: string) => ingestUrl(new URL(url)).href;

test("the SDK's path moves into the query, and its own parameters stay", () => {
  expect(rewritten("https://api.mindgrab.app/ingest.php/e/")).toBe(
    "https://api.mindgrab.app/ingest.php?r=%2Fe%2F",
  );
  expect(rewritten("https://api.mindgrab.app/ingest.php/flags/?v=2")).toBe(
    "https://api.mindgrab.app/ingest.php?v=2&r=%2Fflags%2F",
  );
  expect(
    rewritten(
      "http://localhost:5173/ingest.php/static/1.444.0/posthog-recorder.js",
    ),
  ).toBe(
    "http://localhost:5173/ingest.php?r=%2Fstatic%2F1.444.0%2Fposthog-recorder.js",
  );
});

test("a URL that is already rewritten, or is not the proxy's, is left alone", () => {
  const once = rewritten("https://api.mindgrab.app/ingest.php/s/");
  expect(rewritten(once)).toBe(once);
  expect(rewritten("https://eu.posthog.com/project/1/replay/")).toBe(
    "https://eu.posthog.com/project/1/replay/",
  );
});
