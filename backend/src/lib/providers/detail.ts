import { uuidv5 } from '../../common/ids';

/** Deterministic Touchline event id for a provider event. */
export const eventUuid = (provider: string, providerEventId: string) => uuidv5(`${provider}:event:${providerEventId}`);

/**
 * Normalizers emit provider ids in `...ProviderPlayerId` / `...ProviderEventId` / `providerPlayerId` keys.
 * This rewrites them (recursively through arrays) to `...PlayerId` / `...EventId` / `playerId` using the given maps.
 */
export function rewriteDetail(detail: Record<string, unknown>, player: (providerId: string) => string | null, provider: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (k.endsWith('ProviderPlayerId')) out[k.replace('ProviderPlayerId', 'PlayerId')] = typeof v === 'string' ? player(v) : null;
    else if (k.endsWith('ProviderEventId')) out[k.replace('ProviderEventId', 'EventId')] = typeof v === 'string' ? eventUuid(provider, v) : null;
    else if (k === 'providerPlayerId') out.playerId = typeof v === 'string' ? player(v) : null;
    else if (Array.isArray(v)) out[k] = v.map((item) => (item && typeof item === 'object' && !Array.isArray(item) ? rewriteDetail(item as Record<string, unknown>, player, provider) : item));
    else out[k] = v;
  }
  return out;
}
