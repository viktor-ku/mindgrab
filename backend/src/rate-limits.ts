import { ApiError } from "./errors";

interface Quota {
  burst: number;
  periodMs: number;
}
const quotas = {
  login: { burst: 10, periodMs: 6000 },
  uploadPeers: { burst: 600, periodMs: 20 },
  uploads: { burst: 120, periodMs: 100 },
  upgradePeers: { burst: 120, periodMs: 200 },
  upgrades: { burst: 20, periodMs: 3000 },
} satisfies Record<string, Quota>;
type Scope = keyof typeof quotas;

class Limited extends ApiError {
  constructor(readonly retryAfter: number) {
    super("rate_limited");
  }
  override response() {
    const response = super.response();
    response.headers.set("Retry-After", String(this.retryAfter));
    return response;
  }
}

export class RateLimits {
  private entries = new Map<
    string,
    { availableAt: number; expiresAt: number }
  >();
  private quotas: typeof quotas;
  constructor(overrides: Partial<Record<Scope, Quota>> = {}) {
    this.quotas = { ...quotas, ...overrides };
  }

  take(scope: Scope, trustedKey?: string) {
    if (!trustedKey) throw new ApiError("unavailable");
    const quota = this.quotas[scope];
    const key = `${scope}:${trustedKey}`;
    const now = performance.now();
    const next = Math.max(now, this.entries.get(key)?.availableAt ?? now);
    const delay = next - now - (quota.burst - 1) * quota.periodMs;
    if (delay > 0) throw new Limited(Math.max(1, Math.ceil(delay / 1000)));
    this.entries.set(key, {
      availableAt: next + quota.periodMs,
      expiresAt: next + quota.periodMs,
    });
  }

  cleanup() {
    const now = performance.now();
    for (const [key, entry] of this.entries)
      if (entry.expiresAt <= now) this.entries.delete(key);
  }
}
