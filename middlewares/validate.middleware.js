import ApiError from "../utils/ApiError.js";
import { sendError } from "../utils/asyncHandler.js";

function parse(schema, value) {
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
