import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import { sql } from "drizzle-orm";
import { isUuid } from "../utils/ids.js";
import { services } from "../services/index.js";

/** The metered subject for match views: any number of views of one match costs one unit per period. */
export const matchSubject =
  (param = "matchId") =>
  (req) => ({ type: "match", id: String(req.params[param]) });

/**
 * Server-side paywall (PDF section 5): hiding a button in the app is not access control.
 *
 * Wraps a controller so that the feature is charged before the work runs:
 *   - not in the plan            -> 403 ENTITLEMENT_REQUIRED
 *   - period limit reached       -> 403 ENTITLEMENT_EXCEEDED
 *   - allowed                    -> handler runs, `x-entitlement-remaining` is set
 * If the handler then fails with a server error, the charge is refunded.
 * Use after `authenticate`.
 */
export const metered = (featureKey, subjectOf, handler) =>
  asyncHandler(async (req, res, next) => {
    const user = req.user;
    if (!user) throw ApiError.unauthorized("Sign in to use this feature");
    const { entitlements } = services();
    const subject = subjectOf(req);
    const result = await entitlements.consume(user.id, featureKey, subject);
    if (result.entitlement.remaining !== null) res.setHeader("x-entitlement-remaining", String(result.entitlement.remaining));
    try {
      return await handler(req, res, next);
    } catch (err) {
      const serverError = !(err instanceof ApiError) || err.statusCode >= 500;
      if (result.charged && serverError && result.entitlement.periodKey) {
        await entitlements.refund(user.id, featureKey, subject, result.entitlement.periodKey).catch(() => undefined);
      }
      throw err;
    }
  });

/**
 * Gate for on/off features (no usage counting): passes when the user's plan enables `featureKey`,
 * otherwise 403 ENTITLEMENT_REQUIRED. Use after `authenticate`.
 */
export const requiresFeature = (featureKey) =>
  asyncHandler(async (req, res, next) => {
    if (!req.user) throw ApiError.unauthorized("Sign in to use this feature");
    const { entitlements } = services();
    if (!(await entitlements.isEnabled(req.user.id, featureKey))) {
      const eff = await entitlements.resolve(req.user.id, featureKey);
      throw ApiError.entitlementRequired({ featureKey, sourcePlan: eff.sourcePlan });
    }
    next();
  });

/**
 * Like `requiresFeature`, but only when `isAdvanced(req)` is true. Lets one route stay free for its basic form
 * (e.g. the match timeline) while its power-user options (filters, raw provider data) need the feature.
 * Works on public routes: an anonymous caller asking for the advanced form gets 401 so the app can prompt sign-in.
 */
export const requiresFeatureWhen = (featureKey, isAdvanced) => {
  const gate = requiresFeature(featureKey);
  return (req, res, next) => (isAdvanced(req) ? gate(req, res, next) : next());
};

/**
 * Historical depth (`history.seasons_back`): a match from a season older than the user's allowance needs a plan
 * with more history. Seasons are ranked newest first within the match's competition; rank 0 is the latest season.
 * Use after `authenticate` on per-match analysis routes.
 */
export const historyGate = (param = "matchId") =>
  asyncHandler(async (req, res, next) => {
    const matchId = String(req.params[param]);
    if (!isUuid(matchId)) return next(); // the validator rejects it next
    const { entitlements, db } = services();
    const eff = await entitlements.resolve(req.user.id, "history.seasons_back");
    if (eff.limitValue === null) return next();
    const { rows } = await db.execute(sql`
      select count(*)::int as newer
        from seasons s
        join matches m on m.id = ${matchId}
       where s.competition_id = m.competition_id
         and coalesce(s.start_date::text, s.name) > (select coalesce(ms.start_date::text, ms.name) from seasons ms where ms.id = m.season_id)`);
    const newer = rows[0]?.newer ?? 0;
    if (newer >= eff.limitValue) {
      throw ApiError.entitlementRequired({ featureKey: "history.seasons_back", limit: eff.limitValue, seasonsNewer: newer, sourcePlan: eff.sourcePlan });
    }
    next();
  });
