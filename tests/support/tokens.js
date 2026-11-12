import { createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const TEST_JWT_PUBLIC_KEY = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
export const TEST_AUTHORIZED_PARTY = "https://app.touchline.test";

const b64 = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v))).toString("base64url");

/** Signs a Clerk-shaped RS256 session token with the test key (verified by @clerk/backend's real verifyToken). */
export function signSessionToken(sub, opts = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: "ins_test" };
  const payload = {
    sub,
    sid: opts.sid ?? `sess_${sub}`,
    azp: opts.azp ?? TEST_AUTHORIZED_PARTY,
    iss: "https://touchline-test.clerk.accounts.dev",
    iat: now,
    nbf: now - 5,
    exp: now + (opts.expiresInSec ?? 600),
    ...(opts.sts ? { sts: opts.sts } : {}),
  };
  const input = `${b64(header)}.${b64(payload)}`;
  const signature = sign("RSA-SHA256", Buffer.from(input), keys.privateKey);
  return `${input}.${signature.toString("base64url")}`;
}

// Generated fresh on every test run; never a real credential.
export const TEST_WEBHOOK_SECRET = `whsec_${randomBytes(24).toString("base64")}`; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret

/** Svix / Standard Webhooks signature headers for a body. */
export function signWebhook(body, secret = TEST_WEBHOOK_SECRET, id = `msg_${randomBytes(8).toString("hex")}`) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64"); // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
  const sig = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${sig}`, "content-type": "application/json" };
}
