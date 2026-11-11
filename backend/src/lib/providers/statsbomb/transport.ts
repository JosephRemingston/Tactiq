import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface TransportResponse {
  status: 200 | 304 | 404;
  bytes: Buffer | null;
  etag: string | null;
  url: string;
}

export interface Transport {
  get(path: string, etag?: string | null): Promise<TransportResponse>;
}

export class TransportError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/** GitHub raw transport. Sends If-None-Match so unchanged files cost a 304. */
export class HttpTransport implements Transport {
  constructor(
    private readonly baseUrl: string,
    private readonly userAgent: string,
    private readonly acquire: () => Promise<void>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get(path: string, etag?: string | null): Promise<TransportResponse> {
    await this.acquire();
    const url = `${this.baseUrl.replace(/\/$/, '')}/${path}`;
    const res = await this.fetchImpl(url, { headers: { 'user-agent': this.userAgent, ...(etag ? { 'if-none-match': etag } : {}) }, signal: AbortSignal.timeout(60_000) });
    if (res.status === 304) return { status: 304, bytes: null, etag, url } as TransportResponse;
    if (res.status === 404) return { status: 404, bytes: null, etag: null, url };
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new TransportError(`GET ${url} -> ${res.status}`, res.status, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null);
    }
    return { status: 200, bytes: Buffer.from(await res.arrayBuffer()), etag: res.headers.get('etag'), url };
  }
}

/** Reads a local clone of the open-data repo (or the committed test fixtures). ETag = content hash. */
export class LocalDirTransport implements Transport {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  async get(path: string, etag?: string | null): Promise<TransportResponse> {
    const file = resolve(join(this.root, path));
    if (!file.startsWith(this.root)) throw new TransportError(`path escapes root: ${path}`, 400);
    const url = `file://${file}`;
    try {
      const bytes = await readFile(file);
      const tag = `"${createHash('sha1').update(bytes).digest('hex')}"`;
      if (etag && etag === tag) return { status: 304, bytes: null, etag, url };
      return { status: 200, bytes, etag: tag, url };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 404, bytes: null, etag: null, url };
      throw err;
    }
  }
}
