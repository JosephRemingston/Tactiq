import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { rawPayloads } from '../../db/schema';
import { DB } from '../../infra/database/database.module';
import { OBJECT_STORAGE, type ObjectStorage } from '../../infra/storage/object-storage';
import type { PayloadKind, ProviderKey, RawPayload } from '../../lib/providers/provider';

export interface StoredPayload {
  changed: boolean;
  objectKey: string;
  sha256: string;
}

/** Raw provider payloads go to object storage first (licence permitting), so normalization can be replayed without refetching. */
@Injectable()
export class RawPayloadStore {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async latest(provider: ProviderKey, kind: PayloadKind, scopeKey: string) {
    const [row] = await this.db
      .select()
      .from(rawPayloads)
      .where(and(eq(rawPayloads.provider, provider), eq(rawPayloads.payloadKind, kind), eq(rawPayloads.scopeKey, scopeKey), eq(rawPayloads.isLatest, true)))
      .orderBy(desc(rawPayloads.retrievedAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * ETag to send for a conditional fetch, only if the stored object is still readable
   * (e.g. after switching STORAGE_DRIVER the registry may point at objects in the old store).
   */
  async usableEtag(provider: ProviderKey, kind: PayloadKind, scopeKey: string): Promise<string | null> {
    const latest = await this.latest(provider, kind, scopeKey);
    if (!latest?.etag) return null;
    return (await this.storage.exists(latest.objectKey)) ? latest.etag : null;
  }

  /** Stores the payload unless its content hash equals the latest one. A 304 maps to the latest stored object. */
  async store(payload: RawPayload): Promise<StoredPayload> {
    const latest = await this.latest(payload.provider, payload.kind, payload.scopeKey);
    if (payload.notModified) {
      if (!latest || !(await this.storage.exists(latest.objectKey))) throw new Error(`provider returned 304 for ${payload.kind}/${payload.scopeKey} but the stored copy is missing; refetch without an ETag`);
      return { changed: false, objectKey: latest.objectKey, sha256: latest.sha256 };
    }
    if (latest && latest.sha256 === payload.sha256) {
      // Same content: restore the object if the store lost it (driver switch, retention cleanup).
      if (!(await this.storage.exists(latest.objectKey))) await this.storage.put(latest.objectKey, payload.bytes, 'application/json');
      return { changed: false, objectKey: latest.objectKey, sha256: latest.sha256 };
    }

    const stamp = payload.retrievedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const objectKey = `raw/${payload.provider}/${payload.kind}/${payload.scopeKey}/${stamp}-${payload.sha256.slice(0, 12)}.json`;
    await this.storage.put(objectKey, payload.bytes, 'application/json');
    await this.db.transaction(async (tx) => {
      await tx
        .update(rawPayloads)
        .set({ isLatest: false })
        .where(and(eq(rawPayloads.provider, payload.provider), eq(rawPayloads.payloadKind, payload.kind), eq(rawPayloads.scopeKey, payload.scopeKey), eq(rawPayloads.isLatest, true)));
      await tx
        .insert(rawPayloads)
        .values({
          provider: payload.provider,
          payloadKind: payload.kind,
          scopeKey: payload.scopeKey,
          objectKey,
          sha256: payload.sha256,
          byteSize: payload.bytes.length,
          etag: payload.etag,
          sourceUrl: payload.sourceUrl,
          retrievedAt: payload.retrievedAt,
          schemaVersion: payload.schemaVersion,
          licenceId: payload.licenceId,
          isLatest: true,
        })
        .onConflictDoUpdate({
          target: [rawPayloads.provider, rawPayloads.payloadKind, rawPayloads.scopeKey, rawPayloads.sha256],
          set: { isLatest: true, retrievedAt: payload.retrievedAt },
        });
    });
    return { changed: true, objectKey, sha256: payload.sha256 };
  }

  async readJson(objectKey: string): Promise<unknown> {
    return JSON.parse((await this.storage.get(objectKey)).toString('utf8')) as unknown;
  }
}
