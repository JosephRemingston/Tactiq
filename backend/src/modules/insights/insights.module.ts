import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { InsightsController } from './insights.controller';
import { GenerateInsightsHandler, TeamSeasonStyleHandler } from './insights.handlers';
import { InsightsService } from './insights.service';

@Module({ imports: [AnalyticsModule], controllers: [InsightsController], providers: [InsightsService], exports: [InsightsService] })
export class InsightsModule {}

/** Worker-side registration of the insight job handlers. */
@Module({ imports: [AnalyticsModule], providers: [InsightsService, GenerateInsightsHandler, TeamSeasonStyleHandler] })
export class InsightsWorkerModule {}
