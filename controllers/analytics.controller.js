import { z } from "zod";
import ApiResponse from "../utils/ApiResponse.js";
import { pageQuery } from "../utils/pagination.js";
import { named } from "../utils/respond.js";
import { POSSESSION_END_TYPES, SCOPES } from "../models/index.js";
import { matchSubject, metered } from "../middlewares/entitlement.middleware.js";
import { services } from "../services/index.js";

export const schemas = {
  matchIdParam: z.object({ matchId: z.uuid() }),
  matchPlayerParams: z.object({ matchId: z.uuid(), playerId: z.uuid() }),
  metricsQuery: z.object({
    scope: z.enum(SCOPES).optional(),
    teamId: z.uuid().optional(),
    // A player id, or 'none' for team-level metrics only.
    playerId: z.union([z.uuid(), z.literal("none")]).optional(),
    keys: z
      .string()
      .transform((s) =>
        s
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().regex(/^[a-z0-9_.]+$/)).max(50))
      .optional(),
    include: z.enum(["definitions"]).optional(),
  }),
  shapeQuery: z.object({ scope: z.enum(["full", "1H", "2H"]).default("full") }),
  possessionsQuery: pageQuery(50, 200).extend({ teamId: z.uuid().optional(), endType: z.enum(POSSESSION_END_TYPES).optional() }),
  compareQuery: z.object({ a: z.uuid(), b: z.uuid(), teamId: z.uuid().optional() }),
};

/**
 * Explore / Advanced depth views. Metered under `analysis.matches_per_month`: opening any number of these views
 * for the same match costs one unit per month. Match summary, timeline, insights and story stay free.
 */
const MATCH_FEATURE = "analysis.matches_per_month";

const compare = metered(
  "comparisons.per_month",
  (req) => {
    const ids = [String(req.query.a), String(req.query.b)].sort();
    return { type: "match_pair", id: `${ids[0]}:${ids[1]}:${String(req.query.teamId ?? "")}` };
  },
  async (req, res) => {
    const q = req.valid.query;
    const comparison = await services().analytics.compare(q.a, q.b, q.teamId);
    return ApiResponse.success(res, "Comparison retrieved successfully", { comparison });
  },
);

const getMetrics = metered(MATCH_FEATURE, matchSubject(), async (req, res) => {
  const q = req.valid.query;
  const result = await services().analytics.metrics(req.valid.params.matchId, {
    scope: q.scope,
    teamId: q.teamId,
    playerId: q.playerId === "none" ? null : q.playerId,
    keys: q.keys,
    includeDefinitions: q.include === "definitions",
  });
  return ApiResponse.success(res, "Metrics retrieved successfully", named("metrics", result));
});

const getTacticalShape = metered(MATCH_FEATURE, matchSubject(), async (req, res) => {
  const shape = await services().analytics.tacticalShape(req.valid.params.matchId, req.valid.query.scope);
  return ApiResponse.success(res, "Tactical shape retrieved successfully", { shape });
});

const getPressing = metered(MATCH_FEATURE, matchSubject(), async (req, res) => {
  const pressing = await services().analytics.pressing(req.valid.params.matchId);
  return ApiResponse.success(res, "Pressing retrieved successfully", { pressing });
});

const getTransitions = metered(MATCH_FEATURE, matchSubject(), async (req, res) => {
  const transitions = await services().analytics.transitions(req.valid.params.matchId);
  return ApiResponse.success(res, "Transitions retrieved successfully", { transitions });
});

const listPossessions = metered(MATCH_FEATURE, matchSubject(), async (req, res) => {
  const result = await services().analytics.possessions(req.valid.params.matchId, req.valid.query);
  return ApiResponse.success(res, "Possessions retrieved successfully", named("possessions", result));
});

const getMatchPlayer = metered(MATCH_FEATURE, matchSubject(), async (req, res) => {
  const player = await services().analytics.player(req.valid.params.matchId, req.valid.params.playerId);
  return ApiResponse.success(res, "Player analysis retrieved successfully", { player });
});

export { compare, getMetrics, getTacticalShape, getPressing, getTransitions, listPossessions, getMatchPlayer };
