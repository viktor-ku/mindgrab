import { z } from "zod";
import { readAuthRecord, writeAuthRecord } from "./auth-record";
import { backendEndpoint } from "./backend";

const userSchema = z.object({
  id: z.number().int().positive().safe(),
  name: z.string(),
  email: z.string(),
  external_id: z.string(),
});
export type User = z.infer<typeof userSchema>;
const recordSchema = z.object({
  revision: z.string(),
  sequence: z.number().int().nonnegative().safe().optional(),
  user: userSchema.optional(),
  signedOut: z.boolean(),
  navigating: z.boolean(),
});
type SessionRecord = z.infer<typeof recordSchema>;
export interface SessionState {
  user?: User;
  status:
    | "checking"
    | "authenticated"
    | "unavailable"
    | "expired"
    | "anonymous";
  message?: string;
}

export function authStorageKey(deployment: string) {
  return `mindgrab/${encodeURIComponent(deployment)}/auth`;
}

// This is an account hint and logout tombstone, never a token or authorization.
// Only /api/getMe confirms a session. A 401 retains the cached workspace for reauth.
export class AuthSession {
  readonly key: string;
  readonly #listeners = new Set<(state: SessionState) => void>();
  #record: SessionRecord;
  #state: SessionState;
  #channel?: BroadcastChannel;
  #request?: { abort: AbortController; promise: Promise<void> };
  #epoch = 0;
  #timer?: ReturnType<typeof setInterval>;
  #started = false;
  #disposed = false;
  #hydration?: Promise<void>;

  constructor(deployment: string) {
    this.key = authStorageKey(deployment);
    this.#record = this.#read() ?? {
      revision: crypto.randomUUID(),
      signedOut: false,
      navigating: false,
    };
    this.#state = {
      user: this.#record.user,
      status: this.#record.signedOut ? "anonymous" : "checking",
    };
  }
  hydrate(): Promise<void> {
    if (this.#hydration) return this.#hydration;
    this.#hydration = (async () => {
      const stored = recordSchema.safeParse(await readAuthRecord(this.key));
      if (this.#disposed) return;
      const local = this.#read();
      // Sequence is allocated under the IDB write lock, not a wall clock.
      if (
        stored.success &&
        (!local || (stored.data.sequence ?? 0) > (local.sequence ?? 0))
      ) {
        this.#record = stored.data;
        localStorage.setItem(this.key, JSON.stringify(stored.data));
      } else if (stored.success && local?.revision === stored.data.revision) {
        this.#record = stored.data;
      } else if (local) {
        this.#record = local;
        const saved = await writeAuthRecord(
          this.key,
          local,
          () => this.#read()?.revision === local.revision,
        );
        if (
          saved &&
          !this.#disposed &&
          this.#read()?.revision === local.revision
        ) {
          this.#record = saved;
          localStorage.setItem(this.key, JSON.stringify(saved));
        }
      }
      this.#state = {
        user: this.#record.user,
        status: this.#record.signedOut ? "anonymous" : "checking",
      };
    })().catch((error) => {
      this.#hydration = undefined;
      throw error;
    });
    return this.#hydration;
  }
  get state() {
    return this.#state;
  }
  subscribe(listener: (state: SessionState) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #read() {
    try {
      const value = localStorage.getItem(this.key);
      return value ? recordSchema.parse(JSON.parse(value)) : undefined;
    } catch {
      return undefined;
    }
  }
  #emit(state: SessionState) {
    if (this.#disposed) return;
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }
  #invalidate() {
    this.#epoch++;
    this.#request?.abort.abort();
    this.#request = undefined;
  }
  async #publish(record: SessionRecord) {
    // Publish the fence immediately, but acknowledge navigation/account checking
    // only after the durable hint commits. An old writer cannot restore a hint.
    const previous = this.#record;
    localStorage.setItem(this.key, JSON.stringify(record));
    this.#record = record;
    let saved: SessionRecord | undefined;
    try {
      saved = await writeAuthRecord(
        this.key,
        record,
        () => this.#read()?.revision === record.revision,
      );
    } catch (error) {
      if (this.#read()?.revision === record.revision) {
        this.#record = previous;
        localStorage.setItem(this.key, JSON.stringify(previous));
      }
      throw error;
    }
    if (!saved || this.#disposed || this.#read()?.revision !== record.revision)
      return false;
    this.#record = saved;
    localStorage.setItem(this.key, JSON.stringify(saved));
    this.#channel?.postMessage(saved);
    return true;
  }
  #receive = (value: unknown) => {
    const parsed = recordSchema.safeParse(value);
    if (!parsed.success || parsed.data.revision === this.#record.revision)
      return;
    // A delayed channel message cannot override a newer committed transition.
    const stored = this.#read();
    if (stored && stored.revision !== parsed.data.revision) return;
    this.#invalidate();
    this.#record = parsed.data;
    this.#emit({
      user: parsed.data.user,
      status: parsed.data.signedOut ? "anonymous" : "checking",
    });
    if (!parsed.data.signedOut && !parsed.data.navigating) void this.check();
  };
  #storage = (event: StorageEvent) => {
    if (event.key !== this.key || !event.newValue) return;
    try {
      this.#receive(JSON.parse(event.newValue));
    } catch {
      // Ignore unrelated or malformed browser storage notifications.
    }
  };
  #refresh = () => {
    const stored = this.#read();
    if (stored && stored.revision !== this.#record.revision)
      this.#receive(stored);
    if (this.#request) {
      // The in-flight response may describe the cookie before this focus/online
      // event. Coalesce a fresh check after it instead of dropping the event.
      void this.#request.promise.then(() => {
        if (!this.#disposed && !this.#record.navigating) void this.check();
      });
    } else void this.check();
  };
  start() {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    if (typeof BroadcastChannel !== "undefined") {
      this.#channel = new BroadcastChannel(this.key);
      this.#channel.onmessage = ({ data }) => this.#receive(data);
    }
    window.addEventListener("storage", this.#storage);
    window.addEventListener("focus", this.#refresh);
    window.addEventListener("online", this.#refresh);
    this.#timer = setInterval(this.#refresh, 30_000);
    void this.check();
  }
  check(): Promise<void> {
    if (this.#disposed || this.#record.signedOut) return Promise.resolve();
    if (this.#request) return this.#request.promise;
    const epoch = this.#epoch;
    const revision = this.#record.revision;
    const abort = new AbortController();
    const alive = () =>
      !this.#disposed && epoch === this.#epoch && !abort.signal.aborted;
    const promise = (async () => {
      try {
        const response = await fetch(backendEndpoint("/api/getMe"), {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        });
        const current = response.ok
          ? userSchema.parse(await response.json())
          : undefined;
        if (!alive()) return;
        const stored = this.#read();
        if (stored && stored.revision !== revision) {
          this.#receive(stored);
          return;
        }
        if (response.status === 401) {
          this.expire();
          return;
        }
        if (!response.ok) throw new Error("Account check unavailable");
        if (
          this.#record.navigating ||
          JSON.stringify(current) !== JSON.stringify(this.#record.user)
        ) {
          const published = await this.#publish({
            revision: crypto.randomUUID(),
            user: current,
            signedOut: false,
            navigating: false,
          });
          if (!published || !alive()) return;
        }
        this.#emit({ user: current, status: "authenticated" });
      } catch {
        if (alive())
          this.#emit({
            user: this.#record.user,
            status:
              this.#state.status === "expired" ? "expired" : "unavailable",
            message:
              this.#state.status === "expired"
                ? "Sign in again to resume cloud saving. Your local work is retained."
                : "Account check unavailable. Your local work is still available.",
          });
      } finally {
        if (epoch === this.#epoch) this.#request = undefined;
      }
    })();
    this.#request = { abort, promise };
    return promise;
  }
  expire() {
    this.#invalidate();
    this.#emit({
      user: this.#record.user,
      status: this.#record.user ? "expired" : "anonymous",
      ...(this.#record.user && {
        message:
          "Sign in again to resume cloud saving. Your local work is retained.",
      }),
    });
  }
  // Call only after the editor has awaited local persistence.
  async prepareNavigation(action: "login" | "logout") {
    await this.hydrate();
    const published = await this.#publish({
      revision: crypto.randomUUID(),
      ...(action === "login" && { user: this.#record.user }),
      signedOut: action === "logout",
      navigating: action === "login",
    });
    if (!published) throw new Error("Account change was superseded. Retry.");
    this.#invalidate();
    this.#emit({
      user: this.#record.user,
      status: action === "logout" ? "anonymous" : "checking",
    });
  }
  destroy() {
    this.#disposed = true;
    this.#invalidate();
    clearInterval(this.#timer);
    this.#channel?.close();
    this.#listeners.clear();
    window.removeEventListener("storage", this.#storage);
    window.removeEventListener("focus", this.#refresh);
    window.removeEventListener("online", this.#refresh);
  }
}
