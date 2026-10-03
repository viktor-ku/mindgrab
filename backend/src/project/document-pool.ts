import { Worker } from "node:worker_threads";
import { ApiError, type ErrorCode } from "../errors";
import type { Candidate } from "./document";

interface Job {
  updates: Uint8Array[];
  checkpoint: boolean;
  resolve(candidate: Candidate): void;
  reject(error: ApiError): void;
}
interface Slot {
  worker: Worker;
  job?: Job;
  timer?: ReturnType<typeof setTimeout>;
}

export class DocumentPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private closed = false;

  run(updates: Uint8Array[], checkpoint = false): Promise<Candidate> {
    if (this.closed || this.queue.length >= 16)
      return Promise.reject(new ApiError("unavailable"));
    return new Promise((resolve, reject) => {
      this.queue.push({ updates, checkpoint, resolve, reject });
      this.dispatch();
    });
  }

  private spawn(): Slot {
    const slot: Slot = {
      worker: new Worker(new URL("./document-worker.ts", import.meta.url)),
    };
    slot.worker.unref();
    slot.worker.on(
      "message",
      (result: { candidate?: Candidate; error?: ErrorCode }) => {
        const job = slot.job;
        if (!job) return;
        clearTimeout(slot.timer);
        slot.job = undefined;
        slot.worker.unref();
        if (result.candidate) job.resolve(result.candidate);
        else job.reject(new ApiError(result.error ?? "invalid_update"));
        this.dispatch();
      },
    );
    slot.worker.on("error", () => this.failed(slot));
    slot.worker.on("exit", () => this.failed(slot));
    this.slots.push(slot);
    return slot;
  }

  private failed(slot: Slot) {
    if (!this.slots.includes(slot)) return;
    this.slots = this.slots.filter((value) => value !== slot);
    clearTimeout(slot.timer);
    slot.job?.reject(new ApiError("unavailable"));
    slot.job = undefined;
    void slot.worker.terminate();
    this.dispatch();
  }

  private dispatch() {
    if (this.closed) return;
    while (this.queue.length) {
      const slot =
        this.slots.find((value) => !value.job) ??
        (this.slots.length < 2 ? this.spawn() : undefined);
      if (!slot) return;
      slot.job = this.queue.shift();
      if (!slot.job) return;
      slot.worker.ref();
      slot.timer = setTimeout(() => this.failed(slot), 10000);
      slot.worker.postMessage({
        updates: slot.job.updates,
        checkpoint: slot.job.checkpoint,
      });
    }
  }

  async close() {
    this.closed = true;
    for (const job of this.queue.splice(0))
      job.reject(new ApiError("unavailable"));
    const slots = this.slots.splice(0);
    for (const slot of slots) {
      clearTimeout(slot.timer);
      slot.job?.reject(new ApiError("unavailable"));
    }
    await Promise.all(slots.map((slot) => slot.worker.terminate()));
  }
}
