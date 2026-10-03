import { parentPort } from "node:worker_threads";
import { ApiError } from "../errors";
import { reconstruct } from "./document";

parentPort?.on(
  "message",
  (input: { updates: Uint8Array[]; checkpoint: boolean }) => {
    try {
      parentPort?.postMessage({
        candidate: reconstruct(input.updates, input.checkpoint),
      });
    } catch (error) {
      parentPort?.postMessage({
        error: error instanceof ApiError ? error.code : "invalid_update",
      });
    }
  },
);
