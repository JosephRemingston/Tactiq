import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { Errors } from '../../common/errors';
import type { Db, Executor } from '../../db/client';
import { DATA_DIR } from '../../db/seed';
import {
  entitlementAudit,
  entitlements,
  entitlementUsage,
  entitlementUsageEvents,
  planDefinitions,
  type PlanFeature,
  subscriptions,
  type UsagePeriod,
} from '../../db/schema';
import { DB } from '../../infra/database/database.module';
import { CacheService } from '../../infra/redis/cache.service';

export interface EffectiveEntitlement {
  featureKey: string;
  limitValue: number | null; // null = unlimited
  usagePeriod: UsagePeriod;
  sourcePlan: string;
  used: number | null;
  remaining: number | null;
  periodKey: string | null;
  resetsAt: string | null;
}

export interface Subject {
  type: string;
  id: string;
}

export interface ConsumeResult {
  allowed: true;
  charged: boolean;
  entitlement: EffectiveEntitlement;
}

type FeatureMeta = Record<string, { combine?: 'min' | 'max'; kind?: 'boolean' | 'metered' }>;

export function periodKeyFor(period: UsagePeriod, now = new Date()): string {
  return period === 'month' ? now.toISOString().slice(0, 7) : 'all';
}
function resetsAtFor(period: UsagePeriod, now = new Date()): string | null {
  return period === 'month' ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString() : null;
}

/**
 * Server-side entitlement engine (PDF section 5): feature code asks for feature keys, never plan names.
 * Grants are append-only rows; usage is counted at most once per (user, feature, period, subject).
 */
@Injectable()
export class EntitlementsService {
  private readonly logger = new Logger(EntitlementsService.name);
  private plans: Map<string, Record<string, PlanFeature>> | null = null;
  private plansLoadedAt = 0;
  private readonly featureMeta: FeatureMeta;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly cache: CacheService,
  ) {
    this.featureMeta = (JSON.parse(readFileSync(join(DATA_DIR, 'plans.json'), 'utf8')) as { featureMeta: FeatureMeta }).featureMeta;
  }

  private async planFeatures(planKey: string): Promise<Record<string, PlanFeature>> {
    if (!this.plans || Date.now() - this.plansLoadedAt > 300_000) {
      const rows = await this.db.select().from(planDefinitions);
      this.plans = new Map(rows.map((r) => [r.planKey, r.features]));
      this.plansLoadedAt = Date.now();
    }
    const plan = this.plans.get(planKey);
    if (!plan) throw new Error(`plan ${planKey} is not seeded`);
    return plan;
  }

  private cacheKey(userId: string): string {
    return `ent:${userId}`;
  }

  /**
   * Active grants. Validity is evaluated with the database clock (the same clock that stamps valid_from),
   * so app/database clock skew can never make a fresh grant look "not yet valid".
   */
  private async activeRows(userId: string) {
    return this.cache.wrap(this.cacheKey(userId), 60, () =>
      this.db
        .select({
          featureKey: entitlements.featureKey,
          limitValue: entitlements.limitValue,
          usagePeriod: entitlements.usagePeriod,
          sourcePlan: entitlements.sourcePlan,
          validUntil: entitlements.validUntil,
        })
        .from(entitlements)
        .where(
          and(
            eq(entitlements.userId, userId),
            eq(entitlements.status, 'active'),
            lte(entitlements.validFrom, sql`now()`),
            or(isNull(entitlements.validUntil), gt(entitlements.validUntil, sql`now()`)),
          ),
        ),
    );
  }

  async invalidate(userId: string): Promise<void> {
    await this.cache.del(this.cacheKey(userId));
  }

  async resolve(userId: string, featureKey: string, now = new Date()): Promise<EffectiveEntitlement> {
    const rows = (await this.activeRows(userId)).filter(
      (r) => r.featureKey === featureKey && (!r.validUntil || new Date(r.validUntil) > now), // cached rows may have expired since
    );
    let chosen: { limitValue: number | null; usagePeriod: UsagePeriod; sourcePlan: string };
    if (rows.length === 0) {
      const free = (await this.planFeatures('free'))[featureKey];
      chosen = free ? { ...free, sourcePlan: 'free' } : { limitValue: 0, usagePeriod: 'none', sourcePlan: 'none' };
    } else if (this.featureMeta[featureKey]?.combine === 'min') {
      chosen = rows.reduce((a, b) => ((b.limitValue ?? Infinity) < (a.limitValue ?? Infinity) ? b : a));
    } else {
      chosen = rows.find((r) => r.limitValue === null) ?? rows.reduce((a, b) => ((b.limitValue ?? 0) > (a.limitValue ?? 0) ? b : a));
    }

    let used: number | null = null;
    const periodKey = chosen.usagePeriod === 'none' ? null : periodKeyFor(chosen.usagePeriod, now);
    if (periodKey) {
      const [u] = await this.db
        .select({ used: entitlementUsage.used })
        .from(entitlementUsage)
        .where(and(eq(entitlementUsage.userId, userId), eq(entitlementUsage.featureKey, featureKey), eq(entitlementUsage.periodKey, periodKey)));
      used = u?.used ?? 0;
    }
    return {
      featureKey,
      limitValue: chosen.limitValue,
      usagePeriod: chosen.usagePeriod,
      sourcePlan: chosen.sourcePlan,
      used,
      remaining: chosen.limitValue === null || used === null ? null : Math.max(0, chosen.limitValue - used),
      periodKey,
      resetsAt: resetsAtFor(chosen.usagePeriod, now),
    };
  }

  async resolveAll(userId: string, now = new Date()): Promise<EffectiveEntitlement[]> {
    const keys = Object.keys(await this.planFeatures('free'));
    return Promise.all(keys.map((k) => this.resolve(userId, k, now)));
  }

  /** Boolean features: limit >= 1 means enabled. */
  async isEnabled(userId: string, featureKey: string): Promise<boolean> {
    const e = await this.resolve(userId, featureKey);
    return e.limitValue === null || e.limitValue >= 1;
  }

  /**
   * Charges one unit for `subject` unless it was already charged this period.
   * The usage row is locked (FOR UPDATE) so concurrent requests serialise per user and feature.
   */
  async consume(userId: string, featureKey: string, subject: Subject, now = new Date()): Promise<ConsumeResult> {
    const eff = await this.resolve(userId, featureKey, now);
    if (eff.limitValue === null) return { allowed: true, charged: false, entitlement: eff };
    if (eff.usagePeriod === 'none') {
      if (eff.limitValue >= 1) return { allowed: true, charged: false, entitlement: eff };
      throw Errors.entitlementRequired({ featureKey, sourcePlan: eff.sourcePlan });
    }
    const periodKey = periodKeyFor(eff.usagePeriod, now);
    const limit = eff.limitValue;

    const charged = await this.db.transaction(async (tx) => {
      await tx.insert(entitlementUsage).values({ userId, featureKey, periodKey, used: 0 }).onConflictDoNothing();
      const [usage] = await tx
        .select({ used: entitlementUsage.used })
        .from(entitlementUsage)
        .where(and(eq(entitlementUsage.userId, userId), eq(entitlementUsage.featureKey, featureKey), eq(entitlementUsage.periodKey, periodKey)))
        .for('update');
      const already = await tx
        .select({ id: entitlementUsageEvents.id })
        .from(entitlementUsageEvents)
        .where(
          and(
            eq(entitlementUsageEvents.userId, userId),
            eq(entitlementUsageEvents.featureKey, featureKey),
            eq(entitlementUsageEvents.periodKey, periodKey),
            eq(entitlementUsageEvents.subjectType, subject.type),
            eq(entitlementUsageEvents.subjectId, subject.id),
          ),
        )
        .limit(1);
      if (already.length) return false;
      const used = usage?.used ?? 0;
      if (used >= limit) {
        throw Errors.entitlementExceeded({ featureKey, limit, used, periodKey, resetsAt: eff.resetsAt });
      }
      await tx.insert(entitlementUsageEvents).values({ userId, featureKey, periodKey, subjectType: subject.type, subjectId: subject.id });
      await tx
        .update(entitlementUsage)
        .set({ used: sql`${entitlementUsage.used} + 1` })
        .where(and(eq(entitlementUsage.userId, userId), eq(entitlementUsage.featureKey, featureKey), eq(entitlementUsage.periodKey, periodKey)));
      return true;
    });
    const used = (eff.used ?? 0) + (charged ? 1 : 0);
    return { allowed: true, charged, entitlement: { ...eff, used, remaining: Math.max(0, limit - used), periodKey } };
  }

  /** Compensation when the charged request failed server-side. */
  async refund(userId: string, featureKey: string, subject: Subject, periodKey: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(entitlementUsageEvents)
        .where(
          and(
            eq(entitlementUsageEvents.userId, userId),
            eq(entitlementUsageEvents.featureKey, featureKey),
            eq(entitlementUsageEvents.periodKey, periodKey),
            eq(entitlementUsageEvents.subjectType, subject.type),
            eq(entitlementUsageEvents.subjectId, subject.id),
          ),
        )
        .returning({ id: entitlementUsageEvents.id });
      if (deleted.length) {
        await tx
          .update(entitlementUsage)
          .set({ used: sql`greatest(${entitlementUsage.used} - 1, 0)` })
          .where(and(eq(entitlementUsage.userId, userId), eq(entitlementUsage.featureKey, featureKey), eq(entitlementUsage.periodKey, periodKey)));
      }
    });
  }

  /** Count-based limits without a period (e.g. saved items). */
  async assertWithinCount(userId: string, featureKey: string, currentCount: number): Promise<void> {
    const eff = await this.resolve(userId, featureKey);
    if (eff.limitValue !== null && currentCount >= eff.limitValue) {
      throw Errors.entitlementExceeded({ featureKey, limit: eff.limitValue, used: currentCount, periodKey: null, resetsAt: null });
    }
  }

  /** Free plan rows written when a user is first created; resolution also falls back to the free plan. */
  async materializeFree(userId: string, ex: Executor = this.db): Promise<void> {
    const features = await this.planFeatures('free');
    const existing = await ex.select({ id: entitlements.id }).from(entitlements).where(and(eq(entitlements.userId, userId), eq(entitlements.sourcePlan, 'free'))).limit(1);
    if (existing.length) return;
    await ex.insert(entitlements).values(
      Object.entries(features).map(([featureKey, f]) => ({ userId, featureKey, limitValue: f.limitValue, usagePeriod: f.usagePeriod, sourcePlan: 'free' })),
    );
    await ex.insert(entitlementAudit).values({ userId, action: 'materialize', after: { plan: 'free' }, actor: 'system' });
  }

  /** Grants a plan (admin CLI today, Google Play verification later) as a subscription plus entitlement rows. */
  async grantPlan(input: { userId: string; planKey: string; until?: Date | null; actor: string; source?: 'admin' | 'google_play'; providerSubscriptionId?: string }) {
    const features = await this.planFeatures(input.planKey);
    const result = await this.db.transaction(async (tx) => {
      const [sub] = await tx
        .insert(subscriptions)
        .values({
          userId: input.userId,
          planKey: input.planKey,
          status: 'active',
          source: input.source ?? 'admin',
          providerSubscriptionId: input.providerSubscriptionId,
          currentPeriodEnd: input.until ?? null,
        })
        .returning();
      await tx.insert(entitlements).values(
        Object.entries(features).map(([featureKey, f]) => ({
          userId: input.userId,
          featureKey,
          limitValue: f.limitValue,
          usagePeriod: f.usagePeriod,
          sourcePlan: input.planKey,
          sourceSubscriptionId: sub!.id,
          validUntil: input.until ?? null,
        })),
      );
      await tx.insert(entitlementAudit).values({ userId: input.userId, action: 'grant', after: { planKey: input.planKey, until: input.until, subscriptionId: sub!.id }, actor: input.actor });
      return sub!;
    });
    await this.invalidate(input.userId);
    this.logger.log(`granted ${input.planKey} to ${input.userId} by ${input.actor}`);
    return result;
  }

  async revokePlan(input: { userId: string; planKey: string; actor: string }): Promise<number> {
    const revoked = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(entitlements)
        .set({ status: 'revoked', revokedAt: new Date() })
        .where(and(eq(entitlements.userId, input.userId), eq(entitlements.sourcePlan, input.planKey), eq(entitlements.status, 'active')))
        .returning({ id: entitlements.id });
      await tx
        .update(subscriptions)
        .set({ status: 'revoked', cancelledAt: new Date() })
        .where(and(eq(subscriptions.userId, input.userId), eq(subscriptions.planKey, input.planKey), eq(subscriptions.status, 'active')));
      await tx.insert(entitlementAudit).values({ userId: input.userId, action: 'revoke', before: { planKey: input.planKey, rows: rows.length }, actor: input.actor });
      return rows.length;
    });
    await this.invalidate(input.userId);
    return revoked;
  }

  /** Daily job: mark grants past valid_until as expired (resolution already ignores them). */
  async expireDue(now = new Date()): Promise<number> {
    const rows = await this.db
      .update(entitlements)
      .set({ status: 'expired' })
      .where(and(eq(entitlements.status, 'active'), lte(entitlements.validUntil, now)))
      .returning({ userId: entitlements.userId });
    const users = [...new Set(rows.map((r) => r.userId))];
    for (const userId of users) {
      await this.db.insert(entitlementAudit).values({ userId, action: 'expire', actor: 'system' });
      await this.invalidate(userId);
    }
    return rows.length;
  }

  async currentPlan(userId: string): Promise<{ key: string; source: string; currentPeriodEnd: string | null }> {
    const [sub] = await this.db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, 'active'), or(isNull(subscriptions.currentPeriodEnd), gt(subscriptions.currentPeriodEnd, new Date()))))
      .orderBy(sql`${subscriptions.startedAt} desc`)
      .limit(1);
    return sub ? { key: sub.planKey, source: sub.source, currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null } : { key: 'free', source: 'default', currentPeriodEnd: null };
  }
}
