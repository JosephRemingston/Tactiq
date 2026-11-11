import { Inject, Injectable } from '@nestjs/common';
import { and, eq, getTableColumns, inArray, notInArray, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { Db, Executor } from '../../db/client';
import {
  competitions,
  type DataQualityReport,
  type EntityType,
  eventFreezeFrames,
  events,
  lineups,
  matchCoverage,
  matches,
  matchParticipants,
  players,
  playerTeamAssignments,
  providerEntityMaps,
  seasons,
  teams,
} from '../../db/schema';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { DB } from '../../infra/database/database.module';
import type {
  CanonicalCompetitionSeason,
  CanonicalEvent,
  CanonicalFreezeFrame,
  CanonicalLineup,
  CanonicalMatch,
  CanonicalPlayer,
  CanonicalTeam,
  ProviderKey,
} from '../../lib/providers/provider';
import { eventUuid, rewriteDetail } from '../../lib/providers/detail';

export { eventUuid } from '../../lib/providers/detail';
const EVENT_BATCH = 500;

const snakeCase = (k: string) => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

/**
 * `excluded.<col>` for every listed column: an ON CONFLICT DO UPDATE that overwrites with the incoming row.
 * The db uses `casing: 'snake_case'`, so property keys are converted the same way Drizzle converts them.
 */
function excludedSet(cols: Record<string, PgColumn>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(cols).map((k) => [k, sql.raw(`excluded."${snakeCase(k)}"`)]));
}

/** The only writer of shared football tables. Every method is idempotent. */
@Injectable()
export class CanonicalWriter {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Maps provider ids to canonical ids, creating missing entities. A per-entity-type advisory lock
   * serialises creation so concurrent workers never create duplicates.
   */
  private async ensure<T extends { id: string; name: string }>(
    tx: Executor,
    provider: ProviderKey,
    entityType: EntityType,
    items: T[],
    create: (missing: T[]) => Promise<string[]>,
  ): Promise<Map<string, string>> {
    const unique = [...new Map(items.map((i) => [i.id, i])).values()];
    if (!unique.length) return new Map();
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`entity:${provider}:${entityType}`}))`);
    const existing = await tx
      .select({ pid: providerEntityMaps.providerEntityId, cid: providerEntityMaps.canonicalId })
      .from(providerEntityMaps)
      .where(and(eq(providerEntityMaps.provider, provider), eq(providerEntityMaps.entityType, entityType), inArray(providerEntityMaps.providerEntityId, unique.map((u) => u.id))));
    const map = new Map(existing.map((r) => [r.pid, r.cid]));
    const missing = unique.filter((u) => !map.has(u.id));
    if (missing.length) {
      const ids = await create(missing);
      await tx.insert(providerEntityMaps).values(missing.map((m, i) => ({ provider, entityType, providerEntityId: m.id, canonicalId: ids[i]!, providerName: m.name })));
      missing.forEach((m, i) => map.set(m.id, ids[i]!));
    }
    if (existing.length) {
      await tx
        .update(providerEntityMaps)
        .set({ lastSeenAt: new Date() })
        .where(and(eq(providerEntityMaps.provider, provider), eq(providerEntityMaps.entityType, entityType), inArray(providerEntityMaps.providerEntityId, existing.map((e) => e.pid))));
    }
    return map;
  }

  async lookup(provider: ProviderKey, entityType: EntityType, providerId: string, ex: Executor = this.db): Promise<string | null> {
    const [row] = await ex
      .select({ cid: providerEntityMaps.canonicalId })
      .from(providerEntityMaps)
      .where(and(eq(providerEntityMaps.provider, provider), eq(providerEntityMaps.entityType, entityType), eq(providerEntityMaps.providerEntityId, providerId)));
    return row?.cid ?? null;
  }

  /** Returns a map keyed by `${providerCompetitionId}/${providerSeasonId}`. */
  async upsertCompetitionSeasons(provider: ProviderKey, items: CanonicalCompetitionSeason[]) {
    return this.db.transaction(async (tx) => {
      const compMap = await this.ensure(
        tx,
        provider,
        'competition',
        items.map((i) => i.competition),
        async (missing) =>
          (
            await tx
              .insert(competitions)
              .values(missing.map((c) => ({ name: c.name, countryName: c.countryName, gender: c.gender, isYouth: c.isYouth, isInternational: c.isInternational })))
              .returning({ id: competitions.id })
          ).map((r) => r.id),
      );
      const seasonItems = items.map((i) => ({ id: `${i.competition.id}/${i.season.id}`, name: i.season.name, competitionId: compMap.get(i.competition.id)! }));
      const seasonMap = await this.ensure(tx, provider, 'season', seasonItems, async (missing) => {
        const rows = await tx
          .insert(seasons)
          .values(missing.map((s) => ({ competitionId: s.competitionId, name: s.name })))
          .onConflictDoUpdate({ target: [seasons.competitionId, seasons.name], set: { updatedAt: new Date() } })
          .returning({ id: seasons.id });
        return rows.map((r) => r.id);
      });
      const out = new Map<string, { competitionId: string; seasonId: string }>();
      for (const s of seasonItems) out.set(s.id, { competitionId: s.competitionId, seasonId: seasonMap.get(s.id)! });
      return out;
    });
  }

  async upsertTeams(tx: Executor, provider: ProviderKey, items: CanonicalTeam[]): Promise<Map<string, string>> {
    const map = await this.ensure(tx, provider, 'team', items, async (missing) =>
      (
        await tx
          .insert(teams)
          .values(missing.map((t) => ({ name: t.name, countryName: t.countryName, gender: t.gender, isNationalTeam: t.isNationalTeam })))
          .returning({ id: teams.id })
      ).map((r) => r.id),
    );
    return map;
  }

  /** Upserts matches (plus teams, participants and an empty coverage row). Returns providerMatchId -> matchId. */
  async upsertMatches(provider: ProviderKey, items: CanonicalMatch[], ctx: { competitionId: string; seasonId: string }): Promise<Map<string, string>> {
    return this.db.transaction(async (tx) => {
      const teamMap = await this.upsertTeams(
        tx,
        provider,
        items.flatMap((m) => [m.home, m.away]),
      );
      const values = (m: CanonicalMatch) => ({
        competitionId: ctx.competitionId,
        seasonId: ctx.seasonId,
        homeTeamId: teamMap.get(m.home.id)!,
        awayTeamId: teamMap.get(m.away.id)!,
        kickoffAt: m.kickoffAt,
        matchDate: m.matchDate,
        status: m.status,
        homeScore: m.homeScore,
        awayScore: m.awayScore,
        matchWeek: m.matchWeek,
        stage: m.stage,
        stadiumName: m.stadiumName,
        refereeName: m.refereeName,
      });
      const matchMap = await this.ensure(
        tx,
        provider,
        'match',
        items.map((m) => ({ ...m, id: m.ref.id, name: m.ref.name })),
        async (missing) => {
          // A match already created from another provider is reused via the natural key.
          const rows = await tx
            .insert(matches)
            .values(missing.map(values))
            .onConflictDoUpdate({ target: [matches.competitionId, matches.seasonId, matches.homeTeamId, matches.awayTeamId, matches.matchDate], set: { updatedAt: new Date() } })
            .returning({ id: matches.id });
          return rows.map((r) => r.id);
        },
      );
      for (const m of items) {
        const matchId = matchMap.get(m.ref.id)!;
        const v = values(m);
        await tx
          .update(matches)
          .set({ kickoffAt: v.kickoffAt, status: v.status, homeScore: v.homeScore, awayScore: v.awayScore, matchWeek: v.matchWeek, stage: v.stage, stadiumName: v.stadiumName, refereeName: v.refereeName })
          .where(eq(matches.id, matchId));
        await tx
          .insert(matchParticipants)
          .values([
            { matchId, teamId: v.homeTeamId, side: 'home', managerName: m.home.managerName },
            { matchId, teamId: v.awayTeamId, side: 'away', managerName: m.away.managerName },
          ])
          .onConflictDoUpdate({ target: [matchParticipants.matchId, matchParticipants.teamId], set: { managerName: sql`excluded.manager_name`, updatedAt: new Date() } });
        await tx
          .insert(matchCoverage)
          .values({ matchId, providerLastUpdatedAt: m.providerUpdatedAt, providerLastUpdated360At: m.providerUpdated360At, provider360Status: m.freezeFrameStatus })
          .onConflictDoUpdate({
            target: matchCoverage.matchId,
            set: { providerLastUpdatedAt: m.providerUpdatedAt, providerLastUpdated360At: m.providerUpdated360At, provider360Status: m.freezeFrameStatus, updatedAt: new Date() },
          });
      }
      return matchMap;
    });
  }

  private async upsertPlayers(tx: Executor, provider: ProviderKey, items: CanonicalPlayer[]): Promise<Map<string, string>> {
    return this.ensure(tx, provider, 'player', items, async (missing) =>
      (
        await tx
          .insert(players)
          .values(missing.map((p) => ({ fullName: p.name, knownName: p.knownName, countryName: p.countryName })))
          .returning({ id: players.id })
      ).map((r) => r.id),
    );
  }

  /**
   * Replaces a match's lineups, events and freeze frames in one transaction and writes coverage flags.
   * Re-running with the same payloads yields identical rows (event ids are deterministic).
   */
  async writeMatchData(input: {
    provider: ProviderKey;
    matchId: string;
    seasonId: string;
    lineups: CanonicalLineup[];
    events: CanonicalEvent[];
    freezeFrames: CanonicalFreezeFrame[] | null;
    quality: DataQualityReport;
    taxonomyVersion: number;
    schemaVersion: string;
    licenceId: string;
    retrievedAt: Date;
    onProgress?: (pct: number) => Promise<void>;
  }): Promise<{ events: number; freezeFrames: number; lineups: number }> {
    const { provider, matchId } = input;
    return this.db.transaction(async (tx) => {
      // Players: lineups are the primary source; event references (incl. recipients and replacements) fill gaps.
      const playerRefs = new Map<string, CanonicalPlayer>();
      for (const l of input.lineups) playerRefs.set(l.player.id, l.player);
      for (const e of input.events) {
        const raw = e.raw as { player?: { id: number; name: string } };
        if (e.playerProviderId && !playerRefs.has(e.playerProviderId) && raw.player) {
          playerRefs.set(e.playerProviderId, { id: e.playerProviderId, name: raw.player.name, knownName: null, countryName: null });
        }
      }
      const playerMap = await this.upsertPlayers(tx, provider, [...playerRefs.values()]);
      const teamIds = new Set([...input.lineups.map((l) => l.team.id), ...input.events.map((e) => e.teamProviderId).filter((t): t is string => Boolean(t))]);
      const teamMap = new Map<string, string>();
      for (const t of teamIds) {
        const id = await this.lookup(provider, 'team', t, tx);
        if (id) teamMap.set(t, id);
      }

      // Lineups: replace.
      await tx.delete(lineups).where(eq(lineups.matchId, matchId));
      const lineupRows = input.lineups
        .filter((l) => teamMap.has(l.team.id))
        .map((l) => ({
          matchId,
          teamId: teamMap.get(l.team.id)!,
          playerId: playerMap.get(l.player.id)!,
          jerseyNumber: l.jerseyNumber,
          positionName: l.positionName,
          positionGroup: l.positionGroup,
          isStarter: l.isStarter,
          minuteOn: l.minuteOn,
          minuteOff: l.minuteOff,
          cards: l.cards,
        }));
      if (lineupRows.length) await tx.insert(lineups).values(lineupRows);
      if (lineupRows.length) {
        await tx
          .insert(playerTeamAssignments)
          .values(lineupRows.map((l) => ({ playerId: l.playerId, teamId: l.teamId, seasonId: input.seasonId, jerseyNumber: l.jerseyNumber, source: provider })))
          .onConflictDoUpdate({ target: [playerTeamAssignments.playerId, playerTeamAssignments.teamId, playerTeamAssignments.seasonId], set: { jerseyNumber: sql`excluded.jersey_number`, updatedAt: new Date() } });
      }

      // Events: batched upserts, then remove events the provider no longer sends (corrections).
      const rewrite = (detail: Record<string, unknown>) => rewriteDetail(detail, (pid) => playerMap.get(pid) ?? null, provider);
      const rows = input.events.map((e) => ({
        id: eventUuid(provider, e.providerEventId),
        matchId,
        provider,
        providerEventId: e.providerEventId,
        sequenceIndex: e.sequenceIndex,
        period: e.period,
        clockSeconds: e.clockSeconds,
        minute: e.minute,
        second: e.second,
        typeKey: e.typeKey,
        providerTypeName: e.providerTypeName,
        teamId: e.teamProviderId ? (teamMap.get(e.teamProviderId) ?? null) : null,
        playerId: e.playerProviderId ? (playerMap.get(e.playerProviderId) ?? null) : null,
        positionName: e.positionName,
        possessionId: e.possessionId,
        possessionTeamId: e.possessionTeamProviderId ? (teamMap.get(e.possessionTeamProviderId) ?? null) : null,
        playPattern: e.playPattern,
        x: e.x,
        y: e.y,
        endX: e.endX,
        endY: e.endY,
        rawX: e.rawX,
        rawY: e.rawY,
        rawEndX: e.rawEndX,
        rawEndY: e.rawEndY,
        outcome: e.outcome,
        underPressure: e.underPressure,
        counterpress: e.counterpress,
        duration: e.duration,
        relatedEventIds: e.relatedProviderEventIds.map((r) => eventUuid(provider, r)),
        detail: rewrite(e.detail),
        raw: this.config.EVENTS_STORE_RAW ? e.raw : null,
        taxonomyVersion: input.taxonomyVersion,
      }));
      const { id: _id, matchId: _m, provider: _p, providerEventId: _pe, createdAt: _c, ...updatable } = getTableColumns(events);
      for (let i = 0; i < rows.length; i += EVENT_BATCH) {
        await tx
          .insert(events)
          .values(rows.slice(i, i + EVENT_BATCH))
          .onConflictDoUpdate({ target: [events.provider, events.providerEventId], set: excludedSet(updatable) });
        await input.onProgress?.(Math.round(((i + EVENT_BATCH) / rows.length) * 80));
      }
      const keep = rows.map((r) => r.providerEventId);
      await tx.delete(events).where(and(eq(events.matchId, matchId), eq(events.provider, provider), keep.length ? notInArray(events.providerEventId, keep) : sql`true`));

      // Freeze frames: replace for the match.
      await tx.delete(eventFreezeFrames).where(eq(eventFreezeFrames.matchId, matchId));
      let ffCount = 0;
      if (input.freezeFrames?.length) {
        const known = new Set(rows.map((r) => r.id));
        const ff = input.freezeFrames
          .map((f) => ({ eventId: eventUuid(provider, f.providerEventId), matchId, provider, visibleArea: f.visibleArea, frame: f.frame }))
          .filter((f) => known.has(f.eventId));
        for (let i = 0; i < ff.length; i += EVENT_BATCH) await tx.insert(eventFreezeFrames).values(ff.slice(i, i + EVENT_BATCH));
        ffCount = ff.length;
      }

      // Starting formations onto participants.
      for (const e of input.events.filter((x) => x.typeKey === 'starting_xi' && x.teamProviderId)) {
        const teamId = teamMap.get(e.teamProviderId!);
        if (teamId) await tx.update(matchParticipants).set({ startingFormation: String(e.detail.formation ?? '') || null }).where(and(eq(matchParticipants.matchId, matchId), eq(matchParticipants.teamId, teamId)));
      }

      await tx
        .insert(matchCoverage)
        .values({ matchId })
        .onConflictDoNothing();
      await tx
        .update(matchCoverage)
        .set({
          hasLineups: lineupRows.length > 0,
          hasEvents: rows.length > 0,
          hasFreezeFrames: ffCount > 0,
          hasTracking: false,
          hasVideo: false,
          eventProvider: provider,
          eventSchemaVersion: input.schemaVersion,
          taxonomyVersion: input.taxonomyVersion,
          eventsCount: rows.length,
          freezeFrameCount: ffCount,
          licenceId: input.licenceId,
          retrievedAt: input.retrievedAt,
          dataQuality: input.quality,
        })
        .where(eq(matchCoverage.matchId, matchId));
      await tx.update(matches).set({ status: rows.length ? 'played' : sql`${matches.status}` }).where(eq(matches.id, matchId));
      return { events: rows.length, freezeFrames: ffCount, lineups: lineupRows.length };
    });
  }
}
