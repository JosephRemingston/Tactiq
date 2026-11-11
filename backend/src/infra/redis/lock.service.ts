import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** Single-instance Redis lock (SET NX PX + compare-and-delete). Good enough for coordinating scheduled syncs. */
@Injectable()
export class LockService {
  constructor(private readonly redis: RedisService) {}

  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const ok = await this.redis.client.set(`lock:${key}`, token, 'PX', ttlMs, 'NX');
    return ok === 'OK' ? token : null;
  }

  async release(key: string, token: string): Promise<boolean> {
    return (await this.redis.client.eval(RELEASE, 1, `lock:${key}`, token)) === 1;
  }

  /** Runs fn under the lock; returns null (without running) if the lock is held elsewhere. */
  async withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T | null> {
    const token = await this.acquire(key, ttlMs);
    if (!token) return null;
    try {
      return await fn();
    } finally {
      await this.release(key, token);
    }
  }
}
