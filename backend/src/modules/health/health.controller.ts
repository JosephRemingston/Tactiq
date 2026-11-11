import { Controller, Get, HttpCode, Inject, ServiceUnavailableException, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { sql } from 'drizzle-orm';
import { Public } from '../../common/auth.decorators';
import type { Db } from '../../db/client';
import { DB } from '../../infra/database/database.module';
import { RedisService } from '../../infra/redis/redis.service';
import { OBJECT_STORAGE, type ObjectStorage } from '../../infra/storage/object-storage';

@ApiTags('health')
@Public()
@SkipThrottle()
@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly redis: RedisService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /** Liveness: the process is up. */
  @Get('healthz')
  health() {
    return { status: 'ok' };
  }

  /** Readiness: every dependency the API needs answers. */
  @Get('readyz')
  @HttpCode(200)
  async ready() {
    const check = async (fn: () => Promise<unknown>) => {
      try {
        return (await fn()) !== false ? 'ok' : 'down';
      } catch {
        return 'down';
      }
    };
    const checks = {
      database: await check(() => this.db.execute(sql`select 1`)),
      redis: await check(() => this.redis.ping()),
      storage: await check(() => this.storage.ping()),
    };
    const ok = Object.values(checks).every((v) => v === 'ok');
    if (!ok) throw new ServiceUnavailableException({ status: 'degraded', checks });
    return { status: 'ok', checks };
  }
}
