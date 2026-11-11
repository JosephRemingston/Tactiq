import { Inject, Injectable, Logger } from '@nestjs/common';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { verifyWebhook } from '@clerk/backend/webhooks';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { Errors } from '../../common/errors';

export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');

export interface VerifiedSession {
  clerkUserId: string;
  sessionId: string | null;
}

export interface IdentityProfile {
  clerkUserId: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  identities: Array<{ provider: string; subject: string; email: string | null }>;
}

export interface IdentitySession {
  id: string;
  status: string;
  lastActiveAt: string | null;
  expireAt: string | null;
  clientId: string | null;
}

export interface IdentityWebhookEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

/** Keeps Clerk behind an interface so a later identity change stays local to the auth module. */
export interface IdentityProvider {
  verifySessionToken(token: string): Promise<VerifiedSession | null>;
  getProfile(clerkUserId: string): Promise<IdentityProfile | null>;
  deleteUser(clerkUserId: string): Promise<void>;
  listSessions(clerkUserId: string): Promise<IdentitySession[]>;
  revokeSession(clerkUserId: string, sessionId: string): Promise<boolean>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<IdentityWebhookEvent>;
}

interface ClerkUserLike {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  imageUrl?: string | null;
  primaryEmailAddressId?: string | null;
  emailAddresses?: Array<{ id: string; emailAddress: string }>;
  externalAccounts?: Array<{ provider: string; externalId?: string; providerUserId?: string; emailAddress?: string }>;
}

/** Maps both SDK user objects (camelCase) and webhook payloads (snake_case) to a profile. */
export function toProfile(u: Record<string, unknown>): IdentityProfile {
  const user = u as ClerkUserLike & Record<string, unknown>;
  type Email = { id: string; emailAddress: string; status?: string | null };
  const sdkEmails = (user.emailAddresses as Array<{ id: string; emailAddress: string; verification?: { status?: string } | null }> | undefined)?.map((e) => ({
    id: e.id,
    emailAddress: e.emailAddress,
    status: e.verification?.status ?? null,
  }));
  const hookEmails = (u.email_addresses as Array<{ id: string; email_address: string; verification?: { status?: string } | null }> | undefined)?.map((e) => ({
    id: e.id,
    emailAddress: e.email_address,
    status: e.verification?.status ?? null,
  }));
  // Only a verified address is stored (sign-up requires a verification code); payloads without a status are trusted.
  const emails: Email[] = (sdkEmails ?? hookEmails ?? []).filter((e) => !e.status || e.status === 'verified');
  const primaryId = user.primaryEmailAddressId ?? (u.primary_email_address_id as string | null | undefined);
  const email = emails.find((e) => e.id === primaryId)?.emailAddress ?? emails[0]?.emailAddress ?? null;
  const first = user.firstName ?? (u.first_name as string | null | undefined);
  const last = user.lastName ?? (u.last_name as string | null | undefined);
  const displayName = [first, last].filter(Boolean).join(' ') || user.username || null;
  const external = (user.externalAccounts ??
    (u.external_accounts as Array<{ provider: string; provider_user_id?: string; email_address?: string }> | undefined)?.map((a) => ({
      provider: a.provider,
      providerUserId: a.provider_user_id,
      emailAddress: a.email_address,
    })) ??
    []) as Array<{ provider: string; providerUserId?: string; externalId?: string; emailAddress?: string }>;
  return {
    clerkUserId: user.id,
    email,
    displayName,
    avatarUrl: user.imageUrl ?? (u.image_url as string | null | undefined) ?? null,
    identities: external
      .filter((a) => a.providerUserId ?? a.externalId)
      .map((a) => ({ provider: a.provider.replace(/^oauth_/, ''), subject: String(a.providerUserId ?? a.externalId), email: a.emailAddress ?? null })),
  };
}

@Injectable()
export class ClerkIdentityProvider implements IdentityProvider {
  private readonly logger = new Logger('Clerk');
  private readonly client: ReturnType<typeof createClerkClient> | null;
  private readonly authorizedParties: string[];

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.client = config.CLERK_SECRET_KEY ? createClerkClient({ secretKey: config.CLERK_SECRET_KEY, publishableKey: config.CLERK_PUBLISHABLE_KEY }) : null;
    this.authorizedParties = config.CLERK_AUTHORIZED_PARTIES.split(',')
      .map((p) => p.trim())
      .filter(Boolean);
  }

  private warnedUnconfigured = false;

  async verifySessionToken(token: string): Promise<VerifiedSession | null> {
    if (!this.config.CLERK_JWT_KEY && !this.config.CLERK_SECRET_KEY) {
      if (!this.warnedUnconfigured) this.logger.warn('Neither CLERK_JWT_KEY nor CLERK_SECRET_KEY is set: every authenticated request is rejected');
      this.warnedUnconfigured = true;
      return null;
    }
    // The published types describe { data, errors }, but the runtime resolves to the claims and throws on failure.
    // Accept both shapes so an SDK patch release cannot silently turn every request into a 401 or a 200.
    let result: unknown;
    try {
      result = await verifyToken(token, {
        jwtKey: this.config.CLERK_JWT_KEY?.replace(/\\n/g, '\n'),
        secretKey: this.config.CLERK_SECRET_KEY || undefined,
        authorizedParties: this.authorizedParties.length ? this.authorizedParties : undefined,
        clockSkewInMs: 5000,
      });
    } catch {
      return null;
    }
    const shaped = result as { data?: unknown; errors?: unknown[] } | null;
    if (!shaped || (Array.isArray(shaped.errors) && shaped.errors.length)) return null;
    const claims = ('data' in shaped && shaped.data ? shaped.data : shaped) as { sub?: unknown; sid?: unknown; sts?: unknown };
    if (typeof claims.sub !== 'string' || !claims.sub) return null;
    // Sessions with unfinished tasks (sts = "pending") are signed-out, as in Clerk's own authenticateRequest.
    if (claims.sts === 'pending') return null;
    return { clerkUserId: claims.sub, sessionId: typeof claims.sid === 'string' ? claims.sid : null };
  }

  async getProfile(clerkUserId: string): Promise<IdentityProfile | null> {
    if (!this.client) return null;
    const user = await this.client.users.getUser(clerkUserId);
    return toProfile(user as unknown as Record<string, unknown>);
  }

  async deleteUser(clerkUserId: string): Promise<void> {
    if (!this.client) {
      this.logger.warn(`CLERK_SECRET_KEY not set: skipped deleting Clerk user ${clerkUserId}`);
      return;
    }
    try {
      await this.client.users.deleteUser(clerkUserId);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 404) throw err; // already gone is fine (idempotent saga)
    }
  }

  async listSessions(clerkUserId: string): Promise<IdentitySession[]> {
    if (!this.client) throw Errors.providerUnavailable('Session management is not configured');
    const res = await this.client.sessions.getSessionList({ userId: clerkUserId, limit: 50 });
    return res.data.map((s) => ({
      id: s.id,
      status: s.status,
      lastActiveAt: s.lastActiveAt ? new Date(s.lastActiveAt).toISOString() : null,
      expireAt: s.expireAt ? new Date(s.expireAt).toISOString() : null,
      clientId: s.clientId ?? null,
    }));
  }

  async revokeSession(clerkUserId: string, sessionId: string): Promise<boolean> {
    if (!this.client) throw Errors.providerUnavailable('Session management is not configured');
    const sessions = await this.listSessions(clerkUserId);
    if (!sessions.some((s) => s.id === sessionId)) return false; // never revoke another user's session
    await this.client.sessions.revokeSession(sessionId);
    return true;
  }

  async verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<IdentityWebhookEvent> {
    if (!this.config.CLERK_WEBHOOK_SIGNING_SECRET) throw Errors.providerUnavailable('Webhook signing secret is not configured');
    const h = new Headers();
    for (const [k, v] of Object.entries(headers)) if (typeof v === 'string') h.set(k, v);
    const request = new Request('http://localhost/v1/webhooks/clerk', { method: 'POST', headers: h, body: new Uint8Array(rawBody) });
    const evt = await verifyWebhook(request, { signingSecret: this.config.CLERK_WEBHOOK_SIGNING_SECRET });
    const id = h.get('svix-id') ?? h.get('webhook-id') ?? '';
    return { id, type: evt.type, data: evt.data as unknown as Record<string, unknown> };
  }
}
