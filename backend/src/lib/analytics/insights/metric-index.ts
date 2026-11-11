import type { Scope } from '../types';
import type { StoredMetric } from './types';

/** Fast lookup of stored metrics by (key, team, scope, player). */
export class MetricIndex {
  private readonly map = new Map<string, StoredMetric>();
  constructor(readonly metrics: StoredMetric[]) {
    for (const m of metrics) this.map.set(this.k(m.metricKey, m.teamId, m.scope, m.playerId), m);
  }
  private k(key: string, teamId: string | null, scope: Scope, playerId: string | null) {
    return `${key}|${teamId ?? ''}|${scope}|${playerId ?? ''}`;
  }
  get(key: string, teamId: string | null, scope: Scope = 'full', playerId: string | null = null): StoredMetric | undefined {
    return this.map.get(this.k(key, teamId, scope, playerId));
  }
  value(key: string, teamId: string | null, scope: Scope = 'full', playerId: string | null = null): number | null {
    return this.get(key, teamId, scope, playerId)?.value ?? null;
  }
  json<T>(key: string, teamId: string | null, scope: Scope = 'full', playerId: string | null = null): T | null {
    return (this.get(key, teamId, scope, playerId)?.valueJson as T | undefined) ?? null;
  }
  players(key: string, teamId: string): StoredMetric[] {
    return this.metrics.filter((m) => m.metricKey === key && m.teamId === teamId && m.playerId !== null && m.scope === 'full');
  }
  ref(key: string, teamId: string | null, scope: Scope = 'full', playerId: string | null = null) {
    const m = this.get(key, teamId, scope, playerId);
    return { key, version: m?.metricVersion ?? 1, scope, value: m?.value ?? null, teamId };
  }
}
