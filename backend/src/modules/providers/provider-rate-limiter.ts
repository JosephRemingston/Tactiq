import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable } from '@nestjs/common';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { RedisService } from '../../infra/redis/redis.service';

/**
 * Provider request budget shared by every worker process through Redis (PDF section 12:
 * "keep provider rate limits in a shared limiter, not per worker process").
 */
@Injectable()
export class ProviderRateLimiter {
  private readonly limiters = new Map<string, RateLimiterRedis>();

  constructor(
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private limiter(provider: string): RateLimiterRedis {
    let l = this.limiters.get(provider);
    if (!l) {
      const perSecond = provider === 'statsbomb' ? this.config.STATSBOMB_RATE_PER_SECOND : 1;
      l = new RateLimiterRedis({ storeClient: this.redis.client, keyPrefix: 'ratelimit:provider', points: Math.max(1, Math.round(perSecond)), duration: 1 });
      this.limiters.set(provider, l);
    }
    return l;
  }

  async acquire(provider: string, maxWaitMs = 120_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      try {
        await this.limiter(provider).consume(provider, 1);
        return;
      } catch (err) {
        if (!(err instanceof RateLimiterRes)) throw err;
        if (Date.now() + err.msBeforeNext > deadline) throw new Error(`rate limiter wait for ${provider} exceeded ${maxWaitMs}ms`);
        await sleep(err.msBeforeNext + Math.floor(Math.random() * 50));
      }
    }
  }
}
