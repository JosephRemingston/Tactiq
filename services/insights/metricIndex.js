/** Fast lookup of stored metrics by (key, team, scope, player). */
export class MetricIndex {
  constructor(metrics) {
    this.metrics = metrics;
    this.map = new Map();
    for (const m of metrics) this.map.set(this.k(m.metricKey, m.teamId, m.scope, m.playerId), m);
  }
  k(key, teamId, scope, playerId) {
    return `${key}|${teamId ?? ""}|${scope}|${playerId ?? ""}`;
  }
  get(key, teamId, scope = "full", playerId = null) {
    return this.map.get(this.k(key, teamId, scope, playerId));
  }
  value(key, teamId, scope = "full", playerId = null) {
    return this.get(key, teamId, scope, playerId)?.value ?? null;
  }
  json(key, teamId, scope = "full", playerId = null) {
    return this.get(key, teamId, scope, playerId)?.valueJson ?? null;
  }
  players(key, teamId) {
    return this.metrics.filter((m) => m.metricKey === key && m.teamId === teamId && m.playerId !== null && m.scope === "full");
  }
  ref(key, teamId, scope = "full", playerId = null) {
    const m = this.get(key, teamId, scope, playerId);
    return { key, version: m?.metricVersion ?? 1, scope, value: m?.value ?? null, teamId };
  }
}
