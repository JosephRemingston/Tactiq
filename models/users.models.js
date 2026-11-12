import { index, integer, jsonb, pgTable, primaryKey, text, unique, uuid } from "drizzle-orm/pg-core";
import { pk, timestamps, tz } from "./_common.js";
import { competitions, matches, players, teams } from "./football.models.js";
import { insights } from "./analytics.models.js";
export const DEPTHS = ["quick", "explore", "advanced"];
export const users = pgTable(
  "users",
  {
    id: pk(),
    clerkUserId: text().notNull(),
    email: text(),
    displayName: text(),
    avatarUrl: text(),
    locale: text().notNull().default("en"),
    depthPreference: text({ enum: DEPTHS }).notNull().default("quick"),
    interests: text().array(),
    status: text({ enum: ["active", "deleted"] })
      .notNull()
      .default("active"),
    deletedAt: tz(),
    ...timestamps,
  },
  (t) => [unique("users_clerk_user_id_uq").on(t.clerkUserId)],
);
export const userIdentities = pgTable(
  "user_identities",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text().notNull(),
    providerSubject: text().notNull(),
    email: text(),
    ...timestamps,
  },
  (t) => [unique("user_identities_provider_subject_uq").on(t.provider, t.providerSubject), index("user_identities_user_idx").on(t.userId)],
);
const ownerRef = () =>
  uuid()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });
export const followedTeams = pgTable(
  "followed_teams",
  {
    userId: ownerRef(),
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    createdAt: tz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.teamId] }), index("followed_teams_team_idx").on(t.teamId)],
);
export const followedCompetitions = pgTable(
  "followed_competitions",
  {
    userId: ownerRef(),
    competitionId: uuid()
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    createdAt: tz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.competitionId] }), index("followed_competitions_comp_idx").on(t.competitionId)],
);
export const followedPlayers = pgTable(
  "followed_players",
  {
    userId: ownerRef(),
    playerId: uuid()
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    createdAt: tz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.playerId] }), index("followed_players_player_idx").on(t.playerId)],
);
export const savedMatches = pgTable(
  "saved_matches",
  {
    userId: ownerRef(),
    matchId: uuid()
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    createdAt: tz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.matchId] })],
);
export const savedInsights = pgTable(
  "saved_insights",
  {
    id: pk(),
    ownerUserId: ownerRef(),
    insightId: uuid()
      .notNull()
      .references(() => insights.id, { onDelete: "cascade" }),
    matchId: uuid()
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    createdAt: tz().notNull().defaultNow(),
  },
  (t) => [
    unique("saved_insights_owner_insight_uq").on(t.ownerUserId, t.insightId),
    index("saved_insights_owner_idx").on(t.ownerUserId, t.createdAt.desc()),
  ],
);
export const userCollections = pgTable(
  "user_collections",
  { id: pk(), ownerUserId: ownerRef(), name: text().notNull(), description: text(), ...timestamps },
  (t) => [index("user_collections_owner_idx").on(t.ownerUserId, t.createdAt.desc())],
);
export const COLLECTION_ITEM_TYPES = ["match", "insight", "player", "team", "note"];
export const userCollectionItems = pgTable(
  "user_collection_items",
  {
    collectionId: uuid()
      .notNull()
      .references(() => userCollections.id, { onDelete: "cascade" }),
    itemType: text({ enum: COLLECTION_ITEM_TYPES }).notNull(),
    itemId: uuid().notNull(),
    position: integer().notNull().default(0),
    addedAt: tz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.itemType, t.itemId] })],
);
export const NOTE_SUBJECT_TYPES = ["match", "team", "player", "insight"];
export const userNotes = pgTable(
  "user_notes",
  {
    id: pk(),
    ownerUserId: ownerRef(),
    subjectType: text({ enum: NOTE_SUBJECT_TYPES }).notNull(),
    subjectId: uuid().notNull(),
    body: text().notNull(),
    deletedAt: tz(),
    ...timestamps,
  },
  (t) => [
    index("user_notes_owner_subject_idx").on(t.ownerUserId, t.subjectType, t.subjectId),
    index("user_notes_owner_created_idx").on(t.ownerUserId, t.createdAt.desc()),
  ],
);
export const learningProgress = pgTable(
  "learning_progress",
  {
    ownerUserId: ownerRef(),
    conceptKey: text().notNull(),
    status: text({ enum: ["viewed", "saved", "completed"] }).notNull(),
    updatedAt: tz()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.ownerUserId, t.conceptKey] })],
);
export const securityEvents = pgTable(
  "security_events",
  {
    id: pk(),
    userId: uuid(),
    kind: text().notNull(),
    ip: text(),
    userAgent: text(),
    metadata: jsonb().$type().notNull().default({}),
    createdAt: tz().notNull().defaultNow(),
  },
  (t) => [
    index("security_events_user_idx").on(t.userId, t.createdAt.desc()),
    index("security_events_kind_idx").on(t.kind, t.createdAt.desc()),
  ],
);
