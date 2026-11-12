# Touchline API reference (for building the Android app)

This document is the contract between the Touchline backend and the Android app. It is written for an engineer or AI agent building the frontend, and is self-contained: every route, request, response shape, error and rule the app needs is here. Response examples are real responses from the running API, shortened where arrays are long (`"… 20 more"` marks a cut).

- **App:** Touchline, a fan-first football tactical intelligence app. Fans follow clubs, competitions and players, open a match, and get a plain-language explanation first ("Quick"), with deeper views ("Explore", "Advanced") on demand.
- **Client stack assumed:** Kotlin, Jetpack Compose, Clerk Android SDK for sign-in, Google Play Billing for subscriptions, Google AdMob + UMP for ads.
- **Base URL:** `https://tactiq.josephremingston.dev`
- **Format:** JSON over HTTPS. Request bodies are `application/json`. All timestamps are ISO 8601 UTC strings. All ids are UUID strings unless stated otherwise.

---

## 1. Rules the client must follow

1. **Never trust local state for access.** The server enforces sign-in, ownership and the Free/Pro paywall. The app shows locks and counters from `GET /v1/entitlements`, but must still handle 401/403 on every call.
2. **Send the Clerk session token on every call when signed in:** `Authorization: Bearer <token>`. Get it from the Clerk Android SDK (`session.getToken()`), which refreshes it. Tokens are short-lived (about 60 s); fetch a fresh one per request or on 401.
3. **A bad token is always 401**, even on public routes. On 401 with a token: refresh the token and retry once; if it still fails, sign the user out.
4. **Read everything from `data`.** Every response, success or error, has the envelope in section 2.
5. **Show coverage honestly.** Matches carry a `coverage.level`. Only offer analysis views for matches where `analysisStatus == "complete"`. Never imply tracking or video exists (both are always `false` today).
6. **Respect `adFreeScreens`** from `GET /v1/ads/config` and never show ads to users where `enabled` is `false`.

---

## 2. Response envelope and errors

Every response:

```json
{ "statusCode": 200, "message": "Matches retrieved successfully", "data": { } }
```

- Success: `statusCode` 200, 201 (created) or 202 (accepted). The payload is in `data`, always an object. Lists are under a named key (`data.matches`, `data.teams`, …), never a bare array.
- Error: same envelope, `data.code` is a machine code, `data.requestId` matches the `x-request-id` response header (show it in "report a problem" screens).

```json
{ "statusCode": 400, "message": "Request validation failed",
  "data": { "code": "VALIDATION_FAILED",
            "details": [{ "path": "matchId", "message": "Invalid UUID", "code": "invalid_format" }],
            "requestId": "01a1cee9-6a9b-7a6e-9cee-d20740adf064" } }
```

| HTTP | `data.code` | Meaning | What the app does |
|---|---|---|---|
| 400 | `VALIDATION_FAILED` | Bad parameter or body; `details[]` lists fields | Fix input; show field errors |
| 401 | `UNAUTHENTICATED` | No token, or invalid/expired token | Refresh token and retry once, else go to sign-in |
| 403 | `ENTITLEMENT_REQUIRED` | Feature not in the user's plan (paywall) | Show the paywall (section 7) |
| 403 | `ENTITLEMENT_EXCEEDED` | Plan limit used up this period (paywall) | Show the paywall with the reset date |
| 403 | `PURCHASE_ACCOUNT_MISMATCH` | Purchase made for another account | Explain; do not retry |
| 403 | `FORBIDDEN` | Not allowed | Show error |
| 404 | `NOT_FOUND` | Missing, or belongs to another user | Show "not found" |
| 409 | `CONFLICT` | e.g. match has no event data; purchase linked to another account | Show the message |
| 413 | `VALIDATION_FAILED` | Body over 256 KB | — |
| 429 | `RATE_LIMITED` | Too many requests; `retry-after` header (seconds) | Back off for that many seconds |
| 500 | `INTERNAL` | Server error | Generic error + retry |
| 503 | `BILLING_NOT_CONFIGURED` / `PROVIDER_UNAVAILABLE` | Billing not live yet / upstream down | Hide purchase UI / retry later |

Useful response headers: `x-request-id`, `x-entitlement-remaining` (units left this period on metered routes), `retry-after` (on 429 and 202).

---

## 3. Conventions

### Pagination (cursor based)

List routes that page take `limit` and `cursor` query parameters and return:

```json
"page": { "nextCursor": "WyJBdXN0cmFsaWEiLCIwMWEx…", "limit": 25 }
```

Pass `nextCursor` back as `cursor` to get the next page. `nextCursor: null` means the end. Cursors are opaque; do not parse them.

### Explanation depth

`depth` is `quick` | `explore` | `advanced` (the user's default is `user.depthPreference`; they can switch per screen).

- `quick`: one plain sentence, no jargon.
- `explore`: what happened and why it matters, with numbers.
- `advanced`: metric definition, version and data caveats.

### Coverage

Every match has `coverage.level`:

| `level` | Meaning | Analysis views available? |
|---|---|---|
| `fixtures_only` | Score and date only | No |
| `events` | Full event data | Yes (once analysed) |
| `events_and_freeze_frames` | Events + player positions at key moments | Yes (once analysed) |

`analysisStatus`: `none` (not analysed), `queued`, `running`, `complete`, `failed`. Analysis views (section 6.4) need `complete`.

Every metric and insight has a `coverageLabel`:

- `observed`: counted directly from events (e.g. shots).
- `calculated`: computed from events with a formula (e.g. PPDA).
- `inferred`: a model or interpretation (e.g. player role).

Show this label (e.g. a small badge) so fans can tell facts from interpretation.

### Pitch coordinates

All `x`/`y` values are metres on a 105 × 68 pitch. `x` runs from the acting team's own goal line (0) to the opponent's (105), so **every team attacks left to right**. `y` runs from 0 to 68 across the pitch. Draw pitch overlays in this frame.

### Enums used in requests

| Name | Values |
|---|---|
| `depth` | `quick`, `explore`, `advanced` |
| follow `kind` | `teams`, `competitions`, `players` |
| note `subjectType` | `match`, `team`, `player`, `insight` |
| collection `itemType` | `match`, `insight`, `player`, `team`, `note` |
| learning `status` | `viewed`, `saved`, `completed` |
| `interests` | `match_explanations`, `tactics`, `players`, `learning`, `detailed_stats` (max 5) |
| metrics `scope` | `full`, `1H`, `2H`, `ET`, `leading`, `drawing`, `trailing` |
| tactical-shape `scope` | `full`, `1H`, `2H` |
| possession `endType` | `shot`, `goal`, `turnover`, `out`, `foul`, `half_end`, `other` |
| search `types` | `team`, `competition`, `player`, `concept` (comma-separated) |
| match `status` filter | `scheduled`, `played` |

---

## 4. Authentication flow

1. The app signs the user in with the **Clerk Android SDK** (Google sign-in, passkey or email).
2. For every API call, get the session token from Clerk and send `Authorization: Bearer <token>`.
3. The **first** authenticated call creates the user's Touchline account automatically (no sign-up endpoint). Call `GET /v1/me` right after sign-in.
4. Sign-out is handled by Clerk on the device; there is no logout endpoint. To end sessions on other devices use `GET /v1/me/sessions` and `DELETE /v1/me/sessions/{sessionId}`.

Access levels used below:

- **Public:** works without a token. If a valid token is sent, the response may be personalised (ads, paywall).
- **User:** a valid token is required, else 401.
- **User, metered:** a valid token is required and the call counts against a plan limit (section 7).

---

## 5. Endpoint index

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/healthz` | Public | Liveness |
| GET | `/readyz` | Public | Dependencies up |
| GET | `/v1/competitions` | Public | List competitions |
| GET | `/v1/competitions/{id}` | Public | Competition with seasons and coverage |
| GET | `/v1/competitions/{id}/seasons` | Public | Seasons of a competition |
| GET | `/v1/teams` | Public | List/search teams (paged) |
| GET | `/v1/teams/{id}` | Public | Club page header |
| GET | `/v1/teams/{id}/players` | Public | Squad |
| GET | `/v1/teams/{id}/coverage` | Public | Which data exists per season |
| GET | `/v1/teams/{id}/style` | Public | Team tactical identity |
| GET | `/v1/players/{id}` | Public | Player profile |
| GET | `/v1/players/{id}/matches` | Public | Player's matches (paged) |
| GET | `/v1/search` | Public | Search everything |
| GET | `/v1/matches` | Public | List matches (paged, filters) |
| GET | `/v1/matches/{matchId}` | Public | Match centre header |
| GET | `/v1/matches/{matchId}/lineups` | Public | Lineups |
| GET | `/v1/matches/{matchId}/events` | Public (filters: Pro) | Timeline (paged) |
| GET | `/v1/matches/{matchId}/insights` | Public | Insight cards |
| GET | `/v1/matches/{matchId}/story` | Public | Match story |
| GET | `/v1/concepts` | Public | Tactical glossary |
| GET | `/v1/concepts/{key}` | Public | One glossary concept |
| GET | `/v1/metric-definitions` | Public | Metric definitions |
| GET | `/v1/metric-definitions/{key}` | Public | One metric definition |
| GET | `/v1/matches/{matchId}/metrics` | User, metered | All metrics for a match |
| GET | `/v1/matches/{matchId}/tactical-shape` | User, metered | Formations, passing networks |
| GET | `/v1/matches/{matchId}/pressing` | User, metered | Pressing view |
| GET | `/v1/matches/{matchId}/transitions` | User, metered | Transitions view |
| GET | `/v1/matches/{matchId}/possessions` | User, metered (filters: Pro) | Possession chains (paged) |
| GET | `/v1/matches/{matchId}/players/{playerId}` | User, metered | Player in this match + role |
| GET | `/v1/matches/compare` | User, metered | Compare two matches |
| POST | `/v1/matches/{matchId}/analysis-jobs` | User, metered | Request (re)analysis |
| GET | `/v1/jobs/{jobId}` | Public | Job status |
| GET | `/v1/me` | User | Profile |
| PATCH | `/v1/me` | User | Update profile and preferences |
| DELETE | `/v1/me` | User | Delete account |
| GET | `/v1/me/sessions` | User | Signed-in devices |
| DELETE | `/v1/me/sessions/{sessionId}` | User | Sign out a device |
| GET | `/v1/me/feed` | User | Personalised home feed |
| GET | `/v1/me/following` | User | Followed teams/competitions/players |
| PUT / DELETE | `/v1/me/following/{kind}/{id}` | User | Follow / unfollow |
| GET | `/v1/me/saved-matches` | User | Saved matches (paged) |
| PUT / DELETE | `/v1/me/saved-matches/{matchId}` | User | Save / unsave match |
| GET | `/v1/me/saved-insights` | User | Saved insights (paged) |
| PUT / DELETE | `/v1/me/saved-insights/{insightId}` | User | Save / unsave insight |
| GET / POST | `/v1/me/notes` | User | List / create notes |
| GET / PATCH / DELETE | `/v1/me/notes/{id}` | User | One note |
| GET / POST | `/v1/me/collections` | User | List / create collections |
| GET / PATCH / DELETE | `/v1/me/collections/{id}` | User | One collection |
| PUT | `/v1/me/collections/{id}/items` | User | Add item |
| DELETE | `/v1/me/collections/{id}/items/{itemType}/{itemId}` | User | Remove item |
| GET | `/v1/me/learning` | User | Learning progress |
| PUT | `/v1/me/learning/{conceptKey}` | User | Mark concept viewed/saved/completed |
| GET | `/v1/entitlements` | User | Plan, limits and usage |
| GET | `/v1/billing/products` | Public | Plans and paywall comparison |
| GET | `/v1/billing/subscription` | User | Current subscription |
| POST | `/v1/billing/google-play/verify` | User | Verify a Play purchase |
| POST | `/v1/billing/restore` | User | Restore purchases |
| GET | `/v1/ads/config` | Public | Ad placements for this user |

---

## 6. Endpoints

### 6.1 Health

`GET /healthz` → `data: { "status": "UP", "timestamp": "…", "uptime": 0.47 }`
`GET /readyz` → `data: { "status": "ok", "checks": { "database": "ok", "redis": "ok", "storage": "ok" } }` (503 when degraded). Not needed by the app beyond diagnostics.

### 6.2 Discovery (public)

#### `GET /v1/competitions`
Query: `q` (optional, max 80 chars, name filter).

```json
{ "competitions": [
  { "id": "01a1cec4-…", "name": "FIFA World Cup", "countryName": "International", "gender": "male",
    "isInternational": true,
    "seasons": [ { "id": "01a1cec4-…", "name": "2022" }, { "id": "01a1cec4-…", "name": "2018" } ] } ] }
```

#### `GET /v1/competitions/{id}`
```json
{ "competition": { "id": "…", "name": "1. Bundesliga", "countryName": "Germany", "gender": "male", "isInternational": false,
  "seasons": [ { "id": "…", "name": "2023/2024", "coverage": { "matches": 0, "withEvents": 0, "analysed": 0 } } ] } }
```
Use `seasons[].coverage` to show which seasons have analysis.

#### `GET /v1/competitions/{id}/seasons`
`{ "seasons": [ { "id", "name", "coverage": { "matches", "withEvents", "analysed" } } ] }`

#### `GET /v1/teams`
Query: `competitionId`, `seasonId`, `q` (min 1, max 80), `limit` (1–100, default 50), `cursor`.
```json
{ "teams": [ { "id": "…", "name": "Argentina", "countryName": "Argentina", "isNationalTeam": true } ],
  "page": { "nextCursor": "…", "limit": 50 } }
```

#### `GET /v1/teams/{id}`
```json
{ "team": { "id": "…", "name": "Argentina", "countryName": "Argentina", "isNationalTeam": true, "gender": "male",
  "seasons": [ { "seasonId": "…", "seasonName": "2022", "competitionId": "…", "competitionName": "FIFA World Cup", "matches": 7 } ],
  "recentMatches": [ MatchSummary, … ] } }
```

#### `GET /v1/teams/{id}/players`
Query: `seasonId` (optional).
```json
{ "players": [ { "id": "…", "name": "Alexis Mac Allister", "knownName": "Alexis MacAllister", "countryName": "Argentina",
  "jerseyNumber": 20, "seasonId": "…", "positionGroup": "MID", "appearances": 1, "starts": 1 } ] }
```
`positionGroup`: `GK` | `DEF` | `MID` | `FWD` | `null`. Display `knownName ?? name`.

#### `GET /v1/teams/{id}/coverage`
```json
{ "teamId": "…", "seasons": [ { "seasonId": "…", "seasonName": "2022", "competitionName": "FIFA World Cup",
  "matches": { "fixtures": 7, "events": 1, "freezeFrames": 1, "tracking": 0, "video": 0, "analysed": 1 },
  "providers": ["statsbomb"] } ] }
```
Show this as the club page "data available" label.

#### `GET /v1/teams/{teamId}/style`
Query: `seasonId` (optional). Team tactical identity per season.
```json
{ "style": { "teamId": "…", "teamName": "Argentina",
  "data": [ { "seasonId": "…", "competitionId": "…", "matchesAnalysed": 1, "labels": [],
    "metrics": { "pressing.ppda": { "n": 1, "p25": 9.95, "p75": 9.95, "median": 9.95, "competitionPercentile": null }, … },
    "note": "Style labels need at least 5 analysed matches; 1 so far.", "computedAt": "…" } ] } }
```
`labels` are plain-language strings from this set: `presses high`, `sits deeper without the ball`, `builds patiently`, `plays directly`, `dominates the ball`, `comfortable without the ball`, `attacks quickly after regaining the ball`, `wins the ball back quickly after losing it`, `wins the ball high up the pitch`, `creates high-quality chances`. Empty until at least 5 analysed matches. Show `note` when `labels` is empty.

#### `GET /v1/players/{id}`
```json
{ "player": { "id": "…", "name": "Alejandro Darío Gómez", "knownName": "Papu Gómez", "countryName": "Argentina",
  "positionGroup": null, "positionName": null, "appearances": 1, "starts": 0,
  "teams": [ { "teamId": "…", "teamName": "Argentina", "seasonId": "…", "seasonName": "2022", "jerseyNumber": 17 } ] } }
```

#### `GET /v1/players/{id}/matches`
Query: `limit` (default 25), `cursor`. → `{ "matches": [MatchSummary], "page": {…} }`

#### `GET /v1/search`
Query: `q` (required, 2–80 chars), `types` (comma list, default all four), `limit` (1–25, default 8 per type).
```json
{ "competitions": [], "teams": [ { "id": "…", "name": "Argentina", "countryName": "Argentina", "isNationalTeam": true } ],
  "players": [ { "id", "name", "knownName", "countryName" } ],
  "concepts": [ { "key": "high-press", "name": "High press", "simpleText": "Trying to win the ball back near the opponent's goal." } ],
  "adSlots": [] }
```

### 6.3 Matches (public)

#### MatchSummary (used in every match list)
```json
{ "id": "01a1cec4-dae6-…", "kickoffAt": "2022-12-18T17:00:00.000Z", "status": "played", "stage": "Final",
  "competition": { "id": "…", "name": "FIFA World Cup" }, "season": { "id": "…", "name": "2022" },
  "home": { "id": "…", "name": "Argentina", "score": 3 }, "away": { "id": "…", "name": "France", "score": 3 },
  "analysisStatus": "complete",
  "coverage": { "hasEvents": true, "hasFreezeFrames": true, "hasTracking": false, "hasVideo": false, "level": "events_and_freeze_frames" } }
```
`status`: `scheduled` | `played` | `postponed` | `cancelled`. Scores are `null` before kick-off.

#### `GET /v1/matches`
Query: `competitionId`, `seasonId`, `teamId`, `from`, `to` (ISO dates), `status` (`scheduled`|`played`), `analysed` (`true`|`false`), `limit` (default 25), `cursor`. Newest first.
→ `{ "matches": [MatchSummary], "page": {…}, "adSlots": [AdSlot] }`

#### `GET /v1/matches/{matchId}` (match centre header)
```json
{ "match": { …MatchSummary fields…,
  "home": { "id": "…", "name": "Argentina", "score": 3, "formation": "4-3-3", "manager": "Lionel Sebastián Scaloni" },
  "away": { "id": "…", "name": "France", "score": 3, "formation": "4-2-3-1", "manager": "Didier Deschamps" },
  "coverage": { "level": "events_and_freeze_frames", "hasLineups": true, "hasEvents": true, "hasFreezeFrames": true,
    "hasTracking": false, "hasVideo": false, "eventsCount": 4407, "eventProvider": "statsbomb",
    "dataQuality": { "partial": false, "hasExtraTime": true, "hasShootout": true, "periodsPresent": [1,2,3,4,5],
      "missingLocationPct": 0, "eventsWithoutPlayer": 0, "xgSource": "provider:statsbomb", "unknownTypeNames": [], "notes": [] },
    "retrievedAt": "…", "unavailable": ["tracking", "team_shape", "off_ball_runs", "physical_load", "video"] },
  "matchWeek": 7, "stadiumName": "Lusail Stadium", "refereeName": "Szymon Marciniak",
  "pitch": { "lengthM": 105, "widthM": 68 },
  "analysis": { "status": "complete", "runId": "…", "analysedAt": "…", "analyticsVersion": 1 },
  "licence": { "id": "statsbomb-open-data", "name": "StatsBomb Open Data",
    "attribution": "Data: StatsBomb Open Data (Hudl StatsBomb)", "commercialUseAllowed": false } } }
```
Always show `licence.attribution` on match screens. Use `coverage.unavailable` to explain what cannot be shown.

#### `GET /v1/matches/{matchId}/lineups`
```json
{ "lineups": [ { "teamId": "…", "teamName": "Argentina",
  "starters": [ { "playerId": "…", "playerName": "Nicolás Alejandro Tagliafico", "knownName": "Nicolás Tagliafico",
    "jerseyNumber": 3, "positionName": "Left Back", "positionGroup": "DEF", "isStarter": true,
    "minuteOn": 0, "minuteOff": 120, "cards": [] } ],
  "substitutes": [ … same shape, minuteOn set if they came on … ] } ] }
```
`cards`: `[{ "minute": 37, "type": "Yellow Card", "reason": "…" }]`.

#### `GET /v1/matches/{matchId}/events` (timeline)
Query: `limit` (1–500, default 200), `cursor`. **Pro-only filters** (403 `ENTITLEMENT_REQUIRED` for Free, 401 for anonymous): `type` (comma list of event types), `teamId`, `playerId`, `period` (1–5), `possessionId`, `include=raw`.
```json
{ "events": [ { "id": "…", "sequenceIndex": 2, "period": 1, "minute": 0, "second": 0, "clockSeconds": 0,
  "type": "pass", "teamId": "…", "playerId": "…", "playerName": "…", "positionName": "Right Back",
  "possessionId": 1, "possessionTeamId": "…", "playPattern": "regular_play",
  "x": 52.5, "y": 34, "endX": 61.2, "endY": 50.1, "outcome": null,
  "underPressure": false, "counterpress": false, "duration": 1.2, "relatedEventIds": ["…"],
  "detail": { "recipientPlayerId": "…", "height": "ground_pass", "passType": null, "bodyPart": "right_foot",
              "cross": false, "switch": false, "throughBall": false, "cutBack": false,
              "shotAssist": false, "goalAssist": false, "assistedShotEventId": null } } ],
  "page": { "nextCursor": "…", "limit": 200 } }
```
Event `type` values: `pass`, `carry`, `ball_receipt`, `shot`, `pressure`, `duel`, `dribble`, `dribbled_past`, `interception`, `clearance`, `block`, `ball_recovery`, `dispossessed`, `miscontrol`, `error`, `shield`, `fifty_fifty`, `foul_committed`, `foul_won`, `offside`, `goalkeeper`, `own_goal_for`, `own_goal_against`, `substitution`, `tactical_shift`, `starting_xi`, `half_start`, `half_end`, `player_on`, `player_off`, `injury_stoppage`, `referee_ball_drop`, `bad_behaviour`.

- `outcome: null` on a pass means it was completed; otherwise e.g. `incomplete`, `out`. Shot outcomes: `goal`, `saved`, `off_t`, `blocked`, `wayward`, `post`, ….
- `detail` depends on `type`. Passes: shown above. Shots: `{ "xg": 0.0245, "xgModel": "statsbomb", "shotType": "open_play", "bodyPart": "right_foot", "technique": "normal", "firstTime": false, "endZ": 0.8, "keyPassEventId": "…", "freezeFrame": [ { "x", "y", "playerId", "teammate", "positionName" } ] }`. `starting_xi`/`tactical_shift`: `{ "formation": "4-3-3", "lineup": [ { "playerId", "jerseyNumber", "positionName" } ] }`.
- Use `relatedEventIds` to link a pass to its reception or a shot to its key pass.

#### `GET /v1/matches/{matchId}/insights`
Query: `depth` (default `quick`). Ranked insight cards (PDF "insight-card format").
```json
{ "insights": [ {
  "id": "…", "kind": "progression.central_access", "family": "progression", "rank": 1,
  "teamId": "…", "teamName": "Argentina", "playerId": null, "playerName": null,
  "headline": "Argentina kept finding players just outside the box",
  "whatHappened": "Argentina completed 21 passes into zone 14, the central area in front of the penalty box.",
  "whyItMatters": "A player receiving there can shoot, slip a through ball or combine, which forces defenders to step out of their line.",
  "explanation": "Argentina kept finding players just outside the box.",
  "depth": { "quick": "…", "explore": "…", "advanced": "…" },
  "evidence": { "metrics": [ { "key": "progression.zone14_receptions", "scope": "full", "value": 21, "teamId": "…", "version": 1 } ],
    "zones": ["zone_14"], "periods": [1,2], "eventIds": ["…"], "totalEvents": 21 },
  "confidence": "high", "coverageLabel": "calculated", "completeness": 1,
  "exploreLink": { "view": "progression", "matchId": "…", "teamId": "…", "scope": "2H", "metricKeys": ["progression.zone14_receptions"] } } ],
  "depth": "quick" }
```
- `explanation` is the text for the requested depth; `depth` has all three.
- `confidence`: `high` | `medium` | `low`.
- `exploreLink.view` tells the app which deep screen to open: `progression`, `pressing`, `shape`, `shot-map`, `player` (with `playerId`). It may carry `scope` (e.g. `2H`) and `metricKeys` to highlight. Opening it calls a metered route (section 6.4); the shot map is built from `/metrics?keys=shooting.shot_map`.
- `evidence.eventIds` can be highlighted on the timeline/pitch (fetch the events by page).

#### `GET /v1/matches/{matchId}/story`
Query: `depth`. The match story (PDF "match story layout").
```json
{ "story": { "matchId": "…", "status": "full", "depth": "explore",
  "shortVersion": "Argentina and France drew 3-3 after extra time; Argentina won 4-2 on penalties. Argentina kept finding players just outside the box.",
  "teamApproaches": [ { "teamId": "…", "teamName": "Argentina", "formation": "4-3-3",
    "summary": "Started in a 4-3-3, had 55% of the ball, defended in a mid-block (PPDA 9.9), progressed mostly down the left.",
    "labels": ["mid-block", "patient build-up", "left-sided"] } ],
  "keyPatterns": [ { "id": "…", "kind": "…", "teamId": "…", "playerId": null, "headline": "…", "explanation": "…",
    "confidence": "high", "coverageLabel": "calculated", "evidence": { … }, "exploreLink": { … } } ],
  "whatChanged": [ { "kind": "goal", "text": "Goal for Argentina (Lionel Messi)", "minute": 22 } ],
  "keyPlayers": [ { "playerId": "…", "playerName": "Lionel Messi", "teamId": "…", "role": "Advanced playmaker",
    "text": "Lionel Messi, playing as an advanced playmaker, added 0.41 expected threat with passes and carries, among the most in the match." } ],
  "evidenceLinks": ["progression.zone14_receptions", "possession.xt_added"],
  "coverageStatement": "Based on statsbomb event data (4,407 events, with freeze frames for selected moments). Tracking data is not available, so team shape, off-ball runs and physical load are not assessed.",
  "generatorVersion": 1, "generatedAt": "…" } }
```
`status`: `full` (complete story), `recap` (low coverage: basic recap only), `unavailable` (fixtures only), `pending_analysis` (events exist, not analysed yet; the object then has only `matchId`, `status`, `coverageStatement`). `evidence` is omitted at `quick` depth. `whatChanged[].kind`: `goal`, `substitution`, or an insight family (e.g. `halves`, `score_state`, `shape`) for tactical shifts. Always show `coverageStatement`.

### 6.4 Analysis views (signed in, metered)

These are the Explore/Advanced screens. Each call needs a token and is metered by `analysis.matches_per_month`: **opening any number of these views for the same match costs 1 unit per calendar month**. The response header `x-entitlement-remaining` shows units left (absent when unlimited). They also check `history.seasons_back` (Free: latest 2 seasons of a competition). Returns 409 if the match was never analysed.

Common fields in each view: `matchId`, `analysisRunId`, `analyticsVersion`, `analysedAt`.

**Metric object** (used everywhere):
```json
{ "key": "pressing.ppda", "version": 1, "scope": "full", "teamId": "…", "playerId": null,
  "value": 9.95, "valueJson": { "opponentPasses": 368, "defensiveActions": 37 },
  "sampleSize": 37, "minutes": 141.4, "coverageLabel": "calculated",
  "evidence": { "eventIds": ["…"], "totalEvents": 37, "note": "…", "query": { … } } }
```
Look up name, unit, direction and the three descriptions in `GET /v1/metric-definitions` (cache it; it changes rarely).

#### `GET /v1/matches/{matchId}/metrics`
Query: `scope`, `teamId`, `playerId` (UUID, or `none` for team-level only), `keys` (comma list, max 50), `include=definitions`.
→ `{ "metrics": [Metric], "matchId", "analysisRunId", "analyticsVersion", "analysedAt", "definitions": [ { "key", "version", "name", "unit", "direction", "descriptionQuick", "coverageLabel" } ] }`

#### `GET /v1/matches/{matchId}/tactical-shape`
Query: `scope` = `full` | `1H` | `2H`.
```json
{ "shape": { "scope": "full", "teams": [ {
  "teamId": "…", "startingFormation": "4-3-3",
  "formationTimeline": [ { "kind": "starting_formation", "minute": 0, "period": 1, "formation": "4-3-3", "eventId": "…" },
    { "kind": "substitution", "minute": 63, "period": 2, "reason": "tactical", "playerOn": "Marcos Acuña", "playerOff": "Ángel Di María", "playerOnId": "…", "playerOffId": "…", "eventId": "…" } ],
  "passingNetwork": {
    "nodes": [ { "playerId": "…", "name": "Rodrigo De Paul", "positionName": "Right Center Midfield", "x": 53.9, "y": 51.6, "passes": 68, "receptions": 66 } ],
    "edges": [ { "from": "<playerId>", "to": "<playerId>", "count": 15 } ],
    "untilFirstSub": { "minute": 63, "nodes": [ … ], "edges": [ … ] } },
  "averagePositions": [ …same as nodes… ] } ] } }
```
Draw nodes at average positions sized by `passes`; edges weighted by `count`. `untilFirstSub` is the cleaner "starting XI" network.

#### `GET /v1/matches/{matchId}/pressing`
```json
{ "pressing": { "teams": [ { "teamId": "…", "scopes": {
  "full": { "pressing.ppda": Metric-without-key, "pressing.ppda_incl_pressures": …, "pressing.pressures": …,
            "pressing.pressure_regains_5s": …, "pressing.high_turnovers": …, "pressing.shots_after_high_turnover": …,
            "pressing.defensive_action_height_m": … },
  "1H": { … }, "2H": { … } } } ] } }
```
Inner objects have `value`, `valueJson`, `sampleSize`, `coverageLabel`, `evidence` (the key is the map key). Scopes present depend on the match (`ET`, `leading`, `drawing`, `trailing` may appear).

#### `GET /v1/matches/{matchId}/transitions`
Same layout as pressing, with keys `transition.counterpress_regains` (`valueJson.windows` = `{ "3s", "5s", "8s" }`, `turnovers`), `transition.counterpress_regain_rate`, `transition.counter_shots`, `transition.regain_to_shot_seconds`.

#### `GET /v1/matches/{matchId}/possessions`
Query: `limit` (1–200, default 50), `cursor`. **Pro-only filters:** `teamId`, `endType`.
```json
{ "possessions": [ { "possessionId": 2, "teamId": "…", "period": 1, "startEventId": "…", "endEventId": "…",
  "startClock": 0.578, "endClock": 6.903, "startX": 53.36, "startY": 34.09, "endType": "turnover",
  "nEvents": 5, "nPasses": 2, "reachedFinalThird": true, "reachedBox": false, "xtNet": -0.0043, "xgTotal": 0,
  "playPattern": "from_kick_off" } ], "page": { … } }
```

#### `GET /v1/matches/{matchId}/players/{playerId}`
```json
{ "player": { "playerId": "…", "name": "Nicolás Tagliafico", "teamId": "…", "positionName": "Left Back",
  "positionGroup": "DEF", "isStarter": true, "minutes": 120,
  "role": { "role": "overlapping_fb", "roleLabel": "Overlapping full-back", "family": "FB", "similarity": 0.075,
    "secondRole": "inverted_fb", "secondRoleLabel": "Inverted full-back", "secondSimilarity": 0.049,
    "topFeatures": ["tackles_interceptions", "mean_abs_y", "pressures"],
    "features": { "passes": 42, "prog_passes": 3, "pressures": 14.25, … }, "z": { … }, "coverageLabel": "inferred" },
  "metrics": [Metric] } }
```
`role` is `null` for players under 30 minutes. `features` are per-90 values; `z` are z-scores vs a reference population (for radar charts).

#### `GET /v1/matches/compare`
Query: `a` (match id), `b` (match id), `teamId` (optional). Metered by `comparisons.per_month` (one unit per distinct pair + team per month).
```json
{ "comparison": { "keys": ["possession.share", "passing.pass_completion", "progression.progressive_passes", …],
  "matches": [ { "matchId": "…", "kickoffAt": "…", "home": { … }, "away": { … }, "competition": { … }, "coverage": "events_and_freeze_frames",
    "teams": [ { "teamId": "…", "metrics": { "possession.share": 54.9, "shooting.xg": 2.758, "pressing.ppda": 9.95, … } } ] } ] } }
```

#### `POST /v1/matches/{matchId}/analysis-jobs`
No body. Rate limited to 10/min per user. Returns **202**:
```json
{ "job": { "jobId": "analytics.….v1.38dff8cc9d", "type": "analyse_match", "status": "completed",
  "progress": { "pct": 100, "step": "done" }, "matchId": "…", "attempts": 1, "error": null,
  "createdAt": "…", "startedAt": "…", "finishedAt": "…", "existing": true } }
```
- `existing: true`: the match is already analysed or queued; nothing was charged.
- Otherwise a new job is queued and 1 unit of `analysis.rerun_per_month` is charged. **Jobs run on a schedule (up to ~1 hour)**, so tell the user "we'll have this ready soon", and poll `GET /v1/jobs/{jobId}` no more than every 60 s (`retry-after: 60`), or just refresh the match later.
- 409 if the match has no event data.

#### `GET /v1/jobs/{jobId}`
Public for match-analysis jobs; otherwise only the requester. → `{ "job": { …same shape… } }`. `status`: `queued`, `active`, `completed`, `failed` (will retry), `dead`, `skipped`.

### 6.5 Glossary and metric definitions (public)

#### `GET /v1/concepts` — Query: `category` (optional).
`{ "concepts": [ { "key": "ppda", "name": "PPDA", "category": "metric", "simpleText": "…" } ] }`

#### `GET /v1/concepts/{key}`
```json
{ "concept": { "key": "ppda", "name": "PPDA", "category": "metric",
  "simpleText": "Passes per defensive action: how many passes the opponent makes before you try to win the ball.",
  "exploreText": "Lower PPDA usually means more aggressive pressing.",
  "advancedText": "Touchline v1: opponent passes in their own 60% / tackles + interceptions + fouls in that area.",
  "misconceptions": "PPDA from different sites is directly comparable.",
  "relatedKeys": ["high-press"], "linkedMetricKeys": ["pressing.ppda", "pressing.ppda_incl_pressures"],
  "metrics": [ { "key": "pressing.ppda", "version": 1, "name": "PPDA", "descriptionQuick": "…", "status": "active" } ],
  "related": [ { "key": "high-press", "name": "High press" } ] } }
```
Use this for the "Explain this" tap on any tactical term.

#### `GET /v1/metric-definitions` — Query: `family` (`possession`, `passing`, `progression`, `buildup`, `pressing`, `transition`, `shooting`, `shape`, `player`).
#### `GET /v1/metric-definitions/{key}` — Query: `version` (optional).
```json
{ "metricDefinition": { "key": "pressing.ppda", "version": 1, "name": "PPDA", "family": "pressing",
  "unit": "passes per action", "direction": "lower_better",
  "descriptionQuick": "…", "descriptionExplore": "…", "descriptionAdvanced": "…",
  "formula": "opp_passes(own 60%) / def_actions(opp 60%)", "requires": { "events": true },
  "coverageLabel": "calculated", "providerCaveats": { "statsbomb": "…" }, "conceptKeys": ["ppda", "high-press"],
  "status": "active" } }
```
`direction`: `higher_better` | `lower_better` | `neutral` (for colouring). `status: planned` metrics need tracking data and have no values yet; hide them.

### 6.6 Profile and account (signed in)

#### `GET /v1/me`
```json
{ "user": { "id": "…", "email": "ada@example.com", "displayName": "Ada", "avatarUrl": null, "locale": "en",
  "depthPreference": "quick", "interests": [],
  "plan": { "key": "free", "source": "default", "currentPeriodEnd": null },
  "followingCounts": { "teams": 0, "competitions": 0, "players": 0 }, "createdAt": "…" } }
```
If all `followingCounts` are 0 after sign-in, show onboarding (pick clubs/competitions).

#### `PATCH /v1/me`
Body (all optional, unknown fields rejected): `displayName` (1–80), `locale` (`en` or `en-GB` style), `depthPreference`, `interests` (array, max 5).
→ `{ "user": { …same as GET… } }`

#### `DELETE /v1/me`
Deletes the account, private data and the Clerk identity. Confirm in the UI first. → `{ "deleted": true }`. Then sign out locally.

#### `GET /v1/me/sessions` → `{ "sessions": [ { "id", "status", "lastActiveAt", "expireAt", "clientId" } ] }`
#### `DELETE /v1/me/sessions/{sessionId}` → `{ "revoked": true }` (404 if not yours)

### 6.7 Personal data (signed in, owner only)

All of these act only on the signed-in user's data. Another user's ids return 404.

#### `GET /v1/me/feed` (home screen)
```json
{ "feed": { "empty": false,
  "recent": [MatchSummary], "upcoming": [MatchSummary],
  "insights": [ { "id", "matchId", "headline", "kind", "teamId", "rank", "exploreLink": { … } } ],
  "concepts": [ { "key": "zone-14", "name": "Zone 14", "simpleText": "The central area just outside the penalty box." } ] },
  "adSlots": [ { "placement": "home_feed_native", "after": "recent", "afterIndex": 3, "adUnitId": "ca-app-pub-…" } ] }
```
When the user follows nothing: `{ "empty": true, "nextStep": "Follow a club or competition to personalise your feed.", "recent": [], "upcoming": [], "insights": [], "concepts": [] }`. Insert a native ad **after** item `afterIndex` of the list named by `after`.

#### Following
- `GET /v1/me/following` → `{ "following": { "teams": [ { "id", "name", "countryName", "followedAt" } ], "competitions": [ … ], "players": [ … ] } }`
- `PUT /v1/me/following/{kind}/{id}` → `{ "teamId": "…", "following": true }` (key is `teamId` / `competitionId` / `playerId`)
- `DELETE /v1/me/following/{kind}/{id}` → `{ "…Id": "…", "following": false }`
Both are idempotent.

#### Saved matches
- `GET /v1/me/saved-matches?limit&cursor` → `{ "savedMatches": [ { "savedAt": "…", "match": MatchSummary } ], "page": {…} }`
- `PUT /v1/me/saved-matches/{matchId}` → `{ "matchId": "…", "saved": true }` — 403 `ENTITLEMENT_EXCEEDED` when the saved-items limit is reached (Free: 100 matches + insights combined).
- `DELETE /v1/me/saved-matches/{matchId}` → `{ "matchId": "…", "saved": false }`

#### Saved insights
- `GET /v1/me/saved-insights?limit&cursor` → `{ "savedInsights": [ { "id", "savedAt", "insightId", "matchId", "headline", "whatHappened", "kind", "teamId", "exploreLink" } ], "page": {…} }`
- `PUT /v1/me/saved-insights/{insightId}` → `{ "insightId": "…", "saved": true }` (same limit)
- `DELETE /v1/me/saved-insights/{insightId}` → `{ "insightId": "…", "saved": false }`

#### Notes
- `GET /v1/me/notes?subjectType&subjectId&limit&cursor` → `{ "notes": [Note], "page": {…} }`
- `POST /v1/me/notes` body `{ "subjectType": "match", "subjectId": "<uuid>", "body": "1–4000 chars" }` → **201** `{ "note": Note }`
- `GET /v1/me/notes/{id}` → `{ "note": Note }`
- `PATCH /v1/me/notes/{id}` body `{ "body": "…" }` → `{ "note": Note }`
- `DELETE /v1/me/notes/{id}` → `{ "id": "…", "deleted": true }`

`Note = { "id", "subjectType", "subjectId", "body", "createdAt", "updatedAt" }`

#### Collections
- `GET /v1/me/collections` → `{ "collections": [ { "id", "name", "description", "createdAt", "updatedAt", "items": 1 } ] }` (`items` is a count here)
- `POST /v1/me/collections` body `{ "name": "1–80", "description": "≤500, optional" }` → **201** `{ "collection": Collection }`
- `GET /v1/me/collections/{id}` → `{ "collection": Collection }`
- `PATCH /v1/me/collections/{id}` body `{ "name"?, "description"? (null clears) }` → `{ "collection": Collection }`
- `DELETE /v1/me/collections/{id}` → `{ "id": "…", "deleted": true }`
- `PUT /v1/me/collections/{id}/items` body `{ "itemType": "match", "itemId": "<uuid>", "position"?: 0 }` → `{ "collection": Collection }`
- `DELETE /v1/me/collections/{id}/items/{itemType}/{itemId}` → `{ "collection": Collection }`

`Collection = { "id", "name", "description", "createdAt", "updatedAt", "items": [ { "collectionId", "itemType", "itemId", "position", "addedAt" } ] }`. Items hold ids only; fetch the match/team/player/insight to display it.

#### Learning progress
- `GET /v1/me/learning` → `{ "learning": [ { "conceptKey": "ppda", "name": "PPDA", "status": "completed", "updatedAt": "…" } ] }`
- `PUT /v1/me/learning/{conceptKey}` body `{ "status": "viewed" | "saved" | "completed" }` → `{ "conceptKey": "ppda", "status": "completed" }`

---

## 7. Paywall (Free vs Pro)

There are two plans: **Free** and **Pro** (sold as `pro_monthly` and `pro_annual`, identical features). The app must never hard-code limits: read them from the API.

### What is gated

| Feature key | Free | Pro | Gated routes |
|---|---|---|---|
| (none) | ✓ | ✓ | Discovery, match centre, lineups, timeline, insights, story, glossary, team style, following, notes, collections, learning |
| `analysis.matches_per_month` | 20 / month | unlimited | Section 6.4 per-match views |
| `comparisons.per_month` | 5 / month | unlimited | `/matches/compare` |
| `analysis.rerun_per_month` | 3 / month | 30 / month | `POST /analysis-jobs` (only when new work is queued) |
| `analysis.advanced_filters` | no | yes | `events` filters, `possessions` filters |
| `history.seasons_back` | latest 2 seasons | all | Section 6.4 per-match views |
| `following.max_saved_items` | 100 | unlimited | Saving matches/insights |
| `ads.enabled` | ads shown | no ads | `/ads/config`, `adSlots` |
| `ai.credits_per_month`, `reports.exports_per_month`, `tracking.full_access` | — | — | Reserved for future features; ignore |

### `GET /v1/entitlements`
```json
{ "plan": { "key": "free", "source": "default", "currentPeriodEnd": null },
  "entitlements": [
    { "featureKey": "analysis.matches_per_month", "limitValue": 20, "usagePeriod": "month", "sourcePlan": "free",
      "used": 3, "remaining": 17, "periodKey": "2026-11", "resetsAt": "2026-12-01T00:00:00.000Z" },
    { "featureKey": "analysis.advanced_filters", "limitValue": 0, "usagePeriod": "none", "sourcePlan": "free",
      "used": null, "remaining": null, "periodKey": null, "resetsAt": null } ] }
```
- `limitValue: null` = unlimited. For `usagePeriod: "none"` features, `limitValue >= 1` means enabled (or the count limit for saved items).
- Refresh after sign-in, after a purchase, and when a 403 paywall error arrives.

### Paywall errors
```json
{ "statusCode": 403, "message": "Usage limit reached for this period",
  "data": { "code": "ENTITLEMENT_EXCEEDED",
    "details": { "featureKey": "analysis.matches_per_month", "limit": 20, "used": 20, "periodKey": "2026-11",
                 "resetsAt": "2026-12-01T00:00:00.000Z", "paywall": true, "unlockedBy": ["pro_monthly", "pro_annual"] },
    "requestId": "…" } }
```
`ENTITLEMENT_REQUIRED` has `details: { "featureKey", "sourcePlan", "paywall": true, "unlockedBy": […] }` (plus `limit`, `seasonsNewer` for history). When `details.paywall` is true, open the paywall screen for `featureKey`, showing `resetsAt` when present. Do not put a paywall in front of match stories or the timeline: those are always free.

### `GET /v1/billing/products` (paywall screen content, public)
```json
{ "billingAvailable": true,
  "plans": [ { "planKey": "pro_monthly", "name": "Pro (monthly)",
    "features": { "analysis.matches_per_month": { "limitValue": null, "usagePeriod": "month" }, … },
    "products": [ { "productId": "pro_monthly", "store": "google_play", "billingPeriod": "P1M" } ] }, … ],
  "comparison": [ { "group": "Deeper analysis", "items": [
    { "label": "Detailed match analytics (…)", "featureKey": "analysis.matches_per_month", "free": "20 matches a month", "pro": "Unlimited" } ] } ] }
```
Render `comparison` as the Free vs Pro table. Prices come from Google Play (`ProductDetails`), not from this API. If `billingAvailable` is false, hide the buy button.

---

## 8. Subscriptions (Google Play Billing)

Product ids: `pro_monthly`, `pro_annual` (subscriptions).

**Purchase flow:**
1. `GET /v1/billing/subscription` → note `subscription.obfuscatedAccountId`.
2. Query `ProductDetails` from Play for the product ids; show prices.
3. Launch the billing flow with `BillingFlowParams.Builder().setObfuscatedAccountId(obfuscatedAccountId)`. **Required**: the server rejects purchases made for another account.
4. On `PURCHASED`, send the token: `POST /v1/billing/google-play/verify` body `{ "productId": "pro_monthly", "purchaseToken": "<token>" }`.
5. The server verifies with Google and **acknowledges the purchase itself**. Do not acknowledge on the client. Then refresh `GET /v1/entitlements`.
6. `PENDING` purchases: still send them; the response shows `state: "pending"` and no access until Google completes it.

```json
{ "purchase": { "productId": "pro_monthly", "planKey": "pro_monthly", "state": "active", "entitled": true,
    "autoRenewing": true, "expiresAt": "2026-12-12T08:39:26.090Z", "lastVerifiedAt": "…" },
  "plan": { "key": "pro_monthly", "source": "google_play", "currentPeriodEnd": "2026-12-12T08:39:26.090Z" } }
```
Errors: 400 (unknown product, token unknown to Google, product mismatch), 403 `PURCHASE_ACCOUNT_MISMATCH`, 409 (token linked to another account), 503 `BILLING_NOT_CONFIGURED`. Rate limited to 20/min.

**Restore** (new device, reinstall, "Restore purchases" button): `POST /v1/billing/restore` (no body) → `{ "purchases": [Purchase], "plan": {…} }`. Also call it on app start if the Play client reports an owned subscription the server doesn't know about, by verifying that token.

**Subscription screen:** `GET /v1/billing/subscription`
```json
{ "subscription": { "plan": { … }, "billingAvailable": true, "billingProvider": "google_play",
  "obfuscatedAccountId": "43fb…", "purchase": Purchase | null,
  "manageUrl": "https://play.google.com/store/account/subscriptions?sku=pro_monthly&package=…" } }
```
Open `manageUrl` for "Manage / cancel subscription".

**`purchase.state`:** `pending`, `active`, `grace` (payment issue, still Pro), `on_hold` (payment failed, no Pro), `paused`, `cancelled` (Pro until `expiresAt`), `expired`, `revoked` (refunded). Use `entitled` for access, `state` for messaging (e.g. "Fix your payment method" for `grace`/`on_hold`).

---

## 9. Ads (AdMob)

`GET /v1/ads/config` (send the token if signed in):
```json
{ "ads": { "enabled": true, "reason": null, "network": "admob", "version": 1, "testUnits": true,
  "placements": [
    { "key": "home_feed_native", "screen": "home", "format": "native", "position": { "after": "recent", "first": 4, "every": 6 }, "maxPerSession": 3, "adUnitId": "ca-app-pub-…" },
    { "key": "explore_feed_native", "screen": "explore", "format": "native", "position": { "after": "results", "first": 5, "every": 8 }, "maxPerSession": 3, "adUnitId": "ca-app-pub-…" },
    { "key": "match_list_banner", "screen": "matches_list", "format": "banner", "position": { "slot": "bottom" }, "maxPerSession": 10, "adUnitId": "ca-app-pub-…" } ],
  "adFreeScreens": ["sign_in", "onboarding", "subscription", "payment", "match_story", "match_centre", "match_review",
                    "tactical_pitch", "advanced_analysis", "reports", "privacy", "account_deletion", "settings"],
  "frequency": { "minSecondsBetweenAds": 60, "maxPerSession": 6 }, "rewardedAds": false } }
```
- `enabled: false` with `reason: "plan"` for Pro users; `reason: "not_configured"` if ad units are not set up. Then show no ads at all.
- Fetch on app start and after plan changes. Never show ads on `adFreeScreens`.
- List responses (`/me/feed`, `/search`, `/matches`) include `adSlots` already filtered for the user; use them for in-list native ads.
- Use Google's UMP SDK for consent before loading ads. No user data is passed to ads.

---

## 10. Screen → endpoint map

| Screen (PDF §3) | Calls |
|---|---|
| Welcome / sign-in | Clerk SDK; then `GET /v1/me` |
| Onboarding | `GET /v1/search`, `GET /v1/competitions`, `PUT /v1/me/following/{kind}/{id}`, `PATCH /v1/me` (interests, depth) |
| Home | `GET /v1/me/feed`, `GET /v1/ads/config` |
| Explore / search | `GET /v1/search`, `GET /v1/competitions`, `GET /v1/concepts` |
| Competition page | `GET /v1/competitions/{id}`, `GET /v1/matches?competitionId=&seasonId=`, `GET /v1/teams?competitionId=` |
| Club page | `GET /v1/teams/{id}`, `/coverage`, `/players`, `/style`, `GET /v1/matches?teamId=` |
| Match centre | `GET /v1/matches/{id}`, `/lineups`, `/events`, `/story`, `/insights` |
| Tactical pitch / Explore | `/tactical-shape`, `/pressing`, `/transitions`, `/possessions`, `/metrics` (metered) |
| Player profile | `GET /v1/players/{id}`, `/players/{id}/matches`, `/matches/{id}/players/{playerId}` (metered) |
| Tactical concept | `GET /v1/concepts/{key}`, `PUT /v1/me/learning/{key}` |
| Saved items | `/me/saved-matches`, `/me/saved-insights`, `/me/notes`, `/me/collections` |
| Subscription | `GET /v1/billing/products`, `/billing/subscription`, `/entitlements`, purchase flow |
| Profile / settings | `GET/PATCH/DELETE /v1/me`, `/me/sessions` |

## 11. Limits and caching tips

- Rate limits: 120 requests/min per IP when anonymous, 600/min per signed-in user. 429 carries `retry-after`.
- Cache `GET /v1/metric-definitions` and `GET /v1/concepts` for a day.
- Match analysis responses for a given `analysisRunId` never change; cache them by that id.
- Match lists and the feed change when new matches are ingested (daily); refresh on pull-to-refresh.
