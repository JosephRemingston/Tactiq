import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from '../../config/env';

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

/** Raw provider payloads, Parquet exports and report artifacts live here (Neon Object Storage, S3 or local disk). */
export interface ObjectStorage {
  readonly bucket: string;
  ensureBucket(): Promise<void>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  ping(): Promise<boolean>;
}

export interface S3Settings {
  endpoint: string | undefined;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/**
 * STORAGE_DRIVER=neon reads the variables `neon env pull` writes (AWS_ENDPOINT_URL_S3, AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY, AWS_REGION) unless S3_* overrides are set, and always uses path-style addressing.
 * STORAGE_DRIVER=s3 uses the S3_* variables only.
 */
export function resolveS3Settings(config: AppConfig): S3Settings {
  const neon = config.STORAGE_DRIVER === 'neon';
  const endpoint = config.S3_ENDPOINT ?? (neon ? config.AWS_ENDPOINT_URL_S3 : undefined);
  const accessKeyId = config.S3_ACCESS_KEY_ID ?? (neon ? config.AWS_ACCESS_KEY_ID : undefined);
  const secretAccessKey = config.S3_SECRET_ACCESS_KEY ?? (neon ? config.AWS_SECRET_ACCESS_KEY : undefined);
  if (!accessKeyId || !secretAccessKey) throw new Error(`object storage credentials missing for STORAGE_DRIVER=${config.STORAGE_DRIVER}`);
  if (neon && !endpoint) throw new Error('STORAGE_DRIVER=neon needs AWS_ENDPOINT_URL_S3 (from `neon env pull`) or S3_ENDPOINT');
  return { endpoint, region: config.S3_REGION_OVERRIDE ?? (neon ? (config.AWS_REGION ?? config.S3_REGION) : config.S3_REGION), accessKeyId, secretAccessKey, forcePathStyle: neon ? true : config.S3_FORCE_PATH_STYLE };
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly autoCreate: boolean;
  readonly bucket: string;

  constructor(config: AppConfig) {
    const s3 = resolveS3Settings(config);
    this.bucket = config.S3_BUCKET_RAW;
    // Explicit credentials only: the AWS default chain (~/.aws) is never consulted.
    this.client = new S3Client({
      region: s3.region,
      endpoint: s3.endpoint,
      forcePathStyle: s3.forcePathStyle, // Neon supports path-style addressing only
      credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
      // Recent SDKs add CRC checksums by default; Neon (and most S3-compatible stores) need them only when required.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    // Neon buckets are created with `neon buckets create` or the Console; only local endpoints auto-create.
    this.autoCreate = config.STORAGE_DRIVER === 'neon' ? false : (config.S3_AUTO_CREATE_BUCKET ?? Boolean(config.S3_ENDPOINT));
  }

  /** Creates the bucket only for local S3-compatible endpoints (or when explicitly enabled); otherwise just checks it. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      if (!this.autoCreate) throw new Error(`bucket ${this.bucket} is not reachable and auto-create is off: ${(err as Error).name}`);
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`object ${key} has no body`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }
}

/** Filesystem driver for tests and offline development. */
export class FsObjectStorage implements ObjectStorage {
  readonly bucket: string;
  private readonly root: string;

  constructor(root: string, bucket = 'local') {
    this.root = resolve(root);
    this.bucket = bucket;
  }

  private path(key: string): string {
    const full = resolve(join(this.root, this.bucket, key));
    if (!full.startsWith(join(this.root, this.bucket))) throw new Error(`invalid object key ${key}`);
    return full;
  }

  async ensureBucket(): Promise<void> {
    await mkdir(join(this.root, this.bucket), { recursive: true });
  }

  async put(key: string, body: Buffer): Promise<void> {
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async exists(key: string): Promise<boolean> {
    return stat(this.path(key)).then(
      () => true,
      () => false,
    );
  }

  async ping(): Promise<boolean> {
    return true;
  }
}

export function createObjectStorage(config: AppConfig): ObjectStorage {
  if (config.STORAGE_DRIVER === 'fs') return new FsObjectStorage(config.STORAGE_FS_ROOT, config.S3_BUCKET_RAW);
  return new S3ObjectStorage(config); // 's3' and 'neon'
}
