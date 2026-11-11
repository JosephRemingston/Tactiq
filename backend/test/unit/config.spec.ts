import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env';
import { resolveS3Settings } from '../../src/infra/storage/object-storage';
import { redisTlsOptions } from '../../src/infra/redis/redis.service';
import { jobIds } from '../../src/infra/queue/queue.constants';

const base = { DATABASE_URL: 'postgres://x@localhost/x', S3_ENDPOINT: undefined, S3_ACCESS_KEY_ID: undefined, S3_SECRET_ACCESS_KEY: undefined, AWS_ENDPOINT_URL_S3: undefined, AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_REGION: undefined };

describe('object storage configuration', () => {
  it('neon driver reads the variables written by `neon env pull` and forces path-style', () => {
    const c = loadConfig({ ...base, STORAGE_DRIVER: 'neon', AWS_ENDPOINT_URL_S3: 'https://storage.example.neon.tech', AWS_ACCESS_KEY_ID: 'tok', AWS_SECRET_ACCESS_KEY: 'sec', AWS_REGION: 'ap-southeast-1', S3_FORCE_PATH_STYLE: 'false' });
    expect(resolveS3Settings(c)).toEqual({ endpoint: 'https://storage.example.neon.tech', region: 'ap-southeast-1', accessKeyId: 'tok', secretAccessKey: 'sec', forcePathStyle: true });
  });

  it('neon driver without credentials or endpoint fails with a readable message', () => {
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: 'neon' })).toThrow(/neon env pull/);
  });

  it('s3 driver never uses AWS_* variables (no accidental real-AWS fallback)', () => {
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: 's3', AWS_ACCESS_KEY_ID: 'real', AWS_SECRET_ACCESS_KEY: 'real' })).toThrow(/S3_ACCESS_KEY_ID/);
  });

  it('fs is the default driver', () => {
    expect(loadConfig({ ...base, STORAGE_DRIVER: undefined }).STORAGE_DRIVER).toBe('fs');
  });
});

describe('redis TLS', () => {
  it('upgrades TLS-only hosts and honours rediss://', () => {
    expect(redisTlsOptions('redis://default:x@abc.upstash.io:6379')).toEqual({ tls: {} });
    expect(redisTlsOptions('rediss://localhost:6379')).toEqual({ tls: {} });
    expect(redisTlsOptions('redis://localhost:6380')).toEqual({});
  });
});

describe('deterministic job ids', () => {
  it('scope match syncs by request so a narrow sync never swallows a full-season sync', () => {
    const at = new Date('2026-11-11T10:00:00Z');
    const one = jobIds.syncMatches('statsbomb', '43', '106', at, 'true|3869685');
    const all = jobIds.syncMatches('statsbomb', '43', '106', at, 'true|');
    expect(one).not.toBe(all);
    expect(jobIds.syncMatches('statsbomb', '43', '106', at, 'true|3869685')).toBe(one);
    expect(one).not.toContain(':');
  });
});

describe('Netlify / Lambda safety', () => {
  it('never uses Lambda execution credentials (AWS_* vars) as the Neon storage credential', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'api';
    try {
      expect(() => loadConfig({ ...base, STORAGE_DRIVER: 'neon', AWS_ENDPOINT_URL_S3: 'https://x.neon.tech', AWS_ACCESS_KEY_ID: 'ASIA-lambda', AWS_SECRET_ACCESS_KEY: 'lambda' })).toThrow(/AWS_ACCESS_KEY_ID|credential/);
      const c = loadConfig({ ...base, STORAGE_DRIVER: 'neon', S3_ENDPOINT: 'https://x.neon.tech', S3_ACCESS_KEY_ID: 'neon', S3_SECRET_ACCESS_KEY: 'secret', AWS_ACCESS_KEY_ID: 'ASIA-lambda', AWS_REGION: 'us-east-1', S3_REGION_OVERRIDE: 'ap-southeast-1' });
      expect(resolveS3Settings(c)).toMatchObject({ accessKeyId: 'neon', region: 'ap-southeast-1' });
    } finally {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    }
  });
});

describe('Clerk key sanity', () => {
  it('rejects swapped Clerk keys', () => {
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: 'fs', CLERK_SECRET_KEY: 'pk_live_x', CLERK_PUBLISHABLE_KEY: 'sk_live_x' })).toThrow(/swapped/);
  });
});
