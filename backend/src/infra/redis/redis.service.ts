import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config/env';

/** Hosts that only accept TLS; a plain redis:// URL to them is upgraded instead of failing with ECONNRESET. */
const TLS_ONLY_HOSTS = [/\.upstash\.io$/, /\.cache\.amazonaws\.com$/, /\.redis-cloud\.com$/];

export function redisTlsOptions(url: string): Pick<RedisOptions, 'tls'> {
  const u = new URL(url);
  if (u.protocol === 'rediss:') return { tls: {} };
  if (TLS_ONLY_HOSTS.some((re) => re.test(u.hostname))) {
    new Logger(RedisService.name).warn(`REDIS_URL uses redis:// for TLS-only host ${u.hostname}; connecting with TLS (use rediss:// to silence this)`);
    return { tls: {} };
  }
  return {};
}

/** Owns every ioredis connection so they are all closed on shutdown. */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  private readonly connections: Redis[] = [];
  readonly client: Redis;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.client = this.connect('main', { maxRetriesPerRequest: 3 });
  }

  /** BullMQ workers need maxRetriesPerRequest = null (blocking commands). */
  createBullConnection(name: string): Redis {
    return this.connect(name, { maxRetriesPerRequest: null, enableReadyCheck: false });
  }

  createSubscriber(name: string): Redis {
    return this.connect(name, { maxRetriesPerRequest: null });
  }

  private connect(name: string, opts: RedisOptions): Redis {
    const conn = new Redis(this.config.REDIS_URL, { ...redisTlsOptions(this.config.REDIS_URL), connectionName: `touchline:${name}`, lazyConnect: false, ...opts });
    conn.on('error', (err: Error) => this.logger.warn(`redis(${name}) ${err.message}`));
    this.connections.push(conn);
    return conn;
  }

  async ping(): Promise<boolean> {
    return (await this.client.ping()) === 'PONG';
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.connections.map((c) => c.quit()));
  }
}
