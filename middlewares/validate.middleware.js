import ApiError from "../utils/ApiError.js";
import { sendError } from "../utils/asyncHandler.js";

const MAX_DEPTH = 32;

/**
 * Walks a request value without recursion (so hostile nesting cannot exhaust the stack) and returns the first
 * problem: a NUL byte (Postgres text cannot store it) or nesting deeper than any request legitimately needs.
 */
function inspect(value) {
  const stack = [[value, [], 0]];
  while (stack.length) {
    const [v, path, depth] = stack.pop();
    if (typeof v === "string") {
      if (v.includes("\u0000")) return { path, message: "Null bytes are not allowed" };
    } else if (v && typeof v === "object") {
      if (depth >= MAX_DEPTH) return { path, message: "Value is nested too deeply" };
      for (const [k, child] of Object.entries(v)) {
        if (k.includes("\u0000")) return { path: [...path, k], message: "Null bytes are not allowed" };
        stack.push([child, [...path, k], depth + 1]);
      }
    }
  }
  return null;
}

function parse(schema, value) {
  const bad = inspect(value);
  if (bad) throw ApiError.validation([{ path: bad.path.join("."), message: bad.message, code: "invalid_input" }]);
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw ApiError.validation(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message, code: i.code })));
  }
  return parsed.data;
}

/**
 * Validates request parts with zod schemas. The parsed (and transformed) values are placed on
 * `req.valid.params`, `req.valid.query` and `req.valid.body`; controllers read only from there.
 */
export const validate =
  ({ params, query, body } = {}) =>
  (req, res, next) => {
    try {
      req.valid = {
        ...(req.valid ?? {}),
        ...(params ? { params: parse(params, req.params) } : {}),
        ...(query ? { query: parse(query, req.query) } : {}),
        ...(body ? { body: parse(body, req.body ?? {}) } : {}),
      };
      next();
    } catch (err) {
      sendError(err, req, res);
    }
  };

export default validate;
