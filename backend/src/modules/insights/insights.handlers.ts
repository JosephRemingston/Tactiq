import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { JobHandler, JobOutcome } from '../../infra/queue/job-handler';
import { JobRegistry } from '../../infra/queue/job-registry';
import { JOB_TYPES, type JobEnvelope, QUEUES } from '../../infra/queue/queue.constants';
import type { GenerateInsightsPayload, TeamSeasonStylePayload } from '../analytics/analyse-match.handler';
import { InsightsService } from './insights.service';

@Injectable()
export class GenerateInsightsHandler implements JobHandler<GenerateInsightsPayload>, OnModuleInit {
  readonly queue = QUEUES.tacticalAnalytics;
  readonly jobType = JOB_TYPES.generateInsights;
  constructor(
    private readonly registry: JobRegistry,
    private readonly insights: InsightsService,
  ) {}
  onModuleInit(): void {
    this.registry.register(this as unknown as JobHandler<never>);
  }
  async handle(env: JobEnvelope<GenerateInsightsPayload>): Promise<JobOutcome> {
    return { status: 'completed', result: await this.insights.generateForRun(env.payload.matchId, env.payload.runId) };
  }
}

@Injectable()
export class TeamSeasonStyleHandler implements JobHandler<TeamSeasonStylePayload>, OnModuleInit {
  readonly queue = QUEUES.tacticalAnalytics;
  readonly jobType = JOB_TYPES.teamSeasonStyle;
  constructor(
    private readonly registry: JobRegistry,
    private readonly insights: InsightsService,
  ) {}
  onModuleInit(): void {
    this.registry.register(this as unknown as JobHandler<never>);
  }
  async handle(env: JobEnvelope<TeamSeasonStylePayload>): Promise<JobOutcome> {
    const p = env.payload;
    return { status: 'completed', result: await this.insights.computeTeamStyle(p.teamId, p.seasonId, p.competitionId) };
  }
}
