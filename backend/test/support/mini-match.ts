import { MatchContext } from '../../src/lib/analytics/context';
import type { AEvent, ALineup } from '../../src/lib/analytics/types';

/**
 * Hand-built 17-event match with hand-computed expected values (see test/unit/analytics.spec.ts).
 * Teams H (home) and A (away); coordinates already canonical (each team attacks +x).
 */
export function miniMatch(): MatchContext {
  let seq = 0;
  const ev = (p: Partial<AEvent> & Pick<AEvent, 'typeKey' | 'teamId' | 'possessionId' | 'possessionTeamId' | 'clockSeconds'>): AEvent => ({
    id: `e${++seq}`,
    sequenceIndex: seq,
    period: 1,
    minute: Math.floor(p.clockSeconds / 60),
    second: Math.floor(p.clockSeconds % 60),
    playerId: null,
    positionName: null,
    playPattern: 'regular_play',
    x: null,
    y: null,
    endX: null,
    endY: null,
    outcome: null,
    underPressure: false,
    counterpress: false,
    duration: 0,
    detail: {},
    ...p,
  });
  const H = 'H';
  const A = 'A';
  const events: AEvent[] = [
    // Possession 1 (H): progressive pass, progressive carry, zone-14 pass, goal.
    ev({ typeKey: 'pass', teamId: H, playerId: 'h1', possessionId: 1, possessionTeamId: H, clockSeconds: 10, x: 20, y: 34, endX: 60, endY: 34, outcome: 'complete', detail: { recipientPlayerId: 'h2' } }),
    ev({ typeKey: 'carry', teamId: H, playerId: 'h2', possessionId: 1, possessionTeamId: H, clockSeconds: 12, x: 60, y: 34, endX: 75, endY: 34, outcome: 'complete' }),
    ev({ typeKey: 'pass', teamId: H, playerId: 'h2', possessionId: 1, possessionTeamId: H, clockSeconds: 14, x: 75, y: 34, endX: 80, endY: 30, outcome: 'complete', detail: { recipientPlayerId: 'h3', shotAssist: true, assistedShotEventId: 'e4' } }),
    ev({ typeKey: 'shot', teamId: H, playerId: 'h3', possessionId: 1, possessionTeamId: H, clockSeconds: 15, x: 80, y: 30, outcome: 'goal', detail: { xg: 0.1, shotType: 'open_play' } }),
    // Possession 2 (A): kick-off (set piece) then an open-play pass in A's own 60%.
    ev({ typeKey: 'pass', teamId: A, playerId: 'a1', possessionId: 2, possessionTeamId: A, clockSeconds: 60, x: 52.5, y: 34, endX: 40, endY: 20, outcome: 'complete', playPattern: 'from_kick_off', detail: { passType: 'kick_off', recipientPlayerId: 'a2' } }),
    ev({ typeKey: 'pass', teamId: A, playerId: 'a2', possessionId: 2, possessionTeamId: A, clockSeconds: 62, x: 40, y: 20, endX: 70, endY: 20, outcome: 'incomplete', playPattern: 'from_kick_off' }),
    // Possession 3 (H): high interception, pass into the box, saved shot.
    ev({ typeKey: 'interception', teamId: H, playerId: 'h1', possessionId: 3, possessionTeamId: H, clockSeconds: 64, x: 70, y: 20, outcome: 'won' }),
    ev({ typeKey: 'pass', teamId: H, playerId: 'h1', possessionId: 3, possessionTeamId: H, clockSeconds: 66, x: 70, y: 20, endX: 90, endY: 34, outcome: 'complete', detail: { recipientPlayerId: 'h3' } }),
    ev({ typeKey: 'shot', teamId: H, playerId: 'h3', possessionId: 3, possessionTeamId: H, clockSeconds: 68, x: 90, y: 34, outcome: 'saved', detail: { xg: 0.3, shotType: 'open_play' } }),
    // Possession 4 (A): open-play pass deep in A's half, H tackles high.
    ev({ typeKey: 'pass', teamId: A, playerId: 'a1', possessionId: 4, possessionTeamId: A, clockSeconds: 88, x: 10, y: 34, endX: 30, endY: 34, outcome: 'complete', detail: { recipientPlayerId: 'a2' } }),
    ev({ typeKey: 'duel', teamId: H, playerId: 'h2', possessionId: 4, possessionTeamId: A, clockSeconds: 90, x: 75, y: 34, outcome: 'won', detail: { duelType: 'tackle' } }),
    // Possession 5 (H): loses the ball; 6 (A) clears; 7 (H) wins it back 2 s later.
    ev({ typeKey: 'pass', teamId: H, playerId: 'h2', possessionId: 5, possessionTeamId: H, clockSeconds: 100, x: 75, y: 34, endX: 85, endY: 34, outcome: 'incomplete' }),
    ev({ typeKey: 'clearance', teamId: A, playerId: 'a2', possessionId: 6, possessionTeamId: A, clockSeconds: 101, x: 20, y: 34 }),
    ev({ typeKey: 'ball_recovery', teamId: H, playerId: 'h1', possessionId: 7, possessionTeamId: H, clockSeconds: 103, x: 85, y: 40, outcome: 'success' }),
    ev({ typeKey: 'half_end', teamId: H, possessionId: 7, possessionTeamId: H, clockSeconds: 2700 }),
    ev({ typeKey: 'half_end', teamId: A, possessionId: 7, possessionTeamId: H, clockSeconds: 2700 }),
  ];
  const lineup = (teamId: string, playerId: string, positionName: string, positionGroup: ALineup['positionGroup']): ALineup => ({
    teamId,
    playerId,
    playerName: playerId.toUpperCase(),
    positionName,
    positionGroup,
    isStarter: true,
    minuteOn: 0,
    minuteOff: null,
  });
  return new MatchContext(
    { matchId: 'mini', competitionId: 'c', seasonId: 's', homeTeamId: H, awayTeamId: A, homeTeamName: 'Home', awayTeamName: 'Away', homeScore: 1, awayScore: 0 },
    events,
    [lineup(H, 'h1', 'Center Back', 'DEF'), lineup(H, 'h2', 'Center Midfield', 'MID'), lineup(H, 'h3', 'Center Forward', 'FWD'), lineup(A, 'a1', 'Center Back', 'DEF'), lineup(A, 'a2', 'Center Midfield', 'MID')],
    { hasEvents: true, hasLineups: true, hasFreezeFrames: false, hasTracking: false, partial: false },
  );
}
