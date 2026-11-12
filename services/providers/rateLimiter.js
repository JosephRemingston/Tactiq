import { setTimeout as sleep } from "node:timers/promises";

/**
 * Provider request budget. Jobs run in a single worker process (one scheduled run at a time),
 * so spacing requests in-process is enough to respect the provider's rate limit.
 */
export class ProviderRateLimiter {
  constructor(config) {
    this.config = config;
    this.nextAt = new Map();
  }

  async acquire(provider) {
    const perSecond = provider === "statsbomb" ? this.config.STATSBOMB_RATE_PER_SECOND : 1;
    const interval = 1000 / Math.max(0.1, perSecond);
    const now = Date.now();
    const at = Math.max(now, this.nextAt.get(provider) ?? 0);
    this.nextAt.set(provider, at + interval);
    if (at > now) await sleep(at - now);
  }
}
