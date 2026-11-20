import { expect, test } from "bun:test";
import type { CaptureResult } from "posthog-js";
import { redactEvent } from "../src/redact-share-tokens";

// Same shape as the backend's tokens: 32 random bytes, base64url, no padding.
const token = "Q2h1bmt5LWJhY29uLXN0cmlwcy1hcmUtdGFzdHktMTI";
const page = `https://mindgrab.app/s/${token}`;

test("no share token survives in any event property or recording", () => {
  const timestamp = new Date();
  const events: CaptureResult[] = [
    {
      uuid: "1",
      event: "$pageview",
      timestamp,
      properties: {
        $current_url: page,
        $pathname: `/s/${token}`,
        $referrer: `${page}?from=copy#top`,
        $prev_pageview_pathname: `/s/${token}`,
        $initial_current_url: page,
        $initial_pathname: `/s/${token}`,
        idea_count: 3,
        $set: { $current_url: page },
      },
      $set: { $pathname: `/s/${token}` },
      $set_once: { $initial_referrer: page, $initial_current_url: page },
    },
    {
      uuid: "2",
      event: "$exception",
      properties: {
        $current_url: page,
        $exception_list: [
          {
            value: `Failed to load ${page}`,
            stacktrace: { frames: [{ filename: page, lineno: 1 }] },
          },
        ],
      },
    },
    {
      uuid: "3",
      event: "$snapshot",
      properties: {
        $snapshot_data: [
          { type: 4, data: { href: page } },
          {
            type: 6,
            data: {
              payload: {
                requests: [
                  {
                    name: `wss://api.mindgrab.app/ws/share/${token}`,
                    requestBody: JSON.stringify({ token }),
                  },
                ],
              },
            },
          },
        ],
      },
    },
  ];
  for (const event of events) {
    const sent = redactEvent(event);
    expect(JSON.stringify(sent)).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(JSON.stringify(sent)).toContain(":token");
  }
  const pageview = redactEvent(events[0]);
  expect(pageview?.properties.$current_url).toBe(
    "https://mindgrab.app/s/:token",
  );
  expect(pageview?.properties.$referrer).toBe(
    "https://mindgrab.app/s/:token?from=copy#top",
  );
  expect(pageview?.properties.idea_count).toBe(3);
  expect(pageview?.timestamp).toBe(timestamp);
  // The page's own event is left as captured.
  expect(events[0].properties.$current_url).toBe(page);
});

test("events without share links pass through untouched", () => {
  const properties = { $current_url: "https://mindgrab.app/", idea_count: 2 };
  const event: CaptureResult = { uuid: "4", event: "idea_added", properties };
  expect(redactEvent(event)?.properties).toBe(properties);
});
