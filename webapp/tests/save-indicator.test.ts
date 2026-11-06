import { expect, test } from "bun:test";
import type { CloudStatus } from "../src/project-sync";
import { saveIndicator } from "../src/save-indicator";

const dot = (
  local: boolean,
  localStatus: "saving" | "done" | "error",
  cloud?: CloudStatus,
) => saveIndicator({ local, localStatus, cloud });
const failure = { status: "blocked", message: "Too large." } as const;

test("green means the cloud has it", () => {
  expect(dot(true, "done", { status: "saved" })).toEqual({
    tone: "cloud",
    label: "Saved to cloud",
  });
  expect(dot(false, "done", { status: "saved" })).toEqual({
    tone: "cloud",
    label: "Saved to cloud · local saving off",
  });
});

test("blue means the browser has it but the cloud does not", () => {
  expect(dot(true, "done")).toEqual({ tone: "local", label: "Saved locally" });
  expect(dot(true, "done", { status: "disabled" })).toEqual({
    tone: "local",
    label: "Saved locally · cloud saving off",
  });
  expect(dot(true, "done", { status: "offline" })).toEqual({
    tone: "local",
    label: "Offline · cloud save pending",
  });
});

test("gray means only this tab has it", () => {
  expect(dot(false, "done")).toEqual({
    tone: "memory",
    label: "In memory only",
  });
  expect(dot(false, "done", { status: "disabled" }).tone).toBe("memory");
  expect(dot(false, "done", { status: "offline" })).toEqual({
    tone: "memory",
    label: "Offline · cloud save pending",
  });
});

test("yellow means a write is running", () => {
  expect(dot(true, "saving").tone).toBe("saving");
  expect(dot(true, "saving", { status: "saved" }).tone).toBe("saving");
  expect(dot(true, "done", { status: "saving" }).tone).toBe("saving");
  expect(dot(true, "done", { status: "deleting" }).tone).toBe("saving");
});

test("red means a save failed and outranks everything else", () => {
  expect(dot(true, "error", { status: "saved" })).toEqual({
    tone: "error",
    label: "Save failed",
  });
  expect(dot(true, "saving", failure)).toEqual({
    tone: "error",
    label: "Too large.",
  });
  for (const status of ["retrying", "auth"] as const)
    expect(dot(true, "done", { status, message: "No." }).tone).toBe("error");
  expect(
    saveIndicator({
      local: true,
      localStatus: "done",
      cloud: { status: "saved" },
      recovering: true,
    }).tone,
  ).toBe("error");
});
