import { type DynamicModule, Module } from '@nestjs/common';
import { domainModules, infraModules } from './app.module';
import type { AppConfig } from './config/env';
import { AnalyticsWorkerModule } from './modules/analytics/analytics.module';
import { FootballModule } from './modules/football/football.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';
import { InsightsWorkerModule } from './modules/insights/insights.module';
import { ProvidersModule } from './modules/providers/provider-registry';

/** Job handlers register themselves with the JobRegistry on module init. */
export function workerDomainModules() {
  return [ProvidersModule, IngestionModule, FootballModule, AnalyticsWorkerModule, InsightsWorkerModule];
}

@Module({})
export class WorkerModule {
  static register(config: AppConfig): DynamicModule {
    return { module: WorkerModule, imports: [...infraModules(config), ...domainModules(), ...workerDomainModules()] };
  }
}
