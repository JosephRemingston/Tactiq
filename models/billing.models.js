import { boolean, index, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { pk, timestamps, tz } from "./_common.js";
import { users } from "./users.models.js";
import { subscriptions } from "./entitlements.models.js";

export const PURCHASE_STATES = ["pending", "active", "grace", "on_hold", "paused", "cancelled", "expired", "revoked"];

/**
 * One row per store purchase token. The token is the identity of a subscription purchase:
 * a token is linked to exactly one user, and every state change re-reads the store (PDF §8).
 */
export const purchases = pgTable(
  "purchases",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    store: text({ enum: ["google_play"] }).notNull(),
    productId: text().notNull(),
    planKey: text().notNull(),
    purchaseToken: text().notNull(),
    /** Token this purchase replaced (upgrade, downgrade or resubscribe). */
    linkedPurchaseToken: text(),
    orderId: text(),
    state: text({ enum: PURCHASE_STATES }).notNull(),
    autoRenewing: boolean().notNull().default(false),
    acknowledged: boolean().notNull().default(false),
    startedAt: tz(),
    expiresAt: tz(),
    lastVerifiedAt: tz().notNull().defaultNow(),
    subscriptionId: uuid().references(() => subscriptions.id, { onDelete: "set null" }),
    /** Last store response, kept for audit and dispute handling. */
    raw: jsonb(),
    ...timestamps,
  },
  (t) => [
    unique("purchases_store_token_uq").on(t.store, t.purchaseToken),
    index("purchases_user_idx").on(t.userId, t.createdAt.desc()),
    index("purchases_state_idx").on(t.state, t.expiresAt),
  ],
);

/** Store server notifications (Google Play RTDN). The message id makes delivery idempotent. */
export const billingNotifications = pgTable(
  "billing_notifications",
  {
    id: pk(),
    store: text({ enum: ["google_play"] }).notNull(),
    messageId: text().notNull(),
    notificationType: text(),
    purchaseToken: text(),
    status: text({ enum: ["received", "processed", "ignored", "failed"] })
      .notNull()
      .default("received"),
    error: text(),
    payload: jsonb().notNull(),
    receivedAt: tz().notNull().defaultNow(),
    processedAt: tz(),
  },
  (t) => [unique("billing_notifications_message_uq").on(t.store, t.messageId), index("billing_notifications_token_idx").on(t.purchaseToken)],
);
