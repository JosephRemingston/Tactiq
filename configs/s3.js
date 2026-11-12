import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AwsClient } from "aws4fetch";
import { getEnv } from "./env.js";

/**
 * Object storage for raw provider payloads.
 * neon / s3: an S3-compatible bucket addressed path-style with explicit S3_* credentials
 *            (never the AWS default credential chain).
 * fs:        local disk, for tests and offline development.
 */
function s3Storage(env) {
  const client = new AwsClient({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    service: "s3",
    region: env.S3_REGION_OVERRIDE ?? "us-east-1",
  });
  const base = `${env.S3_ENDPOINT.replace(/\/+$/, "")}/${env.S3_BUCKET_RAW}`;
  const urlOf = (key) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;

  return {
    driver: env.STORAGE_DRIVER,
    async put(key, body, contentType = "application/json") {
      const res = await client.fetch(urlOf(key), { method: "PUT", body, headers: { "content-type": contentType } });
      if (!res.ok) throw new Error(`storage put ${key} failed: ${res.status} ${await res.text().catch(() => "")}`.trim());
    },
    async get(key) {
      const res = await client.fetch(urlOf(key), { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`storage get ${key} failed: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async exists(key) {
      const res = await client.fetch(urlOf(key), { method: "HEAD" });
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`storage head ${key} failed: ${res.status}`);
      return true;
    },
    async ping() {
      const res = await client.fetch(base, { method: "HEAD" });
      return res.ok;
    },
  };
}

function fsStorage(env) {
  const root = resolve(env.STORAGE_FS_ROOT, env.S3_BUCKET_RAW);
  const pathOf = (key) => join(root, key);
  return {
    driver: "fs",
    async put(key, body) {
      await mkdir(dirname(pathOf(key)), { recursive: true });
      await writeFile(pathOf(key), body);
    },
    async get(key) {
      try {
        return await readFile(pathOf(key));
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
    },
    async exists(key) {
      try {
        await access(pathOf(key));
        return true;
      } catch {
        return false;
      }
    },
    async ping() {
      await mkdir(root, { recursive: true });
      return true;
    },
  };
}

let storage = null;

export function getStorage() {
  if (!storage) {
    const env = getEnv();
    storage = env.STORAGE_DRIVER === "fs" ? fsStorage(env) : s3Storage(env);
  }
  return storage;
}

export default getStorage;
