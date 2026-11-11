import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import type { ProviderAdapter, ProviderKey } from '../../lib/providers/provider';
import { SportmonksAdapter } from '../../lib/providers/sportmonks/adapter';
import { StatsBombOpenDataAdapter } from '../../lib/providers/statsbomb/adapter';
import { HttpTransport, LocalDirTransport } from '../../lib/providers/statsbomb/transport';
import { ProviderRateLimiter } from './provider-rate-limiter';

@Injectable()
export class ProviderRegistry {
  private readonly adapters = new Map<ProviderKey, ProviderAdapter>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly limiter: ProviderRateLimiter,
  ) {}

  get(provider: ProviderKey): ProviderAdapter {
    let adapter = this.adapters.get(provider);
    if (!adapter) {
      adapter = provider === 'statsbomb' ? this.statsBomb() : new SportmonksAdapter(this.config.SPORTMONKS_API_TOKEN);
      this.adapters.set(provider, adapter);
    }
    return adapter;
  }

  /** Overrides the StatsBomb source (e.g. the CLI's --local flag). */
  useStatsBombLocalDir(dir: string): void {
    this.adapters.set('statsbomb', new StatsBombOpenDataAdapter(new LocalDirTransport(dir)));
  }

  private statsBomb(): ProviderAdapter {
    if (this.config.STATSBOMB_SOURCE === 'local') {
      if (!this.config.STATSBOMB_OPEN_DATA_LOCAL_DIR) throw new Error('STATSBOMB_OPEN_DATA_LOCAL_DIR is required when STATSBOMB_SOURCE=local');
      return new StatsBombOpenDataAdapter(new LocalDirTransport(this.config.STATSBOMB_OPEN_DATA_LOCAL_DIR));
    }
    return new StatsBombOpenDataAdapter(
      new HttpTransport(this.config.STATSBOMB_OPEN_DATA_BASE_URL, this.config.STATSBOMB_USER_AGENT, () => this.limiter.acquire('statsbomb')),
    );
  }
}

@Global()
@Module({ providers: [ProviderRateLimiter, ProviderRegistry], exports: [ProviderRegistry, ProviderRateLimiter] })
export class ProvidersModule {}
