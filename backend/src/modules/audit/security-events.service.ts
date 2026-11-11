import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { Db, Executor } from '../../db/client';
import { securityEvents } from '../../db/schema';
import { DB } from '../../infra/database/database.module';

export type SecurityEventKind =
  | 'user_created'
  | 'user_synced'
  | 'user_deleted'
  | 'account_delete_requested'
  | 'session_revoked'
  | 'entitlement_changed'
  | 'webhook_received'
  | 'webhook_rejected';

/** Narrow security log (PDF section 16: sessions, account changes, entitlement changes), not an enterprise audit system. */
@Injectable()
export class SecurityEventsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async record(kind: SecurityEventKind, input: { userId?: string | null; ip?: string | null; userAgent?: string | null; metadata?: Record<string, unknown> }, ex: Executor = this.db) {
    await ex.insert(securityEvents).values({ kind, userId: input.userId ?? null, ip: input.ip ?? null, userAgent: input.userAgent ?? null, metadata: input.metadata ?? {} });
  }

  /** Webhook replay protection: true if a webhook with this delivery id was already processed. */
  async webhookSeen(deliveryId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: securityEvents.id })
      .from(securityEvents)
      .where(and(eq(securityEvents.kind, 'webhook_received'), sql`${securityEvents.metadata}->>'deliveryId' = ${deliveryId}`))
      .limit(1);
    return rows.length > 0;
  }
}

@Global()
@Module({ providers: [SecurityEventsService], exports: [SecurityEventsService] })
export class AuditModule {}
