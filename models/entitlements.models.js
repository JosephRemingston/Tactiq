import { index, integer, jsonb, pgTable, primaryKey, text, unique, uuid } from "drizzle-orm/pg-core";
import { pk, timestamps, tz } from "./_common.js";
import { users } from "./users.models.js";
export const USAGE_PERIODS = ["none", "month"];
/** grace / on_hold / paused mirror Google Play states; access rules live in the billing service. */
export const SUBSCRIPTION_STATUSES = ["pending", "active", "grace", "on_hold", "paused", "cancelled", "expired", "revoked"];
export const planDefinitions = pgTable("plan_definitions", {
  planKey: text().primaryKey(),
  name: text().notNull(),
  features: jsonb().$type().notNull(),
  ...timestamps,
});
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    planKey: text()
      .notNull()
      .references(() => planDefinitions.planKey),
    status: text({ enum: SUBSCRIPTION_STATUSES }).notNull(),
    source: text({ enum: ["seed", "admin", "google_play"] }).notNull(),
    providerSubscriptionId: text(),
    startedAt: tz().notNull().defaultNow(),
    currentPeriodEnd: tz(),
    cancelledAt: tz(),
    ...timestamps,
  },
  (t) => [index("subscriptions_user_status_idx").on(t.userId, t.status)],
);
/** Append-only grants. Revocation flips status; history stays auditable (PDF §5). */
export const entitlements = pgTable(
  "entitlements",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    featureKey: text().notNull(),
    limitValue: integer(), // null = unlimited
    usagePeriod: text({ enum: USAGE_PERIODS }).notNull(),
    validFrom: tz().notNull().defaultNow(),
    validUntil: tz(),
    sourcePlan: text().notNull(),
    sourceSubscriptionId: uuid(),
    status: text({ enum: ["active", "revoked", "expired"] })
      .notNull()
      .default("active"),
    revokedAt: tz(),
    ...timestamps,
  },
  (t) => [index("entitlements_user_feature_idx").on(t.userId, t.featureKey, t.status)],
);
export const entitlementUsage = pgTable(
  "entitlement_usage",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    featureKey: text().notNull(),
    periodKey: text().notNull(),
    used: integer().notNull().default(0),
    updatedAt: tz()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.userId, t.featureKey, t.periodKey] })],
);
/** One row per (user, feature, period, subject): counting is idempotent per subject. */
export const entitlementUsageEvents = pgTable(
  "entitlement_usage_events",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    featureKey: text().notNull(),
    periodKey: text().notNull(),
    subjectType: text().notNull(),
    subjectId: text().notNull(),
    createdAt: tz().notNull().defaultNow(),
  },
  (t) => [unique("entitlement_usage_events_uq").on(t.userId, t.featureKey, t.periodKey, t.subjectType, t.subjectId)],
);
export const entitlementAudit = pgTable(
  "entitlement_audit",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    action: text({ enum: ["grant", "revoke", "expire", "plan_change", "materialize"] }).notNull(),
    featureKey: text(),
    before: jsonb(),
    after: jsonb(),
    actor: text().notNull(),
    createdAt: tz().notNull().defaultNow(),
  },
  (t) => [index("entitlement_audit_user_idx").on(t.userId, t.createdAt.desc())],
);
