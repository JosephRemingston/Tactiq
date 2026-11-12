import { JOB_TYPES, QUEUES } from "../queues/constants.js";
export class GenerateInsightsHandler {
  constructor(registry, insights) {
    this.registry = registry;
    this.insights = insights;
    this.queue = QUEUES.tacticalAnalytics;
    this.jobType = JOB_TYPES.generateInsights;
  }
  onModuleInit() {
    this.registry.register(this);
  }
  async handle(env) {
    return { status: "completed", result: await this.insights.generateForRun(env.payload.matchId, env.payload.runId) };
  }
}
export class TeamSeasonStyleHandler {
  constructor(registry, insights) {
    this.registry = registry;
    this.insights = insights;
    this.queue = QUEUES.tacticalAnalytics;
    this.jobType = JOB_TYPES.teamSeasonStyle;
  }
  onModuleInit() {
    this.registry.register(this);
  }
  async handle(env) {
    const p = env.payload;
    return { status: "completed", result: await this.insights.computeTeamStyle(p.teamId, p.seasonId, p.competitionId) };
  }
}
