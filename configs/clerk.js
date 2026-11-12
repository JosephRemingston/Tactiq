import { createClerkClient, verifyToken } from "@clerk/backend";
import { verifyWebhook as clerkVerifyWebhook } from "@clerk/backend/webhooks";
import { getEnv } from "./env.js";
import ApiError from "../utils/ApiError.js";

let client;
let warnedUnconfigured = false;

function getClient() {
  if (client === undefined) {
    const env = getEnv();
    client = env.CLERK_SECRET_KEY ? createClerkClient({ secretKey: env.CLERK_SECRET_KEY, publishableKey: env.CLERK_PUBLISHABLE_KEY }) : null;
  }
  return client;
}

function authorizedParties() {
  return getEnv()
    .CLERK_AUTHORIZED_PARTIES.split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Verifies a Clerk session JWT. Returns { clerkUserId, sessionId } or null when the token is not valid. */
export async function verifySessionToken(token) {
  const env = getEnv();
  if (!env.CLERK_JWT_KEY && !env.CLERK_SECRET_KEY) {
    if (!warnedUnconfigured) console.warn("Neither CLERK_JWT_KEY nor CLERK_SECRET_KEY is set: every authenticated request is rejected");
    warnedUnconfigured = true;
    return null;
  }
  const parties = authorizedParties();
  // Depending on the SDK release the call resolves to the claims or to { data, errors }; accept both shapes.
  let result;
  try {
    result = await verifyToken(token, {
      jwtKey: env.CLERK_JWT_KEY?.replace(/\\n/g, "\n"),
      secretKey: env.CLERK_SECRET_KEY || undefined,
      authorizedParties: parties.length ? parties : undefined,
      clockSkewInMs: 5000,
    });
  } catch {
    return null;
  }
  if (!result || (Array.isArray(result.errors) && result.errors.length)) return null;
  const claims = "data" in result && result.data ? result.data : result;
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  // Sessions with unfinished tasks (sts = "pending") count as signed out.
  if (claims.sts === "pending") return null;
  return { clerkUserId: claims.sub, sessionId: typeof claims.sid === "string" ? claims.sid : null };
}

/** Maps both SDK user objects (camelCase) and webhook payloads (snake_case) to a profile. */
export function toProfile(u) {
  const sdkEmails = u.emailAddresses?.map((e) => ({ id: e.id, emailAddress: e.emailAddress, status: e.verification?.status ?? null }));
  const hookEmails = u.email_addresses?.map((e) => ({ id: e.id, emailAddress: e.email_address, status: e.verification?.status ?? null }));
  // Only a verified address is stored; payloads without a status are trusted.
  const emails = (sdkEmails ?? hookEmails ?? []).filter((e) => !e.status || e.status === "verified");
  const primaryId = u.primaryEmailAddressId ?? u.primary_email_address_id;
  const email = emails.find((e) => e.id === primaryId)?.emailAddress ?? emails[0]?.emailAddress ?? null;
  const first = u.firstName ?? u.first_name;
  const last = u.lastName ?? u.last_name;
  const displayName = [first, last].filter(Boolean).join(" ") || u.username || null;
  const external =
    u.externalAccounts ??
    u.external_accounts?.map((a) => ({ provider: a.provider, providerUserId: a.provider_user_id, emailAddress: a.email_address })) ??
    [];
  return {
    clerkUserId: u.id,
    email,
    displayName,
    avatarUrl: u.imageUrl ?? u.image_url ?? null,
    identities: external
      .filter((a) => a.providerUserId ?? a.externalId)
      .map((a) => ({ provider: a.provider.replace(/^oauth_/, ""), subject: String(a.providerUserId ?? a.externalId), email: a.emailAddress ?? null })),
  };
}

export async function getProfile(clerkUserId) {
  const c = getClient();
  if (!c) return null;
  const user = await c.users.getUser(clerkUserId);
  return toProfile(user);
}

export async function deleteUser(clerkUserId) {
  const c = getClient();
  if (!c) {
    console.warn(`CLERK_SECRET_KEY not set: skipped deleting Clerk user ${clerkUserId}`);
    return;
  }
  try {
    await c.users.deleteUser(clerkUserId);
  } catch (err) {
    if (err.status !== 404) throw err; // already gone is fine
  }
}

export async function listSessions(clerkUserId) {
  const c = getClient();
  if (!c) throw ApiError.unavailable("Session management is not configured");
  const res = await c.sessions.getSessionList({ userId: clerkUserId, limit: 50 });
  return res.data.map((s) => ({
    id: s.id,
    status: s.status,
    lastActiveAt: s.lastActiveAt ? new Date(s.lastActiveAt).toISOString() : null,
    expireAt: s.expireAt ? new Date(s.expireAt).toISOString() : null,
    clientId: s.clientId ?? null,
  }));
}

export async function revokeSession(clerkUserId, sessionId) {
  const c = getClient();
  if (!c) throw ApiError.unavailable("Session management is not configured");
  const sessions = await listSessions(clerkUserId);
  if (!sessions.some((s) => s.id === sessionId)) return false; // never revoke another user's session
  await c.sessions.revokeSession(sessionId);
  return true;
}

/** Verifies the Svix signature on a Clerk webhook. `rawBody` must be the untouched request bytes. */
export async function verifyWebhook(rawBody, headers) {
  const secret = getEnv().CLERK_WEBHOOK_SIGNING_SECRET;
  if (!secret) throw ApiError.unavailable("Webhook signing secret is not configured");
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) if (typeof v === "string") h.set(k, v);
  const request = new Request("http://localhost/v1/webhooks/clerk", { method: "POST", headers: h, body: new Uint8Array(rawBody) });
  const evt = await clerkVerifyWebhook(request, { signingSecret: secret });
  // The signature proves who sent it, not that it is well formed: check the shape before anything reads it.
  if (!evt || typeof evt !== "object" || Array.isArray(evt) || typeof evt.type !== "string" || !evt.data || typeof evt.data !== "object") {
    throw ApiError.badRequest("Malformed webhook event");
  }
  const id = h.get("svix-id") ?? h.get("webhook-id") ?? "";
  return { id, type: evt.type, data: evt.data };
}

/** The identity provider as one object, so services depend on these six functions and not on Clerk itself. */
export const identity = { verifySessionToken, getProfile, deleteUser, listSessions, revokeSession, verifyWebhook };

export default identity;
