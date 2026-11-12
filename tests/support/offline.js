import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eventUuid, rewriteDetail } from "../../services/providers/detail.js";
import { StatsBombNormalizer } from "../../services/providers/statsbomb/normalizer.js";
import { MatchContext } from "../../services/analytics/context.js";
/**
 * Builds a MatchContext straight from StatsBomb files (no database). Team and player ids are the provider ids.
 * Used by unit tests and by the role reference builder.
 */
export function contextFromStatsBombFiles(dir, competitionId, seasonId, matchId) {
  const n = new StatsBombNormalizer();
  const read = (p) => JSON.parse(readFileSync(join(dir, p), "utf8"));
  const match = n.normalizeMatches(read(`matches/${competitionId}/${seasonId}.json`)).find((m) => m.ref.id === matchId);
  if (!match) throw new Error(`match ${matchId} not in ${competitionId}/${seasonId}`);
  const lineups = n.normalizeLineups(read(`lineups/${matchId}.json`));
  const { events, quality } = n.normalizeEvents(read(`events/${matchId}.json`));
  const names = new Map(lineups.map((l) => [l.player.id, l.player.knownName ?? l.player.name]));
  const aEvents = events.map((e) => ({
    id: eventUuid("statsbomb", e.providerEventId),
    sequenceIndex: e.sequenceIndex,
    period: e.period,
    clockSeconds: e.clockSeconds,
    minute: e.minute,
    second: e.second,
    typeKey: e.typeKey,
    teamId: e.teamProviderId,
    playerId: e.playerProviderId,
    positionName: e.positionName,
    possessionId: e.possessionId,
    possessionTeamId: e.possessionTeamProviderId,
    playPattern: e.playPattern,
    x: e.x,
    y: e.y,
    endX: e.endX,
    endY: e.endY,
    outcome: e.outcome,
    underPressure: e.underPressure,
    counterpress: e.counterpress,
    duration: e.duration,
    detail: rewriteDetail(e.detail, (pid) => pid, "statsbomb"),
  }));
  const aLineups = lineups.map((l) => ({
    teamId: l.team.id,
    playerId: l.player.id,
    playerName: names.get(l.player.id) ?? l.player.name,
    positionName: l.positionName,
    positionGroup: l.positionGroup,
    isStarter: l.isStarter,
    minuteOn: l.minuteOn,
    minuteOff: l.minuteOff,
  }));
  return new MatchContext(
    {
      matchId,
      competitionId,
      seasonId,
      homeTeamId: match.home.id,
      awayTeamId: match.away.id,
      homeTeamName: match.home.name,
      awayTeamName: match.away.name,
      homeScore: match.homeScore,
      awayScore: match.awayScore,
    },
    aEvents,
    aLineups,
    {
      hasEvents: aEvents.length > 0,
      hasLineups: aLineups.length > 0,
      hasFreezeFrames: false,
      hasTracking: false,
      partial: quality.partial,
    },
  );
}
