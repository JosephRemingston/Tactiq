# Data model

Shared football data and user-private data live in separate tables. Users follow real-world entities; they
never own or copy them.

## Shared football data (read-only to users)

| Table | Purpose |
|---|---|
| `competitions`, `seasons`, `teams`, `players`, `player_team_assignments` | Canonical football entities |
| `matches`, `match_participants`, `lineups` | Fixtures, sides, formations, lineups |
| `match_coverage` | What exists per match: lineups, events, freeze frames, tracking (false), video (false), data quality |
| `events` | One row per provider event; canonical metres on 105 x 68, acting team attacking +x; raw coordinates kept |
| `event_freeze_frames` | StatsBomb 360 frames, where available |
| `provider_entity_maps` | Provider id to Touchline id, unique per (provider, entity type, provider id) |
| `raw_payloads` | Index of raw provider files kept in object storage (hash, ETag, licence, retrieval time) |
| `metric_definitions`, `tactical_concepts` | Versioned metric definitions with caveats; the glossary |
| `analysis_runs`, `tactical_metrics`, `match_possessions` | Analytics output per run (behind `AnalyticsRepository`) |
| `insights`, `match_stories`, `team_season_styles` | Insight cards, match story, season style |
| `ingestion_jobs` | Durable job state mirrored from BullMQ (status, attempts, errors, progress, trace) |

## User-private data

| Table | Purpose |
|---|---|
| `users`, `user_identities` | Local user mapped from the Clerk user id |
| `followed_teams`, `followed_competitions`, `followed_players` | Following |
| `saved_matches`, `saved_insights`, `user_notes`, `user_collections`, `user_collection_items`, `learning_progress` | Personal items |
| `plan_definitions`, `subscriptions`, `entitlements`, `entitlement_usage`, `entitlement_usage_events`, `entitlement_audit` | Entitlement engine |
| `security_events` | Account, session, webhook and entitlement changes |

Every private query filters by the user id taken from the verified session. A resource owned by someone else
returns 404, the same as a missing one.

## Coordinates

StatsBomb's 120 x 80 grid is not proportional to a real pitch. Normalization v1 maps StatsBomb landmarks
(six-yard box, penalty spot, penalty box, halfway; box, six-yard and post widths) piecewise-linearly onto a
105 x 68 m pitch, so the penalty box lines up exactly after conversion (`src/lib/pitch.ts`).
