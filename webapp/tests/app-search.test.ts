import { expect, test } from "bun:test";
import { appSearchSchema } from "../src/app-search";

test("the editor's search opens preferences on a known tab and keeps other parameters", () => {
  expect(appSearchSchema.parse({ preferences: true, tab: "colors" })).toEqual({
    preferences: true,
    tab: "colors",
  });
  // Unknown values are dropped, not errors: an unknown tab shows saving.
  expect(
    appSearchSchema.parse({ preferences: "yes", tab: "nonsense" }),
  ).toEqual({});
  // A sign-in error and other parameters pass through.
  expect(appSearchSchema.parse({ auth_error: "unavailable" })).toEqual({
    auth_error: "unavailable",
  });
});
