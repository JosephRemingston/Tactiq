/** StatsBomb event type name -> canonical type key. Versioned: changing a mapping bumps TAXONOMY_VERSION. */
export const STATSBOMB_TAXONOMY_VERSION = 1;

export const STATSBOMB_TYPE_MAP: Readonly<Record<string, string>> = {
  Pass: 'pass',
  'Ball Receipt*': 'ball_receipt',
  Carry: 'carry',
  Shot: 'shot',
  Pressure: 'pressure',
  Duel: 'duel',
  Interception: 'interception',
  'Ball Recovery': 'ball_recovery',
  Dribble: 'dribble',
  'Dribbled Past': 'dribbled_past',
  Clearance: 'clearance',
  Block: 'block',
  'Foul Committed': 'foul_committed',
  'Foul Won': 'foul_won',
  'Goal Keeper': 'goalkeeper',
  Substitution: 'substitution',
  'Starting XI': 'starting_xi',
  'Tactical Shift': 'tactical_shift',
  'Half Start': 'half_start',
  'Half End': 'half_end',
  'Own Goal For': 'own_goal_for',
  'Own Goal Against': 'own_goal_against',
  '50/50': 'fifty_fifty',
  Miscontrol: 'miscontrol',
  Dispossessed: 'dispossessed',
  Error: 'error',
  'Injury Stoppage': 'injury_stoppage',
  'Referee Ball-Drop': 'referee_ball_drop',
  'Player On': 'player_on',
  'Player Off': 'player_off',
  Shield: 'shield',
  Offside: 'offside',
  'Bad Behaviour': 'bad_behaviour',
  'Camera On': 'camera_on',
  'Camera off': 'camera_off',
};

/** 'Lost In Play' -> 'lost_in_play', 'Off T' -> 'off_t'. */
export const snake = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

const OUTCOME_ALIASES: Record<string, string> = { off_t: 'off_target', pass_offside: 'offside' };
export const normalizeOutcome = (name: string): string => OUTCOME_ALIASES[snake(name)] ?? snake(name);

/** StatsBomb position name -> broad group used to constrain role profiles. */
export function positionGroup(position: string | null | undefined): 'GK' | 'DEF' | 'MID' | 'FWD' | null {
  if (!position) return null;
  if (position === 'Goalkeeper') return 'GK';
  if (/Back|Wing Back|Center Back/.test(position)) return 'DEF';
  if (/Forward|Striker/.test(position) || /^(Left|Right) Wing$/.test(position)) return 'FWD';
  if (/Midfield/.test(position)) return 'MID';
  return null;
}

/** 433 -> '4-3-3', 4231 -> '4-2-3-1'. */
export const formatFormation = (f: number | string): string => String(f).split('').join('-');
