import ApiResponse from "./ApiResponse.js";

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
  console.error(JSON.stringify({ level: "error", msg: "unhandled error", requestId, path: req.originalUrl, error: err?.message, stack: err?.stack }));
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
