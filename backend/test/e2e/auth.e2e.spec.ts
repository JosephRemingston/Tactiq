import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { entitlements, securityEvents, users } from '../../src/db/schema';
import { createTestApp, resetUsers, type TestApp } from '../support/app';
import { signSessionToken, signWebhook } from '../support/tokens';

describe('auth (Clerk session JWT + webhooks)', () => {
  let t: TestApp;
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t?.close());
  beforeEach(async () => resetUsers(t.db));

  it('rejects private routes without a token', async () => {
    const res = await http().get('/v1/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.body.error.traceId).toBeTruthy();
  });

  it('rejects tokens signed by another key, expired tokens and wrong authorized party', async () => {
    const forged = signSessionToken('user_a').replace(/\.[^.]+$/, '.AAAA');
    expect((await http().get('/v1/me').set('authorization', `Bearer ${forged}`)).status).toBe(401);
    const expired = signSessionToken('user_a', { expiresInSec: -60 });
    expect((await http().get('/v1/me').set('authorization', `Bearer ${expired}`)).status).toBe(401);
    const wrongAzp = signSessionToken('user_a', { azp: 'https://evil.example' });
    expect((await http().get('/v1/me').set('authorization', `Bearer ${wrongAzp}`)).status).toBe(401);
  });

  it('treats sessions with pending tasks as signed out, active sessions as signed in', async () => {
    expect((await http().get('/v1/me').set('authorization', `Bearer ${signSessionToken('user_pending', { sts: 'pending' })}`)).status).toBe(401);
    expect((await http().get('/v1/me').set('authorization', `Bearer ${signSessionToken('user_active', { sts: 'active' })}`)).status).toBe(200);
  });

  it('stores only a verified primary email from webhooks', async () => {
    const body = JSON.stringify({
      type: 'user.created',
      object: 'event',
      data: {
        id: 'user_unverified',
        primary_email_address_id: 'e1',
        email_addresses: [{ id: 'e1', email_address: 'pending@example.com', verification: { status: 'unverified' } }],
      },
    });
    await http().post('/v1/webhooks/clerk').set(signWebhook(body)).send(body).expect(200);
    const [user] = await t.db.select().from(users).where(eq(users.clerkUserId, 'user_unverified'));
    expect(user?.email).toBeNull();
  });

  it('lazily creates the local user on first request and materializes free entitlements once', async () => {
    const token = signSessionToken('user_lazy');
    const first = await http().get('/v1/me').set('authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.plan.key).toBe('free');
    expect(first.body.depthPreference).toBe('quick');
    await http().get('/v1/me').set('authorization', `Bearer ${token}`).expect(200);

    const rows = await t.db.select().from(users).where(eq(users.clerkUserId, 'user_lazy'));
    expect(rows).toHaveLength(1);
    const ents = await t.db.select().from(entitlements).where(eq(entitlements.userId, rows[0]!.id));
    expect(ents.length).toBeGreaterThan(5);
    expect(new Set(ents.map((e) => e.featureKey)).size).toBe(ents.length);
  });

  it('updates profile preferences with validation', async () => {
    const token = signSessionToken('user_patch');
    const ok = await http().patch('/v1/me').set('authorization', `Bearer ${token}`).send({ depthPreference: 'advanced', displayName: 'Ana' });
    expect(ok.status).toBe(200);
    expect(ok.body.depthPreference).toBe('advanced');
    const bad = await http().patch('/v1/me').set('authorization', `Bearer ${token}`).send({ depthPreference: 'expert', clerkUserId: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('accepts signed Clerk webhooks, ignores replays and rejects bad signatures', async () => {
    const body = JSON.stringify({
      type: 'user.created',
      object: 'event',
      data: {
        id: 'user_hook',
        first_name: 'Lio',
        last_name: 'M',
        image_url: 'https://img.test/a.png',
        primary_email_address_id: 'e1',
        email_addresses: [{ id: 'e1', email_address: 'lio@example.com' }],
        external_accounts: [{ provider: 'oauth_google', provider_user_id: 'g-123', email_address: 'lio@example.com' }],
      },
    });
    const headers = signWebhook(body);
    const first = await http().post('/v1/webhooks/clerk').set(headers).send(body);
    expect(first.status).toBe(200);
    const replay = await http().post('/v1/webhooks/clerk').set(headers).send(body);
    expect(replay.body.duplicate).toBe(true);

    const [user] = await t.db.select().from(users).where(eq(users.clerkUserId, 'user_hook'));
    expect(user?.email).toBe('lio@example.com');
    expect(user?.displayName).toBe('Lio M');

    const tampered = await http().post('/v1/webhooks/clerk').set(headers).send(body.replace('Lio', 'Eve'));
    expect(tampered.status).toBe(401);
    const rejected = await t.db.select().from(securityEvents).where(eq(securityEvents.kind, 'webhook_rejected'));
    expect(rejected.length).toBe(1);
  });

  it('deletes the account: private data removed, PII scrubbed, token no longer accepted', async () => {
    const token = signSessionToken('user_del');
    await http().get('/v1/me').set('authorization', `Bearer ${token}`).expect(200);
    const res = await http().delete('/v1/me').set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    const [user] = await t.db.select().from(users).where(eq(users.clerkUserId, 'user_del'));
    expect(user?.status).toBe('deleted');
    expect(user?.email).toBeNull();
    expect((await http().get('/v1/me').set('authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('webhook user.deleted runs the same idempotent deletion saga', async () => {
    const token = signSessionToken('user_wdel');
    await http().get('/v1/me').set('authorization', `Bearer ${token}`).expect(200);
    const body = JSON.stringify({ type: 'user.deleted', object: 'event', data: { id: 'user_wdel', deleted: true } });
    await http().post('/v1/webhooks/clerk').set(signWebhook(body)).send(body).expect(200);
    await http().post('/v1/webhooks/clerk').set(signWebhook(body)).send(body).expect(200);
    const [user] = await t.db.select().from(users).where(eq(users.clerkUserId, 'user_wdel'));
    expect(user?.status).toBe('deleted');
  });

  it('health endpoints are public and unversioned', async () => {
    expect((await http().get('/healthz')).body.status).toBe('ok');
    const ready = await http().get('/readyz');
    expect(ready.status).toBe(200);
  });
});
