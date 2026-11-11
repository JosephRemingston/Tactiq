import { Global, Module } from '@nestjs/common';
import { CacheService } from './cache.service';
import { LockService } from './lock.service';
import { RedisService } from './redis.service';

@Global()
@Module({ providers: [RedisService, CacheService, LockService], exports: [RedisService, CacheService, LockService] })
export class RedisModule {}
