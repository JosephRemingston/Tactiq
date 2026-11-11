# Metrics and insights

All metric definitions (formula, Quick / Explore / Advanced wording, coverage label, provider caveats) are seeded
from `backend/data/metric_definitions.json` and served at `GET /v1/metric-definitions`. Every stored value carries
evidence: up to 200 event ids plus the true count, or a query that re-derives the event set.

## Coverage labels

- **observed**: counted directly from provider events (shots, goals, formations, pressures).
- **calculated**: deterministic Touchline formulas over events (PPDA, progressive actions, possession share).
- **inferred**: model estimates (provider xG, expected threat, role profiles).

Tracking-only metrics (team width, compactness, defensive line height) are defined with status `planned` and are
reported as unavailable until a tracking feed exists.

## Touchline v1 definitions worth knowing

- **Progressive pass/carry**: completed open-play action reducing distance to goal by at least 30 m (own half),
  15 m (own half into opponent half) or 10 m (within opponent half).
- **PPDA**: opponent open-play passes in their own 60% divided by our tackles, interceptions and fouls in that zone.
  Pressures are excluded; `pressing.ppda_incl_pressures` adds them.
- **High turnover**: open-play possession starting within 40 m of the opponent goal.
- **xT**: static 12 x 8 grid by Karun Singh (`data/xt_grid_karun_singh_12x8_v1.json`), not fitted on our data.
- **Role profile**: per-90 feature vector z-scored against 1,569 World Cup 2022 player-matches, nearest of 14
  archetypes within the player's position family.

## Insight engine

Eleven deterministic rules (`src/lib/analytics/insights/generators.ts`) produce candidate cards. Each is scored by
salience x coverage weight x sample sufficiency. The match story takes the top three from distinct families and
includes both teams when both qualify. Matches without event data get a recap and a statement of what cannot be
assessed; partial coverage drops model-based cards and marks the rest low confidence.
