import { and, asc, eq, inArray, sql } from "drizzle-orm";
import ApiError, { assertFound } from "../utils/ApiError.js";
import { insights, matchCoverage, matches, matchStories, metricDefinitions, players, teams, teamSeasonStyles } from "../models/index.js";
import { generateInsights } from "./insights/engine.js";
import { seriesStats, STYLE_METRICS, styleLabels } from "./analytics/style.js";
import { ANALYTICS_VERSION, INSIGHTS_VERSION } from "./analytics/version.js";
import { matchCacheKeys } from "../workers/analytics.workers.js";
export class InsightsService {
  constructor(db, repo, loader, cache) {
    this.db = db;
    this.repo = repo;
    this.loader = loader;
    this.cache = cache;
  }
  async meta(matchId) {
    const { ctx, coverage } = await this.loader.load(matchId);
    const defs = await this.db
      .select({
        key: metricDefinitions.key,
        name: metricDefinitions.name,
        formula: metricDefinitions.descriptionAdvanced,
        caveats: metricDefinitions.providerCaveats,
      })
      .from(metricDefinitions);
    const provider = coverage?.eventProvider ?? null;
    return {
      matchId,
      homeTeamId: ctx.meta.homeTeamId,
      awayTeamId: ctx.meta.awayTeamId,
      teamNames: { [ctx.meta.homeTeamId]: ctx.meta.homeTeamName, [ctx.meta.awayTeamId]: ctx.meta.awayTeamName },
      playerNames: Object.fromEntries(ctx.lineups.map((l) => [l.playerId, l.playerName])),
      homeScore: ctx.meta.homeScore,
      awayScore: ctx.meta.awayScore,
      coverage: { ...ctx.coverage, eventsCount: coverage?.eventsCount ?? 0, provider },
      definitions: Object.fromEntries(
        defs.map((d) => [d.key, { name: d.name, formula: d.formula, caveat: (provider && d.caveats[provider]) || null }]),
      ),
      goals: ctx.goals.map((g) => {
        const ev = ctx.events.find((e) => e.sequenceIndex === g.sequenceIndex && e.period === g.period);
        return {
          teamId: g.teamId,
          minute: ev?.minute ?? 0,
          playerName: ev?.playerId && ev.typeKey === "shot" ? ctx.playerName(ev.playerId) : null,
          ownGoal: ev?.typeKey === "own_goal_for",
        };
      }),
    };
  }
  /** generate_insights: deterministic insight cards + match story for a completed analysis run. */
  async generateForRun(matchId, runId) {
    const metrics = await this.repo.getMatchMetrics(matchId);
    const meta = await this.meta(matchId);
    const out = generateInsights(metrics, meta);
    await this.db.transaction(async (tx) => {
      await tx.delete(insights).where(eq(insights.matchId, matchId));
      const inserted = out.insights.length
        ? await tx
            .insert(insights)
            .values(
              out.insights.map((i) => ({
                matchId,
                analysisRunId: runId,
                teamId: i.teamId,
                playerId: i.playerId,
                kind: i.kind,
                family: i.family,
                rank: i.rank,
                score: i.score,
                headline: i.headline,
                whatHappened: i.whatHappened,
                whyItMatters: i.whyItMatters,
                evidence: i.evidence,
                confidence: i.confidence,
                coverageLabel: i.coverageLabel,
                completeness: i.completeness,
                exploreLink: i.exploreLink,
                depth: i.depth,
                templateKey: i.templateKey,
                templateVersion: 1,
                generatorVersion: INSIGHTS_VERSION,
              })),
            )
            .returning({ id: insights.id, kind: insights.kind, teamId: insights.teamId, playerId: insights.playerId })
        : [];
      const idOf = (k) =>
        inserted.find(
          (r) => r.kind === k.kind && r.teamId === (k.teamId ?? null) && (k.playerId === undefined || r.playerId === k.playerId),
        )?.id;
      const story = {
        matchId,
        analysisRunId: runId,
        kind: out.story.kind,
        shortVersion: out.story.shortVersion,
        teamApproaches: out.story.teamApproaches,
        keyPatternInsightIds: out.story.keyPatternKinds.map(idOf).filter((x) => Boolean(x)),
        whatChanged: out.story.whatChanged.map((w) => ({
          kind: w.kind,
          minute: w.minute,
          text: w.text,
          ...(w.insightKind ? { insightId: idOf({ kind: w.insightKind, teamId: w.teamId }) } : {}),
        })),
        keyPlayers: out.story.keyPlayers,
        evidenceLinks: out.story.evidenceLinks,
        coverageStatement: out.story.coverageStatement,
        generatorVersion: out.story.generatorVersion,
      };
      await tx
        .insert(matchStories)
        .values(story)
        .onConflictDoUpdate({ target: matchStories.matchId, set: { ...story, updatedAt: new Date() } });
    });
    await this.cache.del(...matchCacheKeys(matchId));
    return { insights: out.insights.length, keyPatterns: out.story.keyPatternKinds.length, storyKind: out.story.kind };
  }
  async listInsights(matchId, depth) {
    await this.matchExists(matchId);
    const rows = await this.db
      .select({
        id: insights.id,
        kind: insights.kind,
        family: insights.family,
        rank: insights.rank,
        teamId: insights.teamId,
        teamName: teams.name,
        playerId: insights.playerId,
        playerName: sql`coalesce(${players.knownName}, ${players.fullName})`,
        headline: insights.headline,
        whatHappened: insights.whatHappened,
        whyItMatters: insights.whyItMatters,
        evidence: insights.evidence,
        confidence: insights.confidence,
        coverageLabel: insights.coverageLabel,
        completeness: insights.completeness,
        exploreLink: insights.exploreLink,
        depth: insights.depth,
      })
      .from(insights)
      .leftJoin(teams, eq(teams.id, insights.teamId))
      .leftJoin(players, eq(players.id, insights.playerId))
      .where(eq(insights.matchId, matchId))
      .orderBy(asc(insights.rank));
    return { depth, data: rows.map((r) => ({ ...r, explanation: r.depth[depth] })) };
  }
  /** The match story. Low-coverage matches get a recap and say what cannot be assessed. */
  async getStory(matchId, depth) {
    await this.matchExists(matchId);
    const [story] = await this.db.select().from(matchStories).where(eq(matchStories.matchId, matchId));
    if (!story) {
      const [cov] = await this.db
        .select({ hasEvents: matchCoverage.hasEvents })
        .from(matchCoverage)
        .where(eq(matchCoverage.matchId, matchId));
      return {
        matchId,
        status: cov?.hasEvents ? "pending_analysis" : "unavailable",
        coverageStatement: cov?.hasEvents
          ? "Analysis for this match has not finished yet."
          : "Only the fixture and result are available for this match, so no tactical analysis is possible.",
      };
    }
    const keyInsights = story.keyPatternInsightIds.length
      ? await this.db.select().from(insights).where(inArray(insights.id, story.keyPatternInsightIds))
      : [];
    const byId = new Map(keyInsights.map((i) => [i.id, i]));
    return {
      matchId,
      status: story.kind,
      depth,
      shortVersion: story.shortVersion,
      teamApproaches: story.teamApproaches,
      keyPatterns: story.keyPatternInsightIds
        .map((id) => byId.get(id))
        .filter((i) => Boolean(i))
        .map((i) => ({
          id: i.id,
          kind: i.kind,
          teamId: i.teamId,
          playerId: i.playerId,
          headline: i.headline,
          explanation: i.depth[depth],
          confidence: i.confidence,
          coverageLabel: i.coverageLabel,
          evidence: depth === "quick" ? undefined : i.evidence,
          exploreLink: i.exploreLink,
        })),
      whatChanged: story.whatChanged,
      keyPlayers: story.keyPlayers,
      evidenceLinks: story.evidenceLinks,
      coverageStatement: story.coverageStatement,
      generatorVersion: story.generatorVersion,
      generatedAt: story.updatedAt,
    };
  }
  async matchExists(matchId) {
    const [m] = await this.db.select({ id: matches.id }).from(matches).where(eq(matches.id, matchId));
    assertFound(m, "Match");
  }
  /** team_season_style: medians, spread and competition percentiles over analysed matches. */
  async computeTeamStyle(teamId, seasonId, competitionId) {
    const stats = {};
    let matchesAnalysed = 0;
    for (const key of STYLE_METRICS) {
      const series = await this.repo.getTeamMetricSeries(teamId, key, 1, { seasonId, scope: "full", limit: 100 });
      matchesAnalysed = Math.max(matchesAnalysed, series.length);
      const comp = await this.repo.getCompetitionValues(competitionId, seasonId, key, 1, "full");
      const s = seriesStats(
        series.map((p) => p.value).filter((v) => v !== null),
        comp,
      );
      if (s) stats[key] = s;
    }
    const labels = styleLabels(stats, matchesAnalysed);
    await this.db
      .insert(teamSeasonStyles)
      .values({ teamId, seasonId, competitionId, matchesAnalysed, metrics: stats, labels, analyticsVersion: ANALYTICS_VERSION })
      .onConflictDoUpdate({
        target: [teamSeasonStyles.teamId, teamSeasonStyles.seasonId],
        set: { matchesAnalysed, metrics: stats, labels, analyticsVersion: ANALYTICS_VERSION, computedAt: new Date() },
      });
    return { matchesAnalysed, labels: labels.length };
  }
  async getTeamStyle(teamId, seasonId) {
    const [t] = await this.db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.id, teamId));
    assertFound(t, "Team");
    const rows = await this.db
      .select()
      .from(teamSeasonStyles)
      .where(and(eq(teamSeasonStyles.teamId, teamId), seasonId ? eq(teamSeasonStyles.seasonId, seasonId) : undefined))
      .orderBy(sql`${teamSeasonStyles.computedAt} desc`);
    return {
      teamId,
      teamName: t.name,
      data: rows.map((r) => ({
        seasonId: r.seasonId,
        competitionId: r.competitionId,
        matchesAnalysed: r.matchesAnalysed,
        labels: r.labels,
        metrics: r.metrics,
        note: r.matchesAnalysed < 5 ? `Style labels need at least 5 analysed matches; ${r.matchesAnalysed} so far.` : null,
        computedAt: r.computedAt,
      })),
    };
  }
}
