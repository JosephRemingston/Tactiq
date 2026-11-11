import { Module } from '@nestjs/common';
import { AnalyseMatchHandler } from './analyse-match.handler';
import { AnalyticsController } from './analytics.controller';
import { ANALYTICS_REPOSITORY, PgAnalyticsRepository } from './analytics.repository';
import { AnalyticsService } from './analytics.service';
import { MatchContextLoader } from './match-context.loader';

const shared = [{ provide: ANALYTICS_REPOSITORY, useClass: PgAnalyticsRepository }, MatchContextLoader, AnalyticsService];

@Module({ controllers: [AnalyticsController], providers: shared, exports: shared })
export class AnalyticsModule {}

/** Worker-side registration of the analyse_match handler. */
@Module({ imports: [AnalyticsModule], providers: [AnalyseMatchHandler] })
export class AnalyticsWorkerModule {}
