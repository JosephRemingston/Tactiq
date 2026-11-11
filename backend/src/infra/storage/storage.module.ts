import { Global, Inject, Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { createObjectStorage, OBJECT_STORAGE, type ObjectStorage } from './object-storage';

@Injectable()
class StorageBootstrap implements OnModuleInit {
  private readonly logger = new Logger('ObjectStorage');
  constructor(@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage) {}
  async onModuleInit(): Promise<void> {
    try {
      await this.storage.ensureBucket();
    } catch (err) {
      this.logger.warn(`could not ensure bucket ${this.storage.bucket}: ${(err as Error).message}`);
    }
  }
}

@Global()
@Module({
  providers: [{ provide: OBJECT_STORAGE, useFactory: (c: AppConfig) => createObjectStorage(c), inject: [APP_CONFIG] }, StorageBootstrap],
  exports: [OBJECT_STORAGE],
})
export class StorageModule {}
