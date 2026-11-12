import ApiResponse from "./ApiResponse.js";

/**
 * A log-safe description of an error. Query errors carry the full SQL and every bound parameter (which can be a
 * user's private note, a purchase token or an email), so only the database's own error code and message are kept,
 * cut at the first quoted value. Stack traces are kept for debugging; they contain code locations, not data.
 */
export function describeForLog(err) {
  const cause = err?.cause instanceof Error ? err.cause : null;
  const base = cause ?? err;
  let message = String(base?.message ?? err ?? "unknown error");
  if (/^Failed query:/i.test(message)) message = "query failed";
  message = message.replace(/"[^"]*"/g, '"…"').replace(/'[^']*'/g, "'…'").slice(0, 300);
  return {
    error: base?.name ?? "Error",
    ...(base?.code ? { code: String(base.code) } : {}),
    message,
    // Only "at …" frames: the first lines of a stack repeat the message, including any bound parameters.
    stack: String(err?.stack ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("at "))
      .slice(0, 5),
  };
}

/** The matched route pattern (e.g. /v1/me/notes/:id) instead of the raw URL, which can carry ids and tokens. */
function routeOf(req) {
  return req.route?.path ? `${req.baseUrl ?? ""}${req.route.path}` : (req.originalUrl ?? "").split("?")[0].slice(0, 200);
}

/**
 * Sends any thrown error as the standard envelope { statusCode, message, data }.
 * Known errors (ApiError) keep their status and code; anything else is a 500 that never leaks internals.
 */
export function sendError(err, req, res) {
  if (res.headersSent) return;
  const requestId = req.id ?? "";
  if (err && err.statusCode && err.code) {
    return ApiResponse.error(res, err.statusCode, err.message, {
      code: err.code,
      ...(err.details !== undefined ? { details: err.details } : {}),
      requestId,
    });
  }
  // body-parser and similar middleware errors carry `status` and `type`.
  if (err && err.status === 413) {
    return ApiResponse.error(res, 413, "Request body too large", { code: "VALIDATION_FAILED", requestId });
  }
  if (err && err.status === 400) {
    return ApiResponse.error(res, 400, "Malformed request body", { code: "VALIDATION_FAILED", requestId });
  }
  console.error(JSON.stringify({ level: "error", msg: "unhandled error", requestId, method: req.method, route: routeOf(req), ...describeForLog(err) }));
  return ApiResponse.error(res, 500, "Internal server error", { code: "INTERNAL", requestId });
}

const asyncHandler = (request) => async (req, res, next) => {
  try {
    return await Promise.resolve(request(req, res, next));
  } catch (err) {
    return sendError(err, req, res);
  }
};

export default asyncHandler;
