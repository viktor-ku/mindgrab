import { expect, test } from "bun:test";
import { isLegacyProjectKey } from "../src/legacy-reset";

test("reset allowlist covers anonymous and account snapshot keys only", () => {
  for (const key of [
    "proj/Ideas",
    "project-updated/Ideas",
    "mindgrab/latest-project",
    "mindgrab/user/12/proj/Ideas",
    "mindgrab/user/12/project-updated/Ideas",
    "mindgrab/user/12/mindgrab/latest-project",
  ])
    expect(isLegacyProjectKey(key)).toBe(true);
  for (const key of [
    "mindgrab/cached-user-id",
    "mindgrab/auth-session",
    "unrelated/proj/Ideas",
    "mindgrab/user/12/theme",
    "mindgrab/user/12/mindgrab/latest-project-extra",
    "mindgrab/user/other/proj/Ideas",
    "mindgrab/deployment/anonymous/g1/catalog",
    "mindgrab/legacy-project-reset",
  ])
    expect(isLegacyProjectKey(key)).toBe(false);
});
