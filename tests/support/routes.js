// Catalogue of every registered route, with concrete paths and valid bodies. Tests iterate it so that a route
// cannot be added without being exercised for authentication, validation and the response contract.
//
// access: "public"   – works anonymously
//         "user"     – needs a valid token (401 without)
//         "metered"  – needs a token and counts against a plan limit
//         "webhook"  – authenticated by signature / shared token, not by user token
//         "health"   – infrastructure endpoints

/** @param ids { match, match2, team, player, competition, insight, note, collection, uuid } */
export function routes(ids) {
  const m = ids.match;
  return [
    { method: "GET", path: "/healthz", access: "health" },
    { method: "GET", path: "/readyz", access: "health" },
    { method: "GET", path: "/", access: "public" },

    { method: "GET", path: "/v1/competitions", access: "public", list: "competitions" },
    { method: "GET", path: `/v1/competitions/${ids.competition}`, access: "public", idParam: "/v1/competitions/:id" },
    { method: "GET", path: `/v1/competitions/${ids.competition}/seasons`, access: "public", idParam: "/v1/competitions/:id/seasons" },
    { method: "GET", path: "/v1/teams", access: "public", list: "teams", paged: true },
    { method: "GET", path: `/v1/teams/${ids.team}`, access: "public", idParam: "/v1/teams/:id" },
    { method: "GET", path: `/v1/teams/${ids.team}/players`, access: "public", idParam: "/v1/teams/:id/players" },
    { method: "GET", path: `/v1/teams/${ids.team}/coverage`, access: "public", idParam: "/v1/teams/:id/coverage" },
    { method: "GET", path: `/v1/teams/${ids.team}/style`, access: "public", idParam: "/v1/teams/:id/style" },
    { method: "GET", path: `/v1/players/${ids.player}`, access: "public", idParam: "/v1/players/:id" },
    { method: "GET", path: `/v1/players/${ids.player}/matches`, access: "public", idParam: "/v1/players/:id/matches", paged: true },
    { method: "GET", path: "/v1/search?q=arg", access: "public" },
    { method: "GET", path: "/v1/matches", access: "public", list: "matches", paged: true },
    { method: "GET", path: `/v1/matches/${m}`, access: "public", idParam: "/v1/matches/:id" },
    { method: "GET", path: `/v1/matches/${m}/lineups`, access: "public", idParam: "/v1/matches/:id/lineups" },
    { method: "GET", path: `/v1/matches/${m}/events`, access: "public", idParam: "/v1/matches/:id/events", paged: true },
    { method: "GET", path: `/v1/matches/${m}/insights`, access: "public", idParam: "/v1/matches/:id/insights" },
    { method: "GET", path: `/v1/matches/${m}/story`, access: "public", idParam: "/v1/matches/:id/story" },
    { method: "GET", path: "/v1/concepts", access: "public" },
    { method: "GET", path: "/v1/concepts/ppda", access: "public" },
    { method: "GET", path: "/v1/metric-definitions", access: "public" },
    { method: "GET", path: "/v1/metric-definitions/pressing.ppda", access: "public" },
    { method: "GET", path: `/v1/jobs/${ids.jobId}`, access: "public" },
    { method: "GET", path: "/v1/billing/products", access: "public" },
    { method: "GET", path: "/v1/ads/config", access: "public" },

    { method: "GET", path: `/v1/matches/${m}/metrics`, access: "metered", idParam: "/v1/matches/:id/metrics" },
    { method: "GET", path: `/v1/matches/${m}/tactical-shape`, access: "metered", idParam: "/v1/matches/:id/tactical-shape" },
    { method: "GET", path: `/v1/matches/${m}/pressing`, access: "metered", idParam: "/v1/matches/:id/pressing" },
    { method: "GET", path: `/v1/matches/${m}/transitions`, access: "metered", idParam: "/v1/matches/:id/transitions" },
    { method: "GET", path: `/v1/matches/${m}/possessions`, access: "metered", idParam: "/v1/matches/:id/possessions", paged: true },
    { method: "GET", path: `/v1/matches/${m}/players/${ids.player}`, access: "metered" },
    { method: "GET", path: `/v1/matches/compare?a=${m}&b=${ids.match2}`, access: "metered" },
    { method: "POST", path: `/v1/matches/${m}/analysis-jobs`, access: "user" },

    { method: "GET", path: "/v1/me", access: "user" },
    { method: "PATCH", path: "/v1/me", access: "user", body: { depthPreference: "explore" } },
    { method: "GET", path: "/v1/me/sessions", access: "user" },
    { method: "DELETE", path: "/v1/me/sessions/sess_unknown", access: "user" },
    { method: "GET", path: "/v1/me/feed", access: "user" },
    { method: "GET", path: "/v1/me/following", access: "user" },
    { method: "PUT", path: `/v1/me/following/teams/${ids.team}`, access: "user" },
    { method: "DELETE", path: `/v1/me/following/teams/${ids.team}`, access: "user" },
    { method: "GET", path: "/v1/me/saved-matches", access: "user", paged: true },
    { method: "PUT", path: `/v1/me/saved-matches/${m}`, access: "user" },
    { method: "DELETE", path: `/v1/me/saved-matches/${m}`, access: "user" },
    { method: "GET", path: "/v1/me/saved-insights", access: "user", paged: true },
    { method: "PUT", path: `/v1/me/saved-insights/${ids.insight}`, access: "user" },
    { method: "DELETE", path: `/v1/me/saved-insights/${ids.insight}`, access: "user" },
    { method: "GET", path: "/v1/me/notes", access: "user", paged: true },
    { method: "POST", path: "/v1/me/notes", access: "user", body: { subjectType: "match", subjectId: m, body: "contract test note" } },
    { method: "GET", path: `/v1/me/notes/${ids.note}`, access: "user" },
    { method: "PATCH", path: `/v1/me/notes/${ids.note}`, access: "user", body: { body: "edited" } },
    { method: "DELETE", path: `/v1/me/notes/${ids.uuid}`, access: "user" },
    { method: "GET", path: "/v1/me/collections", access: "user" },
    { method: "POST", path: "/v1/me/collections", access: "user", body: { name: "contract" } },
    { method: "GET", path: `/v1/me/collections/${ids.collection}`, access: "user" },
    { method: "PATCH", path: `/v1/me/collections/${ids.collection}`, access: "user", body: { name: "renamed" } },
    { method: "PUT", path: `/v1/me/collections/${ids.collection}/items`, access: "user", body: { itemType: "match", itemId: m } },
    { method: "DELETE", path: `/v1/me/collections/${ids.collection}/items/match/${m}`, access: "user" },
    { method: "DELETE", path: `/v1/me/collections/${ids.uuid}`, access: "user" },
    { method: "GET", path: "/v1/me/learning", access: "user" },
    { method: "PUT", path: "/v1/me/learning/ppda", access: "user", body: { status: "viewed" } },
    { method: "GET", path: "/v1/entitlements", access: "user" },
    { method: "GET", path: "/v1/billing/subscription", access: "user" },
    { method: "POST", path: "/v1/billing/google-play/verify", access: "user", body: { productId: "pro_monthly", purchaseToken: "not-a-real-token-123" } },
    { method: "POST", path: "/v1/billing/restore", access: "user" },
    { method: "DELETE", path: "/v1/me", access: "user", destructive: true },

    { method: "POST", path: "/v1/webhooks/clerk", access: "webhook" },
    { method: "POST", path: "/webhooks/clerk", access: "webhook" },
    { method: "POST", path: "/v1/webhooks/google-play-rtdn", access: "webhook" },
  ];
}

/** Number of distinct route patterns registered in app.js and routes/*.js (kept in sync by the contract test). */
export const REGISTERED_ROUTE_COUNT = 70;
