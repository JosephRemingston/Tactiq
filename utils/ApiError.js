import PLANS from "../data/plans.json" with { type: "json" };

/** Paid plans that give more of `featureKey` than Free, so the app can point the paywall at the right product. */
export function unlockedBy(featureKey) {
  const free = PLANS.plans.find((p) => p.planKey === "free")?.features[featureKey]?.limitValue ?? 0;
  return PLANS.plans
    .filter((p) => p.planKey !== "free")
    .filter((p) => {
      const limit = p.features[featureKey]?.limitValue;
      return limit === null || (limit !== undefined && free !== null && limit > free);
    })
    .map((p) => p.planKey);
}

class ApiError extends Error {
  constructor(statusCode, message, code = "ERROR", details = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.message = message;
    this.code = code;
    this.details = details;
  }

  static badRequest(message, details) {
    return new ApiError(400, message, "VALIDATION_FAILED", details);
  }

  static validation(details) {
    return new ApiError(400, "Request validation failed", "VALIDATION_FAILED", details);
  }

  static unauthorized(message = "Authentication required") {
    return new ApiError(401, message, "UNAUTHENTICATED");
  }

  static forbidden(message = "Forbidden", code = "FORBIDDEN", details) {
    return new ApiError(403, message, code, details);
  }

  /** Paywall: the feature is not in the user's plan. `details.unlockedBy` lists the plans that include it. */
  static entitlementRequired(details) {
    return new ApiError(403, "This feature is not included in your plan", "ENTITLEMENT_REQUIRED", {
      ...details,
      paywall: true,
      unlockedBy: unlockedBy(details?.featureKey),
    });
  }

  /** Paywall: the plan's limit for this period is used up. */
  static entitlementExceeded(details) {
    return new ApiError(403, "Usage limit reached for this period", "ENTITLEMENT_EXCEEDED", {
      ...details,
      paywall: true,
      unlockedBy: unlockedBy(details?.featureKey),
    });
  }

  static notFound(what = "Resource") {
    return new ApiError(404, `${what} not found`, "NOT_FOUND");
  }

  static conflict(message) {
    return new ApiError(409, message, "CONFLICT");
  }

  static tooManyRequests(message = "Too many requests", details) {
    return new ApiError(429, message, "RATE_LIMITED", details);
  }

  static unavailable(message, code = "PROVIDER_UNAVAILABLE") {
    return new ApiError(503, message, code);
  }
}

/** Ownership helper: a missing row and a row owned by someone else are indistinguishable (404). */
export function assertFound(row, what = "Resource") {
  if (row === null || row === undefined) throw ApiError.notFound(what);
  return row;
}


export async function assertOwned(lookup, what = "Resource") {
  return assertFound(await lookup(), what);
}

export default ApiError;
