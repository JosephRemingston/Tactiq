import { boolean, doublePrecision, index, integer, jsonb, pgTable, smallint, text, unique, uuid } from "drizzle-orm/pg-core";
import { tz } from "./_common.js";
import { matches, PROVIDERS } from "./football.models.js";
/**
 * One row per provider event. Coordinates are canonical metres on the match pitch (default 105 x 68),
 * with the acting team attacking towards +x. Raw provider coordinates are kept alongside.
 */
export const events = pgTable(
  "events",
  {
    id: uuid().primaryKey(), // uuidv5(`${provider}:${providerEventId}`)
    matchId: uuid()
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    provider: text({ enum: PROVIDERS }).notNull(),
    providerEventId: text().notNull(),
    sequenceIndex: integer().notNull(),
    period: smallint().notNull(),
    clockSeconds: doublePrecision().notNull(),
    minute: integer().notNull(),
    second: integer().notNull(),
    typeKey: text().notNull(),
    providerTypeName: text().notNull(),
    teamId: uuid(),
    playerId: uuid(),
    positionName: text(),
    possessionId: integer().notNull(),
    possessionTeamId: uuid(),
    playPattern: text(),
    x: doublePrecision(),
    y: doublePrecision(),
    endX: doublePrecision(),
    endY: doublePrecision(),
    rawX: doublePrecision(),
    rawY: doublePrecision(),
    rawEndX: doublePrecision(),
    rawEndY: doublePrecision(),
    outcome: text(),
    underPressure: boolean().notNull().default(false),
    counterpress: boolean().notNull().default(false),
    duration: doublePrecision(),
    relatedEventIds: uuid().array(),
    detail: jsonb().$type(),
    raw: jsonb().$type(),
    taxonomyVersion: integer().notNull(),
    createdAt: tz().notNull().defaultNow(),
  },
  (t) => [
    unique("events_provider_event_uq").on(t.provider, t.providerEventId),
    index("events_match_seq_idx").on(t.matchId, t.sequenceIndex),
    index("events_match_team_type_idx").on(t.matchId, t.teamId, t.typeKey),
    index("events_match_player_idx").on(t.matchId, t.playerId),
    index("events_match_possession_idx").on(t.matchId, t.possessionId),
  ],
);
export const eventFreezeFrames = pgTable(
  "event_freeze_frames",
  {
    eventId: uuid()
      .primaryKey()
      .references(() => events.id, { onDelete: "cascade" }),
    matchId: uuid()
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    provider: text({ enum: PROVIDERS }).notNull(),
    visibleArea: jsonb().$type(),
    frame: jsonb().$type().notNull(),
  },
  (t) => [index("event_freeze_frames_match_idx").on(t.matchId)],
);
