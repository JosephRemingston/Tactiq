import { createHash } from 'node:crypto';
import type { FetchOptions, PayloadKind, ProviderAdapter, ProviderCapabilities, RawPayload } from '../provider';
import { STATSBOMB_SCHEMA_VERSION, StatsBombNormalizer } from './normalizer';
import type { Transport } from './transport';

export const STATSBOMB_LICENCE_ID = 'statsbomb-open-data';

/** StatsBomb Open Data adapter. Non-commercial licence: development, testing and validation only. */
export class StatsBombOpenDataAdapter implements ProviderAdapter {
  readonly provider = 'statsbomb' as const;
  readonly normalizer = new StatsBombNormalizer();

  constructor(private readonly transport: Transport) {}

  capabilities(): ProviderCapabilities {
    return {
      lineups: true,
      events: true,
      freezeFrames: 'partial',
      tracking: false,
      video: false,
      xg: 'provider',
      live: false,
      coordinateSystem: { length: 120, width: 80, perTeamNormalized: true },
      licenceId: STATSBOMB_LICENCE_ID,
    };
  }

  private async fetch(kind: PayloadKind, path: string, scopeKey: string, opts?: FetchOptions): Promise<RawPayload | null> {
    const res = await this.transport.get(path, opts?.etag);
    if (res.status === 404) return null;
    const bytes = res.bytes ?? Buffer.alloc(0);
    return {
      provider: this.provider,
      kind,
      scopeKey,
      bytes,
      sha256: res.status === 304 ? '' : createHash('sha256').update(bytes).digest('hex'),
      sourceUrl: res.url,
      etag: res.etag,
      retrievedAt: new Date(),
      schemaVersion: STATSBOMB_SCHEMA_VERSION,
      licenceId: STATSBOMB_LICENCE_ID,
      notModified: res.status === 304,
    };
  }

  private async required(kind: PayloadKind, path: string, scopeKey: string, opts?: FetchOptions): Promise<RawPayload> {
    const payload = await this.fetch(kind, path, scopeKey, opts);
    if (!payload) throw new Error(`StatsBomb ${kind} not found at ${path}`);
    return payload;
  }

  listCompetitions(opts?: FetchOptions) {
    return this.required('competitions', 'competitions.json', 'all', opts);
  }
  listMatches(ref: { providerCompetitionId: string; providerSeasonId: string }, opts?: FetchOptions) {
    return this.required('matches', `matches/${ref.providerCompetitionId}/${ref.providerSeasonId}.json`, `${ref.providerCompetitionId}/${ref.providerSeasonId}`, opts);
  }
  getLineups(id: string, opts?: FetchOptions) {
    return this.required('lineups', `lineups/${id}.json`, id, opts);
  }
  getEvents(id: string, opts?: FetchOptions) {
    return this.required('events', `events/${id}.json`, id, opts);
  }
  getFreezeFrames(id: string, opts?: FetchOptions) {
    return this.fetch('three_sixty', `three-sixty/${id}.json`, id, opts);
  }
}
