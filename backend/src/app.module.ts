import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { ErrorEnvelopeFilter } from './common/error.filter';
import { TouchlineThrottlerGuard } from './common/throttler.guard';
import { APP_CONFIG, type AppConfig } from './config/env';
import { ConfigModule } from './infra/config/config.module';
import { DatabaseModule } from './infra/database/database.module';
import { loggerParams } from './infra/logging';
import { QueueModule } from './infra/queue/queue.module';
import { RedisModule } from './infra/redis/redis.module';
import { RedisService } from './infra/redis/redis.service';
import { StorageModule } from './infra/storage/storage.module';
import { AuditModule } from './modules/audit/security-events.service';
import { AuthModule } from './modules/auth/auth.module';
import { ClerkAuthGuard } from './modules/auth/clerk-auth.guard';
import { IdentityModule } from './modules/auth/identity.module';
import { EntitlementsModule } from './modules/entitlements/entitlements.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { FootballModule } from './modules/football/football.module';
import { InsightsModule } from './modules/insights/insights.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { PersonalModule } from './modules/personal/personal.module';
import { HealthModule } from './modules/health/health.module';

/** Infrastructure shared by the API, worker and CLI processes. */
export function infraModules(config: AppConfig) {
  return [ConfigModule.forRoot(config), LoggerModule.forRoot(loggerParams(config)), DatabaseModule, RedisModule, StorageModule, QueueModule, AuditModule];
}

/** Domain modules shared by API and worker (services, job handlers). */
export function domainModules() {
  return [IdentityModule, EntitlementsModule];
}

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ...infraModules(config),
        ...domainModules(),
        ThrottlerModule.forRootAsync({
          inject: [APP_CONFIG, RedisService],
          useFactory: (c: AppConfig, redis: RedisService) => ({
            throttlers: [
              { name: 'ip', ttl: 60_000, limit: c.THROTTLE_IP_PER_MIN },
              { name: 'user', ttl: 60_000, limit: c.THROTTLE_USER_PER_MIN },
            ],
            storage: new ThrottlerStorageRedisService(redis.client),
          }),
        }),
        HealthModule,
        AuthModule,
        // Analytics before football so /matches/compare is not captured by /matches/:matchId.
        AnalyticsModule,
        InsightsModule,
        JobsModule,
        PersonalModule,
        FootballModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: ErrorEnvelopeFilter },
        // Order matters: authenticate first, then throttle by user or IP.
        { provide: APP_GUARD, useClass: ClerkAuthGuard },
        { provide: APP_GUARD, useClass: TouchlineThrottlerGuard },
      ],
    };
  }
}
