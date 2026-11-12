import { Logger } from "../utils/logger.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import ApiError from "../utils/ApiError.js";
import {
  entitlementUsage,
  entitlementUsageEvents,
  followedCompetitions,
  followedPlayers,
  followedTeams,
  ingestionJobs,
  learningProgress,
  savedInsights,
  savedMatches,
  userCollections,
  userIdentities,
  userNotes,
  users,
} from "../models/index.js";
const USER_CACHE_TTL = 300;
const PROFILE_FETCH_TIMEOUT_MS = 2000;
export class UsersService {
  constructor(db, identity, cache, entitlements, security) {
    this.db = db;
    this.identity = identity;
    this.cache = cache;
    this.entitlements = entitlements;
    this.security = security;
    this.logger = new Logger(UsersService.name);
  }
  cacheKey(clerkUserId) {
    return `user:clerk:${clerkUserId}`;
  }
  /**
   * Maps a verified Clerk session to the local user, creating the row on first sight.
   * Webhooks may arrive before or after the first API call; both paths upsert on clerk_user_id.
   */
  async resolveSession(session) {
    const cached = await this.cache.get(this.cacheKey(session.clerkUserId));
    const user = cached ?? (await this.loadOrCreate(session.clerkUserId));
    if (!cached) await this.cache.set(this.cacheKey(session.clerkUserId), user, USER_CACHE_TTL);
    if (user.status !== "active") throw ApiError.unauthorized("Account has been deleted");
    return { id: user.id, clerkUserId: user.clerkUserId, depthPreference: user.depthPreference };
  }
  async loadOrCreate(clerkUserId) {
    const [existing] = await this.db.select().from(users).where(eq(users.clerkUserId, clerkUserId));
    if (existing) return { id: existing.id, clerkUserId, depthPreference: existing.depthPreference, status: existing.status };
    const profile = await this.fetchProfileBestEffort(clerkUserId);
    const { user, created } = await this.upsert(
      profile ?? { clerkUserId, email: null, displayName: null, avatarUrl: null, identities: [] },
      "lazy",
    );
    if (created) this.logger.log(`created local user ${user.id} for ${clerkUserId}`);
    return { id: user.id, clerkUserId, depthPreference: user.depthPreference, status: user.status };
  }
  async fetchProfileBestEffort(clerkUserId) {
    try {
      return await Promise.race([
        this.identity.getProfile(clerkUserId),
        new Promise((resolve) => setTimeout(() => resolve(null), PROFILE_FETCH_TIMEOUT_MS).unref()),
      ]);
    } catch (err) {
      this.logger.warn(`profile fetch failed for ${clerkUserId}: ${err.message}`);
      return null;
    }
  }
  /** Idempotent upsert used by lazy creation and the Clerk webhook. Free entitlements are materialized once. */
  async upsert(profile, source) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({ clerkUserId: profile.clerkUserId, email: profile.email, displayName: profile.displayName, avatarUrl: profile.avatarUrl })
        .onConflictDoUpdate({
          target: users.clerkUserId,
          set: {
            email: sql`coalesce(excluded.email, ${users.email})`,
            displayName: sql`coalesce(excluded.display_name, ${users.displayName})`,
            avatarUrl: sql`coalesce(excluded.avatar_url, ${users.avatarUrl})`,
            updatedAt: new Date(),
          },
        })
        .returning({ id: users.id, depthPreference: users.depthPreference, status: users.status, created: sql`(xmax = 0)` });
      const user = row;
      for (const identity of profile.identities) {
        await tx
          .insert(userIdentities)
          .values({ userId: user.id, provider: identity.provider, providerSubject: identity.subject, email: identity.email })
          .onConflictDoUpdate({
            target: [userIdentities.provider, userIdentities.providerSubject],
            set: { email: identity.email, updatedAt: new Date() },
          });
      }
      if (user.created) {
        await this.entitlements.materializeFree(user.id, tx);
        await this.security.record("user_created", { userId: user.id, metadata: { source } }, tx);
      }
      return { user, created: user.created };
    });
  }
  async invalidate(clerkUserId) {
    await this.cache.del(this.cacheKey(clerkUserId));
  }
  async getMe(userId) {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user || user.status !== "active") throw ApiError.notFound("User");
    const [plan, following] = await Promise.all([
      this.entitlements.currentPlan(userId),
      this.db.execute(sql`
        select (select count(*)::int from ${followedTeams} where user_id = ${userId}) as teams,
               (select count(*)::int from ${followedCompetitions} where user_id = ${userId}) as competitions,
               (select count(*)::int from ${followedPlayers} where user_id = ${userId}) as players`),
    ]);
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      locale: user.locale,
      depthPreference: user.depthPreference,
      interests: user.interests ?? [],
      plan,
      followingCounts: following.rows[0],
      createdAt: user.createdAt,
    };
  }
  async updateMe(user, patch) {
    await this.db.update(users).set(patch).where(eq(users.id, user.id));
    await this.invalidate(user.clerkUserId);
    return this.getMe(user.id);
  }
  /**
   * Account deletion saga (idempotent): delete private data, scrub PII, mark the user deleted,
   * then delete the Clerk identity unless the deletion came from Clerk itself.
   * Subscription and entitlement audit rows are kept for billing auditability.
   */
  async deleteAccount(input) {
    const [user] = await this.db.select().from(users).where(eq(users.clerkUserId, input.clerkUserId));
    if (!user) return { deleted: false };
    if (user.status !== "deleted") {
      await this.db.transaction(async (tx) => {
        await this.deletePrivateData(tx, user.id);
        await tx
          .update(users)
          .set({ status: "deleted", deletedAt: new Date(), email: null, displayName: null, avatarUrl: null, interests: null })
          .where(eq(users.id, user.id));
        await this.security.record("user_deleted", { userId: user.id, ip: input.ip, metadata: { initiatedBy: input.initiatedBy } }, tx);
      });
      await this.entitlements.invalidate(user.id);
    }
    await this.invalidate(input.clerkUserId);
    if (input.initiatedBy === "user") await this.identity.deleteUser(input.clerkUserId);
    return { deleted: true };
  }
  async deletePrivateData(tx, userId) {
    await tx.delete(followedTeams).where(eq(followedTeams.userId, userId));
    await tx.delete(followedCompetitions).where(eq(followedCompetitions.userId, userId));
    await tx.delete(followedPlayers).where(eq(followedPlayers.userId, userId));
    await tx.delete(savedMatches).where(eq(savedMatches.userId, userId));
    await tx.delete(savedInsights).where(eq(savedInsights.ownerUserId, userId));
    await tx.delete(userNotes).where(eq(userNotes.ownerUserId, userId));
    await tx.delete(userCollections).where(eq(userCollections.ownerUserId, userId)); // items cascade
    await tx.delete(learningProgress).where(eq(learningProgress.ownerUserId, userId));
    await tx.delete(userIdentities).where(eq(userIdentities.userId, userId));
    await tx.delete(entitlementUsageEvents).where(eq(entitlementUsageEvents.userId, userId));
    await tx.delete(entitlementUsage).where(eq(entitlementUsage.userId, userId));
    await tx
      .update(ingestionJobs)
      .set({ requestedByUserId: null })
      .where(and(eq(ingestionJobs.requestedByUserId, userId), inArray(ingestionJobs.status, ["completed", "skipped", "dead", "failed"])));
  }
}
