import type { CloudStatus } from "./project-sync";

/** Where the project is kept, or what is happening to it, as one colored dot. */
export type SaveTone = "error" | "saving" | "cloud" | "local" | "memory";

export function saveIndicator(state: {
  /** The project is being written to browser storage. */
  local: boolean;
  localStatus: "saving" | "done" | "error";
  cloud?: CloudStatus;
  /** Edits from a previous account are parked in memory, not yet stored. */
  recovering?: boolean;
}): { tone: SaveTone; label: string } {
  const { local, localStatus, cloud, recovering } = state;
  if (localStatus === "error") return { tone: "error", label: "Couldn’t save" };
  if (
    cloud?.status === "retrying" ||
    cloud?.status === "auth" ||
    cloud?.status === "blocked"
  )
    return { tone: "error", label: cloud.message };
  if (recovering)
    return {
      tone: "error",
      label: "Edits from the previous account could not be saved",
    };
  if (cloud?.status === "deleting")
    return { tone: "saving", label: "Deleting cloud copy…" };
  if (cloud?.status === "saving")
    return { tone: "saving", label: "Saving to cloud…" };
  if (localStatus === "saving") return { tone: "saving", label: "Saving…" };
  if (cloud?.status === "saved")
    return {
      tone: "cloud",
      label: local ? "Saved to cloud" : "Saved to cloud · local saving off",
    };
  const tone = local ? "local" : "memory";
  if (cloud?.status === "offline")
    return { tone, label: "Offline · cloud save pending" };
  if (!local) return { tone, label: "In memory only" };
  return {
    tone,
    label:
      cloud?.status === "disabled"
        ? "Saved locally · cloud saving off"
        : "Saved locally",
  };
}
