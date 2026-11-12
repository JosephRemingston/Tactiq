import { z } from "zod";
/**
 * Validation of StatsBomb Open Data payloads before normalization (catches upstream schema drift).
 * Objects are loose: unknown extra keys are kept in the raw payload rather than rejected.
 */
const named = z.looseObject({ id: z.number().int(), name: z.string() });
const loc = z.array(z.number()).min(2);
export const sbCompetitionSchema = z.looseObject({
  competition_id: z.number().int(),
  season_id: z.number().int(),
  country_name: z.string().nullable().optional(),
  competition_name: z.string(),
  competition_gender: z.string().nullable().optional(),
  competition_youth: z.boolean().nullable().optional(),
  competition_international: z.boolean().nullable().optional(),
  season_name: z.string(),
  match_updated: z.string().nullable().optional(),
});
export const sbCompetitionsSchema = z.array(sbCompetitionSchema);
const sbTeam = (side) =>
  z.looseObject({
    [`${side}_team_id`]: z.number().int(),
    [`${side}_team_name`]: z.string(),
    [`${side}_team_gender`]: z.string().nullable().optional(),
    country: z.looseObject({ name: z.string() }).nullable().optional(),
    managers: z
      .array(z.looseObject({ name: z.string(), nickname: z.string().nullable().optional() }))
      .nullable()
      .optional(),
  });
export const sbMatchSchema = z.looseObject({
  match_id: z.number().int(),
  match_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kick_off: z.string().nullable().optional(),
  competition: z.looseObject({ competition_id: z.number().int(), competition_name: z.string() }),
  season: z.looseObject({ season_id: z.number().int(), season_name: z.string() }),
  home_team: sbTeam("home"),
  away_team: sbTeam("away"),
  home_score: z.number().int().nullable().optional(),
  away_score: z.number().int().nullable().optional(),
  match_status: z.string().nullable().optional(),
  match_status_360: z.string().nullable().optional(),
  last_updated: z.string().nullable().optional(),
  last_updated_360: z.string().nullable().optional(),
  match_week: z.number().int().nullable().optional(),
  competition_stage: z.looseObject({ name: z.string() }).nullable().optional(),
  stadium: z.looseObject({ name: z.string() }).nullable().optional(),
  referee: z.looseObject({ name: z.string() }).nullable().optional(),
});
export const sbMatchesSchema = z.array(sbMatchSchema);
export const sbLineupSchema = z.array(
  z.looseObject({
    team_id: z.number().int(),
    team_name: z.string(),
    lineup: z.array(
      z.looseObject({
        player_id: z.number().int(),
        player_name: z.string(),
        player_nickname: z.string().nullable().optional(),
        jersey_number: z.number().int().nullable().optional(),
        country: z.looseObject({ name: z.string() }).nullable().optional(),
        cards: z
          .array(z.looseObject({ time: z.string(), card_type: z.string(), reason: z.string().optional(), period: z.number().optional() }))
          .optional(),
        positions: z.array(
          z.looseObject({
            position: z.string(),
            from: z.string().nullable().optional(),
            to: z.string().nullable().optional(),
            from_period: z.number().nullable().optional(),
            to_period: z.number().nullable().optional(),
            start_reason: z.string().nullable().optional(),
            end_reason: z.string().nullable().optional(),
          }),
        ),
      }),
    ),
  }),
);
export const sbEventSchema = z.looseObject({
  id: z.string().uuid(),
  index: z.number().int(),
  period: z.number().int().min(1).max(5),
  timestamp: z.string().regex(/^\d{2}:\d{2}:\d{2}(\.\d+)?$/),
  minute: z.number().int(),
  second: z.number().int(),
  type: named,
  possession: z.number().int(),
  possession_team: named,
  play_pattern: named,
  team: named,
  player: named.optional(),
  position: named.optional(),
  location: loc.optional(),
  duration: z.number().nullable().optional(),
  under_pressure: z.boolean().optional(),
  counterpress: z.boolean().optional(),
  off_camera: z.boolean().optional(),
  out: z.boolean().optional(),
  related_events: z.array(z.string()).optional(),
  pass: z
    .looseObject({
      end_location: loc,
      recipient: named.optional(),
      outcome: named.optional(),
      type: named.optional(),
      height: named.optional(),
    })
    .optional(),
  carry: z.looseObject({ end_location: loc }).optional(),
  shot: z.looseObject({ statsbomb_xg: z.number().optional(), end_location: loc, outcome: named, type: named }).optional(),
  tactics: z
    .looseObject({
      formation: z.number().int(),
      lineup: z.array(z.looseObject({ player: named, position: named, jersey_number: z.number().int() })),
    })
    .optional(),
  substitution: z.looseObject({ replacement: named, outcome: named.optional() }).optional(),
});
export const sbEventsSchema = z.array(sbEventSchema);
export const sbThreeSixtySchema = z.array(
  z.looseObject({
    event_uuid: z.string(),
    visible_area: z.array(z.number()).optional(),
    freeze_frame: z.array(z.looseObject({ teammate: z.boolean(), actor: z.boolean(), keeper: z.boolean(), location: loc })),
  }),
);
