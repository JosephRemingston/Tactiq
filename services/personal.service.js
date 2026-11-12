import { and, asc, count, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import ApiError, { assertFound, assertOwned } from "../utils/ApiError.js";
import { decodeCursor, toPage } from "../utils/pagination.js";
import {
  competitions,
  followedCompetitions,
  followedPlayers,
  followedTeams,
  insights,
  learningProgress,
  matches,
  players,
  savedInsights,
  savedMatches,
  tacticalConcepts,
  teams,
  userCollectionItems,
  userCollections,
  userNotes,
} from "../models/index.js";
/**
 * Everything here is private to one user. Every query filters by the authenticated user id, so another
 * user's resource is indistinguishable from a missing one (404), as PDF section 7 requires.
 */
export class PersonalService {
  constructor(db, entitlements, football) {
    this.db = db;
    this.entitlements = entitlements;
    this.football = football;
  }
  // ---- shared football entities (existence checks) ----
  async assertEntity(kind, id) {
    const table = { match: matches, team: teams, player: players, insight: insights, competition: competitions }[kind];
    const [row] = await this.db.select({ id: table.id }).from(table).where(eq(table.id, id));
    assertFound(row, kind[0].toUpperCase() + kind.slice(1));
  }
  // ---- following ----
  async following(userId) {
    const [t, c, p] = await Promise.all([
      this.db
        .select({ id: teams.id, name: teams.name, countryName: teams.countryName, followedAt: followedTeams.createdAt })
        .from(followedTeams)
        .innerJoin(teams, eq(teams.id, followedTeams.teamId))
        .where(eq(followedTeams.userId, userId))
        .orderBy(asc(teams.name)),
      this.db
        .select({
          id: competitions.id,
          name: competitions.name,
          countryName: competitions.countryName,
          followedAt: followedCompetitions.createdAt,
        })
        .from(followedCompetitions)
        .innerJoin(competitions, eq(competitions.id, followedCompetitions.competitionId))
        .where(eq(followedCompetitions.userId, userId))
        .orderBy(asc(competitions.name)),
      this.db
        .select({
          id: players.id,
          name: sql`coalesce(${players.knownName}, ${players.fullName})`,
          countryName: players.countryName,
          followedAt: followedPlayers.createdAt,
        })
        .from(followedPlayers)
        .innerJoin(players, eq(players.id, followedPlayers.playerId))
        .where(eq(followedPlayers.userId, userId))
        .orderBy(asc(players.fullName)),
    ]);
    return { teams: t, competitions: c, players: p };
  }
  async follow(userId, kind, id, on) {
    const entity = kind === "teams" ? "team" : kind === "competitions" ? "competition" : "player";
    if (on) await this.assertEntity(entity, id);
    if (kind === "teams") {
      if (on) await this.db.insert(followedTeams).values({ userId, teamId: id }).onConflictDoNothing();
      else await this.db.delete(followedTeams).where(and(eq(followedTeams.userId, userId), eq(followedTeams.teamId, id)));
    } else if (kind === "competitions") {
      if (on) await this.db.insert(followedCompetitions).values({ userId, competitionId: id }).onConflictDoNothing();
      else
        await this.db
          .delete(followedCompetitions)
          .where(and(eq(followedCompetitions.userId, userId), eq(followedCompetitions.competitionId, id)));
    } else {
      if (on) await this.db.insert(followedPlayers).values({ userId, playerId: id }).onConflictDoNothing();
      else await this.db.delete(followedPlayers).where(and(eq(followedPlayers.userId, userId), eq(followedPlayers.playerId, id)));
    }
    return { [entity + "Id"]: id, following: on };
  }
  // ---- saved items (limit: following.max_saved_items across matches + insights) ----
  /**
   * Runs `fn` in a transaction holding a per-user advisory lock, so "count, check limit, insert" cannot be
   * interleaved by parallel requests from the same user (which would let them save past their limit).
   */
  withSavedItemsLock(userId, fn) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"saved-items:" + userId}, 0))`);
      return fn(tx);
    });
  }
  async savedCount(userId, ex = this.db) {
    const [[m], [i]] = await Promise.all([
      ex.select({ n: count() }).from(savedMatches).where(eq(savedMatches.userId, userId)),
      ex.select({ n: count() }).from(savedInsights).where(eq(savedInsights.ownerUserId, userId)),
    ]);
    return (m?.n ?? 0) + (i?.n ?? 0);
  }
  async saveMatch(userId, matchId) {
    await this.assertEntity("match", matchId);
    await this.withSavedItemsLock(userId, async (tx) => {
      const [exists] = await tx
        .select({ m: savedMatches.matchId })
        .from(savedMatches)
        .where(and(eq(savedMatches.userId, userId), eq(savedMatches.matchId, matchId)));
      if (exists) return;
      await this.entitlements.assertWithinCount(userId, "following.max_saved_items", await this.savedCount(userId, tx));
      await tx.insert(savedMatches).values({ userId, matchId }).onConflictDoNothing();
    });
    return { matchId, saved: true };
  }
  async unsaveMatch(userId, matchId) {
    await this.db.delete(savedMatches).where(and(eq(savedMatches.userId, userId), eq(savedMatches.matchId, matchId)));
    return { matchId, saved: false };
  }
  async savedMatches(userId, limit, cursor) {
    const c = decodeCursor(cursor, ["date", "uuid"]);
    const ids = await this.db
      .select({ matchId: savedMatches.matchId, savedAt: savedMatches.createdAt })
      .from(savedMatches)
      .where(
        and(
          eq(savedMatches.userId, userId),
          c ? sql`(${savedMatches.createdAt}, ${savedMatches.matchId}) < (${new Date(String(c[0]))}, ${c[1]})` : undefined,
        ),
      )
      .orderBy(desc(savedMatches.createdAt), desc(savedMatches.matchId))
      .limit(limit + 1);
    const page = toPage(ids, limit, (r) => [r.savedAt.toISOString(), r.matchId]);
    const details = page.data.length
      ? (
          await this.football.listMatches(
            { limit: page.data.length },
            inArray(
              matches.id,
              page.data.map((d) => d.matchId),
            ),
          )
        ).data
      : [];
    const byId = new Map(details.map((d) => [d.id, d]));
    return { data: page.data.map((d) => ({ savedAt: d.savedAt, match: byId.get(d.matchId) ?? null })), page: page.page };
  }
  async saveInsight(userId, insightId) {
    const [ins] = await this.db.select({ id: insights.id, matchId: insights.matchId }).from(insights).where(eq(insights.id, insightId));
    assertFound(ins, "Insight");
    await this.withSavedItemsLock(userId, async (tx) => {
      const [exists] = await tx
        .select({ id: savedInsights.id })
        .from(savedInsights)
        .where(and(eq(savedInsights.ownerUserId, userId), eq(savedInsights.insightId, insightId)));
      if (exists) return;
      await this.entitlements.assertWithinCount(userId, "following.max_saved_items", await this.savedCount(userId, tx));
      await tx.insert(savedInsights).values({ ownerUserId: userId, insightId, matchId: ins.matchId }).onConflictDoNothing();
    });
    return { insightId, saved: true };
  }
  async unsaveInsight(userId, insightId) {
    await this.db.delete(savedInsights).where(and(eq(savedInsights.ownerUserId, userId), eq(savedInsights.insightId, insightId)));
    return { insightId, saved: false };
  }
  async savedInsights(userId, limit, cursor) {
    const c = decodeCursor(cursor, ["date", "uuid"]);
    const rows = await this.db
      .select({
        id: savedInsights.id,
        savedAt: savedInsights.createdAt,
        insightId: insights.id,
        matchId: insights.matchId,
        headline: insights.headline,
        whatHappened: insights.whatHappened,
        kind: insights.kind,
        teamId: insights.teamId,
        exploreLink: insights.exploreLink,
      })
      .from(savedInsights)
      .innerJoin(insights, eq(insights.id, savedInsights.insightId))
      .where(
        and(
          eq(savedInsights.ownerUserId, userId),
          c ? sql`(${savedInsights.createdAt}, ${savedInsights.id}) < (${new Date(String(c[0]))}, ${c[1]})` : undefined,
        ),
      )
      .orderBy(desc(savedInsights.createdAt), desc(savedInsights.id))
      .limit(limit + 1);
    return toPage(rows, limit, (r) => [r.savedAt.toISOString(), r.id]);
  }
  // ---- notes ----
  async createNote(userId, input) {
    await this.assertEntity(input.subjectType, input.subjectId);
    const [note] = await this.db
      .insert(userNotes)
      .values({ ownerUserId: userId, ...input })
      .returning();
    return this.noteView(note);
  }
  async listNotes(userId, q) {
    const conds = [eq(userNotes.ownerUserId, userId), isNull(userNotes.deletedAt)];
    if (q.subjectType) conds.push(eq(userNotes.subjectType, q.subjectType));
    if (q.subjectId) conds.push(eq(userNotes.subjectId, q.subjectId));
    const c = decodeCursor(q.cursor, ["date", "uuid"]);
    if (c) conds.push(sql`(${userNotes.createdAt}, ${userNotes.id}) < (${new Date(String(c[0]))}, ${c[1]})`);
    const rows = await this.db
      .select()
      .from(userNotes)
      .where(and(...conds))
      .orderBy(desc(userNotes.createdAt), desc(userNotes.id))
      .limit(q.limit + 1);
    const page = toPage(rows, q.limit, (r) => [r.createdAt.toISOString(), r.id]);
    return { data: page.data.map((n) => this.noteView(n)), page: page.page };
  }
  ownedNote(userId, id) {
    return assertOwned(
      async () =>
        (
          await this.db
            .select()
            .from(userNotes)
            .where(and(eq(userNotes.id, id), eq(userNotes.ownerUserId, userId), isNull(userNotes.deletedAt)))
        )[0],
      "Note",
    );
  }
  async getNote(userId, id) {
    return this.noteView(await this.ownedNote(userId, id));
  }
  async updateNote(userId, id, body) {
    await this.ownedNote(userId, id);
    const [n] = await this.db
      .update(userNotes)
      .set({ body })
      .where(and(eq(userNotes.id, id), eq(userNotes.ownerUserId, userId)))
      .returning();
    return this.noteView(n);
  }
  async deleteNote(userId, id) {
    await this.ownedNote(userId, id);
    await this.db
      .update(userNotes)
      .set({ deletedAt: new Date() })
      .where(and(eq(userNotes.id, id), eq(userNotes.ownerUserId, userId)));
    return { id, deleted: true };
  }
  noteView(n) {
    return { id: n.id, subjectType: n.subjectType, subjectId: n.subjectId, body: n.body, createdAt: n.createdAt, updatedAt: n.updatedAt };
  }
  // ---- collections ----
  ownedCollection(userId, id) {
    return assertOwned(
      async () =>
        (
          await this.db
            .select()
            .from(userCollections)
            .where(and(eq(userCollections.id, id), eq(userCollections.ownerUserId, userId)))
        )[0],
      "Collection",
    );
  }
  async listCollections(userId) {
    const rows = await this.db
      .select({
        id: userCollections.id,
        name: userCollections.name,
        description: userCollections.description,
        createdAt: userCollections.createdAt,
        updatedAt: userCollections.updatedAt,
        items: sql`(select count(*)::int from ${userCollectionItems} i where i.collection_id = ${userCollections.id})`,
      })
      .from(userCollections)
      .where(eq(userCollections.ownerUserId, userId))
      .orderBy(desc(userCollections.createdAt));
    return { data: rows };
  }
  async createCollection(userId, input) {
    const [c] = await this.db
      .insert(userCollections)
      .values({ ownerUserId: userId, name: input.name, description: input.description ?? null })
      .returning();
    return { id: c.id, name: c.name, description: c.description, createdAt: c.createdAt, updatedAt: c.updatedAt, items: [] };
  }
  async getCollection(userId, id) {
    const c = await this.ownedCollection(userId, id);
    const items = await this.db
      .select()
      .from(userCollectionItems)
      .where(eq(userCollectionItems.collectionId, id))
      .orderBy(asc(userCollectionItems.position), asc(userCollectionItems.addedAt));
    return { id: c.id, name: c.name, description: c.description, createdAt: c.createdAt, updatedAt: c.updatedAt, items };
  }
  async updateCollection(userId, id, patch) {
    await this.ownedCollection(userId, id);
    await this.db
      .update(userCollections)
      .set(patch)
      .where(and(eq(userCollections.id, id), eq(userCollections.ownerUserId, userId)));
    return this.getCollection(userId, id);
  }
  async deleteCollection(userId, id) {
    await this.ownedCollection(userId, id);
    await this.db.delete(userCollections).where(and(eq(userCollections.id, id), eq(userCollections.ownerUserId, userId)));
    return { id, deleted: true };
  }
  async addCollectionItem(userId, id, item) {
    await this.ownedCollection(userId, id);
    if (item.itemType === "note") await this.ownedNote(userId, item.itemId);
    else await this.assertEntity(item.itemType, item.itemId);
    await this.db
      .insert(userCollectionItems)
      .values({ collectionId: id, itemType: item.itemType, itemId: item.itemId, position: item.position ?? 0 })
      .onConflictDoUpdate({
        target: [userCollectionItems.collectionId, userCollectionItems.itemType, userCollectionItems.itemId],
        set: { position: item.position ?? 0 },
      });
    await this.db.update(userCollections).set({ updatedAt: new Date() }).where(eq(userCollections.id, id));
    return this.getCollection(userId, id);
  }
  async removeCollectionItem(userId, id, itemType, itemId) {
    await this.ownedCollection(userId, id);
    await this.db
      .delete(userCollectionItems)
      .where(
        and(eq(userCollectionItems.collectionId, id), eq(userCollectionItems.itemType, itemType), eq(userCollectionItems.itemId, itemId)),
      );
    return this.getCollection(userId, id);
  }
  // ---- learning ----
  async setLearning(userId, conceptKey, status) {
    const [c] = await this.db.select({ key: tacticalConcepts.key }).from(tacticalConcepts).where(eq(tacticalConcepts.key, conceptKey));
    assertFound(c, "Concept");
    await this.db
      .insert(learningProgress)
      .values({ ownerUserId: userId, conceptKey, status })
      .onConflictDoUpdate({ target: [learningProgress.ownerUserId, learningProgress.conceptKey], set: { status } });
    return { conceptKey, status };
  }
  async learning(userId) {
    const rows = await this.db
      .select({
        conceptKey: learningProgress.conceptKey,
        status: learningProgress.status,
        updatedAt: learningProgress.updatedAt,
        name: tacticalConcepts.name,
      })
      .from(learningProgress)
      .innerJoin(tacticalConcepts, eq(tacticalConcepts.key, learningProgress.conceptKey))
      .where(eq(learningProgress.ownerUserId, userId))
      .orderBy(desc(learningProgress.updatedAt));
    return { data: rows };
  }
  /**
   * Personalised home feed (PDF section 3): recent and upcoming matches for followed teams, competitions and
   * players; the top insight of each recent analysed match; and concepts worth learning from those insights.
   */
  async feed(userId) {
    const f = await this.following(userId);
    if (!f.teams.length && !f.competitions.length && !f.players.length) {
      return {
        empty: true,
        nextStep: "Follow a club or competition to personalise your feed.",
        recent: [],
        upcoming: [],
        insights: [],
        concepts: [],
      };
    }
    const teamIds = f.teams.map((t) => t.id);
    const compIds = f.competitions.map((c) => c.id);
    const playerMatchIds = f.players.length
      ? sql`${matches.id} in (select match_id from lineups where player_id in (${sql.join(
          f.players.map((p) => sql`${p.id}`),
          sql`, `,
        )}))`
      : undefined;
    const scope = or(
      ...[
        teamIds.length ? or(inArray(matches.homeTeamId, teamIds), inArray(matches.awayTeamId, teamIds)) : undefined,
        compIds.length ? inArray(matches.competitionId, compIds) : undefined,
        playerMatchIds,
      ].filter((x) => Boolean(x)),
    );
    const recent = (await this.football.listMatches({ limit: 10, status: "played" }, scope)).data;
    const upcoming = (
      await this.football.listMatches({ limit: 10, status: "scheduled" }, and(scope, sql`${matches.kickoffAt} >= now()`))
    ).data.reverse();
    const recentIds = recent.filter((m) => m.analysisStatus === "complete").map((m) => m.id);
    const top = recentIds.length
      ? await this.db
          .select({
            id: insights.id,
            matchId: insights.matchId,
            headline: insights.headline,
            kind: insights.kind,
            teamId: insights.teamId,
            exploreLink: insights.exploreLink,
            rank: insights.rank,
          })
          .from(insights)
          .where(and(inArray(insights.matchId, recentIds), lt(insights.rank, 2)))
      : [];
    const metricKeys = [...new Set(top.flatMap((i) => i.exploreLink.metricKeys))];
    const done = new Set(
      (
        await this.db
          .select({ k: learningProgress.conceptKey })
          .from(learningProgress)
          .where(and(eq(learningProgress.ownerUserId, userId), eq(learningProgress.status, "completed")))
      ).map((r) => r.k),
    );
    const concepts = metricKeys.length
      ? (
          await this.db
            .select({
              key: tacticalConcepts.key,
              name: tacticalConcepts.name,
              simpleText: tacticalConcepts.simpleText,
              linked: tacticalConcepts.linkedMetricKeys,
            })
            .from(tacticalConcepts)
        )
          .filter((c) => !done.has(c.key) && c.linked.some((k) => metricKeys.includes(k)))
          .slice(0, 3)
          .map(({ linked: _l, ...c }) => c)
      : [];
    return { empty: false, recent, upcoming, insights: top, concepts };
  }
}
