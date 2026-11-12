import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { analysisRuns, matches, matchPossessions, tacticalMetrics } from "../models/index.js";
export const ANALYTICS_REPOSITORY = Symbol("ANALYTICS_REPOSITORY");
const BATCH = 500;
export class PgAnalyticsRepository {
  constructor(db) {
    this.db = db;
  }
  async createRun(matchId, analyticsVersion, coverageSnapshot) {
    const [run] = await this.db
      .insert(analysisRuns)
      .values({ matchId, analyticsVersion, status: "running", calculators: {}, coverageSnapshot })
      .returning({ id: analysisRuns.id });
    await this.db.update(matches).set({ analysisStatus: "running" }).where(eq(matches.id, matchId));
    return run.id;
  }
  async commitRun(input) {
    const { runId, matchId } = input;
    return this.db.transaction(async (tx) => {
      await tx.delete(tacticalMetrics).where(eq(tacticalMetrics.matchId, matchId));
      const rows = input.drafts.map((d) => ({
        analysisRunId: runId,
        matchId,
        teamId: d.teamId,
        playerId: d.playerId,
        metricKey: d.metricKey,
        metricVersion: d.metricVersion,
        scope: d.scope,
        value: d.value,
        valueJson: d.valueJson ?? null,
        sampleSize: d.sampleSize,
        minutes: d.minutes ?? null,
        coverageLabel: d.coverageLabel,
        evidence: d.evidence,
      }));
      for (let i = 0; i < rows.length; i += BATCH) await tx.insert(tacticalMetrics).values(rows.slice(i, i + BATCH));
      await tx.delete(matchPossessions).where(eq(matchPossessions.matchId, matchId));
      const chains = input.chains.map((c) => ({
        matchId,
        possessionId: c.possessionId,
        teamId: c.teamId,
        period: c.period,
        startEventId: c.start.id,
        endEventId: c.end.id,
        startClock: c.startClock,
        endClock: c.endClock,
        startX: c.firstLocated?.x ?? null,
        startY: c.firstLocated?.y ?? null,
        endType: c.endType,
        nEvents: c.events.length,
        nPasses: c.nPasses,
        reachedFinalThird: c.reachedFinalThird,
        reachedBox: c.reachedBox,
        xtNet: Math.round(c.xtNet * 10_000) / 10_000,
        xgTotal: Math.round(c.xgTotal * 10_000) / 10_000,
        playPattern: c.playPattern,
      }));
      for (let i = 0; i < chains.length; i += BATCH) await tx.insert(matchPossessions).values(chains.slice(i, i + BATCH));
      await tx
        .update(analysisRuns)
        .set({ status: "complete", finishedAt: new Date(), calculators: input.calculators })
        .where(eq(analysisRuns.id, runId));
      await tx
        .update(matches)
        .set({ analysisStatus: "complete", analysisRunId: runId, analyticsVersion: input.analyticsVersion, analysedAt: new Date() })
        .where(eq(matches.id, matchId));
      return rows.length;
    });
  }
  async failRun(runId, matchId, error) {
    await this.db
      .update(analysisRuns)
      .set({ status: "failed", finishedAt: new Date(), error: error.slice(0, 2000) })
      .where(eq(analysisRuns.id, runId));
    // Keep serving the previous complete run if there is one.
    await this.db
      .update(matches)
      .set({ analysisStatus: sql`case when ${matches.analysisRunId} is null then 'failed' else 'complete' end` })
      .where(eq(matches.id, matchId));
  }
  async getMatchMetrics(matchId, f = {}) {
    const conds = [eq(tacticalMetrics.matchId, matchId)];
    if (f.keys?.length) conds.push(inArray(tacticalMetrics.metricKey, f.keys));
    if (f.scope) conds.push(eq(tacticalMetrics.scope, f.scope));
    if (f.teamId) conds.push(eq(tacticalMetrics.teamId, f.teamId));
    if (f.playerId === null) conds.push(isNull(tacticalMetrics.playerId));
    else if (f.playerId) conds.push(eq(tacticalMetrics.playerId, f.playerId));
    const rows = await this.db
      .select({
        metricKey: tacticalMetrics.metricKey,
        metricVersion: tacticalMetrics.metricVersion,
        scope: tacticalMetrics.scope,
        teamId: tacticalMetrics.teamId,
        playerId: tacticalMetrics.playerId,
        value: tacticalMetrics.value,
        valueJson: tacticalMetrics.valueJson,
        sampleSize: tacticalMetrics.sampleSize,
        minutes: tacticalMetrics.minutes,
        coverageLabel: tacticalMetrics.coverageLabel,
        evidence: tacticalMetrics.evidence,
      })
      .from(tacticalMetrics)
      .where(and(...conds))
      .orderBy(asc(tacticalMetrics.metricKey), asc(tacticalMetrics.scope));
    return rows;
  }
  async getTeamMetricSeries(teamId, key, version, f) {
    return this.db
      .select({ matchId: tacticalMetrics.matchId, kickoffAt: matches.kickoffAt, value: tacticalMetrics.value })
      .from(tacticalMetrics)
      .innerJoin(matches, eq(matches.id, tacticalMetrics.matchId))
      .where(
        and(
          eq(tacticalMetrics.teamId, teamId),
          eq(tacticalMetrics.metricKey, key),
          eq(tacticalMetrics.metricVersion, version),
          eq(tacticalMetrics.scope, f.scope),
          isNull(tacticalMetrics.playerId),
          f.seasonId ? eq(matches.seasonId, f.seasonId) : undefined,
        ),
      )
      .orderBy(desc(matches.kickoffAt))
      .limit(f.limit ?? 100);
  }
  async getCompetitionValues(competitionId, seasonId, key, version, scope) {
    const rows = await this.db
      .select({ value: tacticalMetrics.value })
      .from(tacticalMetrics)
      .innerJoin(matches, eq(matches.id, tacticalMetrics.matchId))
      .where(
        and(
          eq(matches.competitionId, competitionId),
          eq(matches.seasonId, seasonId),
          eq(tacticalMetrics.metricKey, key),
          eq(tacticalMetrics.metricVersion, version),
          eq(tacticalMetrics.scope, scope),
          isNull(tacticalMetrics.playerId),
          sql`${tacticalMetrics.teamId} is not null and ${tacticalMetrics.value} is not null`,
        ),
      );
    return rows.map((r) => r.value);
  }
  async getPlayerMetricSeries(playerId, key, version, f = {}) {
    return this.db
      .select({ matchId: tacticalMetrics.matchId, kickoffAt: matches.kickoffAt, value: tacticalMetrics.value })
      .from(tacticalMetrics)
      .innerJoin(matches, eq(matches.id, tacticalMetrics.matchId))
      .where(
        and(
          eq(tacticalMetrics.playerId, playerId),
          eq(tacticalMetrics.metricKey, key),
          eq(tacticalMetrics.metricVersion, version),
          f.seasonId ? eq(matches.seasonId, f.seasonId) : undefined,
        ),
      )
      .orderBy(desc(matches.kickoffAt))
      .limit(f.limit ?? 50);
  }
}
