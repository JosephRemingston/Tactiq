import { and, eq, sql } from "drizzle-orm";
import { securityEvents } from "../models/index.js";
/** Narrow security log (PDF section 16: sessions, account changes, entitlement changes), not an enterprise audit system. */
export class SecurityEventsService {
  constructor(db) {
    this.db = db;
  }
  async record(kind, input, ex = this.db) {
    await ex
      .insert(securityEvents)
      .values({
        kind,
        userId: input.userId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        metadata: input.metadata ?? {},
      });
  }
  /** Webhook replay protection: true if a webhook with this delivery id was already processed. */
  async webhookSeen(deliveryId) {
    const rows = await this.db
      .select({ id: securityEvents.id })
      .from(securityEvents)
      .where(and(eq(securityEvents.kind, "webhook_received"), sql`${securityEvents.metadata}->>'deliveryId' = ${deliveryId}`))
      .limit(1);
    return rows.length > 0;
  }
}
