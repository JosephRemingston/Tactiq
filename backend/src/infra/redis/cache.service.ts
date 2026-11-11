import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

/** JSON cache over Redis. Keys are versioned by analysis run where possible, so most entries never need invalidation. */
@Injectable()
export class CacheService {
  constructor(private readonly redis: RedisService) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.client.get(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.redis.client.del(...keys);
  }

  async wrap<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== null) return hit;
    const value = await load();
    if (value !== null && value !== undefined) await this.set(key, value, ttlSeconds);
    return value;
  }
}
