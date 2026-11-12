// Authorization (BOLA / IDOR / BFLA): user B must never read, change or delete anything of user A's, through any
// route, verb, nested id or body field. Every check also verifies the database, not only the status code.
import { SKIP, startTestApp } from "./support/harness.js";
import { describe, it, before, after, expect } from "./support/expect.js";

describe("cross-user authorization", { skip: SKIP ?? false }, () => {
  let t;
  let a;
  let b;
  let match;
  let insight;
  let aNote;
  let aCollection;

  before(async () => {
    t = await startTestApp();
    a = await t.newUser("ownerA");
    b = await t.newUser("intruderB");
    match = t.matchIds["3869685"];
    insight = (await t.db.execute(t.sql`select id from insights where match_id = ${match} limit 1`)).rows[0].id;
    aNote = (await t.call("POST", "/v1/me/notes", { token: a.token, body: { subjectType: "match", subjectId: match, body: "A's private tactics" } })).body.data.note;
    aCollection = (await t.call("POST", "/v1/me/collections", { token: a.token, body: { name: "A's collection", description: "private" } })).body.data.collection;
    await t.call("PUT", `/v1/me/collections/${aCollection.id}/items`, { token: a.token, body: { itemType: "note", itemId: aNote.id } });
    await t.call("PUT", `/v1/me/saved-matches/${match}`, { token: a.token });
    await t.call("PUT", `/v1/me/saved-insights/${insight}`, { token: a.token });
    await t.call("PUT", `/v1/me/learning/ppda`, { token: a.token, body: { status: "completed" } });
  });
  after(async () => t?.close());

  const noteRow = async (id) => (await t.db.execute(t.sql`select body, deleted_at, owner_user_id from user_notes where id = ${id}`)).rows[0];
  const collectionRow = async (id) => (await t.db.execute(t.sql`select name, description, owner_user_id from user_collections where id = ${id}`)).rows[0];

  it("owner A can create, read, update and delete their own note", async () => {
    const created = await t.call("POST", "/v1/me/notes", { token: a.token, body: { subjectType: "team", subjectId: (await t.db.execute(t.sql`select home_team_id as id from matches where id = ${match}`)).rows[0].id, body: "tmp" } });
    expect(created.status).toBe(201);
    const id = created.body.data.note.id;
    expect((await t.get(`/v1/me/notes/${id}`, { token: a.token })).body.data.note.body).toBe("tmp");
    expect((await t.call("PATCH", `/v1/me/notes/${id}`, { token: a.token, body: { body: "tmp2" } })).body.data.note.body).toBe("tmp2");
    expect((await t.call("DELETE", `/v1/me/notes/${id}`, { token: a.token })).status).toBe(200);
    expect((await t.get(`/v1/me/notes/${id}`, { token: a.token })).status).toBe(404);
  });

  it("B cannot read, edit or delete A's note (404, row unchanged)", async () => {
    expect((await t.get(`/v1/me/notes/${aNote.id}`, { token: b.token })).status).toBe(404);
    expect((await t.call("PATCH", `/v1/me/notes/${aNote.id}`, { token: b.token, body: { body: "defaced" } })).status).toBe(404);
    expect((await t.call("DELETE", `/v1/me/notes/${aNote.id}`, { token: b.token })).status).toBe(404);
    expect(await noteRow(aNote.id)).toEqual({ body: "A's private tactics", deleted_at: null, owner_user_id: a.id });
  });

  it("B's note lists never include A's notes, even when filtering by A's subject", async () => {
    const list = await t.get(`/v1/me/notes?subjectType=match&subjectId=${match}`, { token: b.token });
    expect(list.status).toBe(200);
    expect(list.body.data.notes.map((n) => n.id)).not.toContain(aNote.id);
    expect(JSON.stringify(list.body)).not.toContain("A's private tactics");
  });

  it("B cannot read, rename, delete or modify the items of A's collection", async () => {
    expect((await t.get(`/v1/me/collections/${aCollection.id}`, { token: b.token })).status).toBe(404);
    expect((await t.call("PATCH", `/v1/me/collections/${aCollection.id}`, { token: b.token, body: { name: "owned" } })).status).toBe(404);
    expect((await t.call("PUT", `/v1/me/collections/${aCollection.id}/items`, { token: b.token, body: { itemType: "match", itemId: match } })).status).toBe(404);
    expect((await t.call("DELETE", `/v1/me/collections/${aCollection.id}/items/note/${aNote.id}`, { token: b.token })).status).toBe(404);
    expect((await t.call("DELETE", `/v1/me/collections/${aCollection.id}`, { token: b.token })).status).toBe(404);
    expect(await collectionRow(aCollection.id)).toEqual({ name: "A's collection", description: "private", owner_user_id: a.id });
    const items = (await t.db.execute(t.sql`select item_type, item_id from user_collection_items where collection_id = ${aCollection.id}`)).rows;
    expect(items).toEqual([{ item_type: "note", item_id: aNote.id }]);
    expect((await t.get("/v1/me/collections", { token: b.token })).body.data.collections.map((c) => c.id)).not.toContain(aCollection.id);
  });

  it("B cannot smuggle A's note into B's own collection (nested id)", async () => {
    const mine = (await t.call("POST", "/v1/me/collections", { token: b.token, body: { name: "B's" } })).body.data.collection;
    const res = await t.call("PUT", `/v1/me/collections/${mine.id}/items`, { token: b.token, body: { itemType: "note", itemId: aNote.id } });
    expect(res.status).toBe(404);
    const items = (await t.db.execute(t.sql`select count(*)::int as n from user_collection_items where collection_id = ${mine.id}`)).rows[0].n;
    expect(items).toBe(0);
  });

  it("B cannot take over ownership through body fields (mass assignment)", async () => {
    for (const [method, path, body] of [
      ["POST", "/v1/me/notes", { subjectType: "match", subjectId: match, body: "x", ownerUserId: a.id }],
      ["PATCH", `/v1/me/notes/${aNote.id}`, { body: "x", ownerUserId: b.id }],
      ["POST", "/v1/me/collections", { name: "x", ownerUserId: a.id }],
      ["PATCH", "/v1/me", { status: "active", email: "x@example.com" }],
      ["PATCH", "/v1/me", { plan: "pro_monthly" }],
      ["PUT", `/v1/me/learning/ppda`, { status: "completed", ownerUserId: a.id }],
    ]) {
      const res = await t.call(method, path, { token: b.token, body });
      expect(res.status).toBe(400);
    }
    expect((await noteRow(aNote.id)).owner_user_id).toBe(a.id);
  });

  it("saved items, follows and learning progress are invisible and untouchable across users", async () => {
    expect((await t.get("/v1/me/saved-matches", { token: b.token })).body.data.savedMatches).toEqual([]);
    expect((await t.get("/v1/me/saved-insights", { token: b.token })).body.data.savedInsights).toEqual([]);
    expect((await t.get("/v1/me/learning", { token: b.token })).body.data.learning).toEqual([]);
    // B "unsaving" the same match only touches B's own (empty) list.
    await t.call("DELETE", `/v1/me/saved-matches/${match}`, { token: b.token });
    await t.call("DELETE", `/v1/me/saved-insights/${insight}`, { token: b.token });
    const { rows } = await t.db.execute(t.sql`
      select (select count(*)::int from saved_matches where user_id = ${a.id}) as m,
             (select count(*)::int from saved_insights where owner_user_id = ${a.id}) as i,
             (select count(*)::int from learning_progress where owner_user_id = ${a.id}) as l`);
    expect(rows[0]).toEqual({ m: 1, i: 1, l: 1 });
  });

  it("entitlements, subscription and profile always describe the caller only", async () => {
    const ent = await t.get("/v1/entitlements", { token: b.token });
    expect(ent.status).toBe(200);
    const sub = await t.get("/v1/billing/subscription", { token: b.token });
    expect(sub.body.data.subscription.purchase).toBe(null);
    const me = await t.get("/v1/me", { token: b.token });
    expect(me.body.data.user.id).toBe(b.id);
    expect(JSON.stringify([ent.body, sub.body, me.body])).not.toContain(a.id);
  });

  it("a user's private job is hidden from other users and anonymous callers", async () => {
    const jobId = `authz.private-job.${a.id}`;
    await t.db.execute(t.sql`
      insert into ingestion_jobs (job_id, queue, job_type, status, payload, scope, schema_version, trace_id, requested_by_user_id)
      values (${jobId}, 'provider-sync', 'sync_competitions', 'completed', '{}', 'user', 1, 't', ${a.id})`);
    expect((await t.get(`/v1/jobs/${jobId}`, { token: a.token })).status).toBe(200);
    expect((await t.get(`/v1/jobs/${jobId}`, { token: b.token })).status).toBe(404);
    expect((await t.get(`/v1/jobs/${jobId}`)).status).toBe(404);
  });

  it("follows of every kind are private, validated and drive only the caller's feed", async () => {
    const u = await t.newUser("follower");
    const { rows: [ref] } = await t.db.execute(t.sql`select m.competition_id, (select player_id from lineups where match_id = m.id limit 1) as player_id from matches m where m.id = ${match}`);
    expect((await t.call("PUT", `/v1/me/following/competitions/${ref.competition_id}`, { token: u.token })).status).toBe(200);
    expect((await t.call("PUT", `/v1/me/following/players/${ref.player_id}`, { token: u.token })).status).toBe(200);
    expect((await t.call("PUT", `/v1/me/following/players/00000000-0000-7000-8000-000000000000`, { token: u.token })).status).toBe(404);
    expect((await t.call("PUT", `/v1/me/following/users/${a.id}`, { token: u.token })).status).toBe(400);
    const feed = await t.get("/v1/me/feed", { token: u.token });
    expect(feed.body.data.feed.empty).toBe(false);
    expect(feed.body.data.feed.recent.length).toBeGreaterThan(0);
    const following = (await t.get("/v1/me/following", { token: b.token })).body.data.following;
    expect(following.competitions.map((c) => c.id)).not.toContain(ref.competition_id);
    expect((await t.call("DELETE", `/v1/me/following/competitions/${ref.competition_id}`, { token: u.token })).status).toBe(200);
    expect((await t.call("DELETE", `/v1/me/following/players/${ref.player_id}`, { token: u.token })).status).toBe(200);
    expect((await t.get("/v1/me/feed", { token: u.token })).body.data.feed.empty).toBe(true);
    expect((await t.call("PUT", "/v1/me/learning/not-a-real-concept", { token: u.token, body: { status: "viewed" } })).status).toBe(404);
  });

  it("no administrative function is reachable over HTTP (BFLA)", async () => {
    for (const [method, path] of [
      ["POST", "/v1/admin/entitlements/grant"],
      ["POST", "/v1/jobs/authz.private-job/replay"],
      ["POST", "/v1/jobs"],
      ["DELETE", "/v1/jobs/authz.private-job"],
      ["POST", "/v1/entitlements"],
      ["PUT", "/v1/entitlements/analysis.matches_per_month"],
      ["POST", "/v1/billing/grant"],
      ["GET", "/v1/users"],
      ["GET", `/v1/users/${a.id}`],
      ["POST", "/v1/sync"],
    ]) {
      const res = await t.call(method, path, { token: b.token, body: method === "GET" ? undefined : {} });
      expect(res.status).toBe(404);
    }
  });

  it("deleting A's account removes A's private data but leaves B's data and shared football data intact", async () => {
    const victim = await t.newUser("deleteA");
    const n = (await t.call("POST", "/v1/me/notes", { token: victim.token, body: { subjectType: "match", subjectId: match, body: "gone soon" } })).body.data.note;
    await t.call("PUT", `/v1/me/saved-matches/${match}`, { token: victim.token });
    const bNotesBefore = (await t.get("/v1/me/notes", { token: b.token })).body.data.notes.length;
    const eventsBefore = (await t.db.execute(t.sql`select count(*)::int as n from events where match_id = ${match}`)).rows[0].n;

    expect((await t.call("DELETE", "/v1/me", { token: victim.token })).status).toBe(200);

    const { rows } = await t.db.execute(t.sql`
      select (select count(*)::int from user_notes where owner_user_id = ${victim.id}) as notes,
             (select count(*)::int from saved_matches where user_id = ${victim.id}) as saved,
             (select email from users where id = ${victim.id}) as email,
             (select status from users where id = ${victim.id}) as status`);
    expect(rows[0]).toEqual({ notes: 0, saved: 0, email: null, status: "deleted" });
    expect(await noteRow(n.id)).toBe(undefined);
    expect((await t.get("/v1/me/notes", { token: b.token })).body.data.notes.length).toBe(bNotesBefore);
    expect((await t.db.execute(t.sql`select count(*)::int as n from events where match_id = ${match}`)).rows[0].n).toBe(eventsBefore);
  });
});
