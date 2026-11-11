import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { createDb, type DbHandle } from '../../db/client';

export const DB = Symbol('DB');
export const DB_HANDLE = Symbol('DB_HANDLE');

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}
  async onApplicationShutdown(): Promise<void> {
    await this.handle.pool.end();
  }
}

@Global()
@Module({
  providers: [
    { provide: DB_HANDLE, useFactory: (c: AppConfig) => createDb(c.DATABASE_URL, c.DATABASE_POOL_MAX), inject: [APP_CONFIG] },
    { provide: DB, useFactory: (h: DbHandle) => h.db, inject: [DB_HANDLE] },
    DatabaseLifecycle,
  ],
  exports: [DB, DB_HANDLE],
})
export class DatabaseModule {}
