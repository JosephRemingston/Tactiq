import { z } from "zod";
import ApiError from "./ApiError.js";
import { isUuid } from "./ids.js";

export const MAX_PAGE_SIZE = 100;

/**
 * A whole number written in plain decimal digits. Stricter than z.coerce.number(), which follows JavaScript's
 * Number() and so also accepts " 5 ", "0x10", "0b11" and "5e0".
 */
export const intParam = (min, max) =>
  z
    .string()
    .regex(/^\d{1,15}$/, "Expected a whole number")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

/** A calendar date (YYYY-MM-DD, optionally with a time) that really exists: 2022-02-30 is rejected, not rolled over. */
export const isoDateParam = () =>
  z
    .string()
    .max(40)
    .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?)?$/, "ISO date expected")
    .refine((v) => {
      const [y, m, d] = v.slice(0, 10).split("-").map(Number);
      const day = new Date(Date.UTC(y, m - 1, d));
      return day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d && Number.isFinite(Date.parse(v));
    }, "Not a valid date");

export const pageQuery = (defaultLimit = 25, max = MAX_PAGE_SIZE) =>
  z.object({
    limit: intParam(1, max).default(defaultLimit),
    cursor: z.string().max(512).optional(),
  });

/** Cursor = base64url(JSON [sortValue, id]). Opaque to clients, stable under inserts. */
export function encodeCursor(sortValue, id) {
  return Buffer.from(JSON.stringify([sortValue, id])).toString("base64url");
}

const CHECKS = {
  string: (v) => typeof v === "string" && v.length <= 300 && !v.includes("\u0000"),
  uuid: (v) => typeof v === "string" && isUuid(v),
  date: (v) => typeof v === "string" && Number.isFinite(Date.parse(v)),
  int: (v) => Number.isSafeInteger(typeof v === "string" ? Number(v) : v) && Number(v) >= 0,
};

/**
 * Decodes a cursor and checks each part against the type the query will bind it as, e.g. ["date", "uuid"].
 * Cursors come from clients, so a tampered one must be a 400, never a database error.
 */
export function decodeCursor(cursor, shape = ["string", "string"]) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 2 && shape.every((kind, i) => CHECKS[kind](parsed[i]))) {
      return parsed;
    }
  } catch {
    // fall through
  }
  throw ApiError.validation([{ path: "cursor", message: "Invalid cursor" }]);
}

/** Builds a page from rows fetched with limit + 1. */
export function toPage(rows, limit, cursorOf) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return { data, page: { nextCursor: hasMore && last ? encodeCursor(...cursorOf(last)) : null, limit } };
}
