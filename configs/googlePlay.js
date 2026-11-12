import { createHash, createSign } from "node:crypto";
import { getEnv } from "./env.js";

/**
 * Purchase verification against the Google Play Developer API. Kept behind a small interface
 * (`getSubscription`, `acknowledge`) so tests and local runs can use the fake verifier below.
 */

const ANDROID_PUBLISHER = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";

/** Google subscription states (subscriptionsv2) mapped to Touchline purchase states. */
const STATES = {
  SUBSCRIPTION_STATE_PENDING: "pending",
  SUBSCRIPTION_STATE_ACTIVE: "active",
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: "grace",
  SUBSCRIPTION_STATE_ON_HOLD: "on_hold",
  SUBSCRIPTION_STATE_PAUSED: "paused",
  SUBSCRIPTION_STATE_CANCELED: "cancelled",
  SUBSCRIPTION_STATE_EXPIRED: "expired",
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: "expired",
  SUBSCRIPTION_STATE_UNSPECIFIED: "pending",
};

export class PurchaseNotFoundError extends Error {
  constructor(message = "Purchase token not recognised by the store") {
    super(message);
    this.name = "PurchaseNotFoundError";
  }
}

/** Normalises a subscriptionsv2 response. */
export function fromSubscriptionV2(body) {
  const line = body.lineItems?.[0] ?? {};
  return {
    productId: line.productId ?? null,
    state: STATES[body.subscriptionState] ?? "pending",
    startedAt: body.startTime ? new Date(body.startTime) : null,
    expiresAt: line.expiryTime ? new Date(line.expiryTime) : null,
    orderId: body.latestOrderId ?? null,
    autoRenewing: Boolean(line.autoRenewingPlan?.autoRenewEnabled),
    acknowledged: body.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    linkedPurchaseToken: body.linkedPurchaseToken ?? null,
    obfuscatedAccountId: body.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null,
    testPurchase: Boolean(body.testPurchase),
    raw: body,
  };
}

function b64url(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

export class GooglePlayVerifier {
  constructor({ packageName, serviceAccount, fetchImpl = fetch }) {
    this.packageName = packageName;
    this.serviceAccount = serviceAccount;
    this.fetchImpl = fetchImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  /** OAuth access token from a service-account JWT (RS256), cached until shortly before it expires. */
  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
      iss: this.serviceAccount.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.serviceAccount.private_key).toString("base64url");
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Google OAuth token request failed: ${res.status}`);
    const body = await res.json();
    this.token = body.access_token;
    this.tokenExpiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.token;
  }

  async call(method, path, body) {
    const res = await this.fetchImpl(`${ANDROID_PUBLISHER}/${encodeURIComponent(this.packageName)}/${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404 || res.status === 410) throw new PurchaseNotFoundError();
    if (!res.ok) throw new Error(`Google Play API ${method} ${path.split("/")[0]} failed: ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  async getSubscription(purchaseToken) {
    return fromSubscriptionV2(await this.call("GET", `purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`));
  }

  async acknowledge(productId, purchaseToken) {
    await this.call("POST", `purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`, {});
  }
}

/**
 * Test and local-development verifier. A token encodes the answer the store would give:
 *   fake:<productId>:<state>[:<daysUntilExpiry>[:<obfuscatedAccountId>]]
 * e.g. fake:pro_monthly:active:30. Unknown or malformed tokens behave like a token the store does not know.
 */
export class FakePurchaseVerifier {
  constructor() {
    this.acknowledged = new Set();
    this.overrides = new Map();
    this.firstSeen = new Map();
    this.failure = null;
    this.calls = 0;
  }

  /**
   * Test hook: make later lookups of `token` return a different state (simulates a renewal, refund, expiry).
   * `extra` can set e.g. { linkedPurchaseToken, orderId }.
   */
  setState(token, state, daysUntilExpiry, extra = {}) {
    // Like Google, the dates are fixed facts of the purchase: they are set when the state changes, not on every read.
    const expiresAt = new Date(Date.now() + Number(daysUntilExpiry ?? 30) * 86_400_000);
    this.overrides.set(token, { state, expiresAt, extra });
  }

  /** Test hook: every store call throws `err` until cleared with failWith(null) (simulates a Google outage). */
  failWith(err) {
    this.failure = err;
  }

  /** The order id the fake store reports for a token: stable per token, like Google's latest order id. */
  static orderIdFor(token) {
    return `GPA.fake-${createHash("sha256").update(String(token)).digest("hex").slice(0, 12)}`;
  }

  /**
   * Test hook: the next lookup reads the store state immediately but delivers its answer only when the returned
   * function is called. Simulates a slow network response that arrives after newer information was applied.
   */
  holdNext() {
    let release;
    const gate = new Promise((r) => (release = r));
    this.held = gate;
    return () => release();
  }

  async getSubscription(purchaseToken) {
    const gate = this.held;
    this.held = null;
    const answer = await this.read(purchaseToken);
    if (gate) await gate;
    return answer;
  }

  async read(purchaseToken) {
    this.calls += 1;
    if (this.failure) throw this.failure;
    const [prefix, productId, state, days, account] = String(purchaseToken).split(":");
    if (prefix !== "fake" || !productId || !state) throw new PurchaseNotFoundError();
    const o = this.overrides.get(purchaseToken);
    const effState = o?.state ?? state;
    if (!this.firstSeen.has(purchaseToken)) this.firstSeen.set(purchaseToken, Date.now());
    const seen = this.firstSeen.get(purchaseToken);
    return {
      productId,
      state: effState,
      startedAt: new Date(seen - 86_400_000),
      expiresAt: o ? o.expiresAt : new Date(seen + Number(days ?? 30) * 86_400_000),
      orderId: FakePurchaseVerifier.orderIdFor(purchaseToken),
      autoRenewing: effState === "active",
      acknowledged: this.acknowledged.has(purchaseToken),
      linkedPurchaseToken: null,
      obfuscatedAccountId: account || null,
      testPurchase: true,
      raw: { fake: true, state: effState },
      ...(o?.extra ?? {}),
    };
  }

  async acknowledge(productId, purchaseToken) {
    if (this.failure) throw this.failure;
    this.acknowledged.add(purchaseToken);
  }
}

let verifier;

/**
 * The configured verifier, or null when billing is not set up yet (endpoints then answer 503).
 * BILLING_FAKE_VERIFIER=true selects the fake one outside production.
 */
export function getPurchaseVerifier() {
  if (verifier !== undefined) return verifier;
  const env = getEnv();
  if (env.BILLING_FAKE_VERIFIER && env.NODE_ENV !== "production") {
    verifier = new FakePurchaseVerifier();
  } else if (env.GOOGLE_PLAY_PACKAGE_NAME && env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
    verifier = new GooglePlayVerifier({ packageName: env.GOOGLE_PLAY_PACKAGE_NAME, serviceAccount });
  } else {
    verifier = null;
  }
  return verifier;
}

/** Test hook. */
export function resetPurchaseVerifier() {
  verifier = undefined;
}
