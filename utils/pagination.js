import { z } from "zod";
import ApiError from "./ApiError.js";

export const MAX_PAGE_SIZE = 100;

export const pageQuery = (defaultLimit = 25, max = MAX_PAGE_SIZE) =>
  z.object({
    limit: z.coerce.number().int().min(1).max(max).default(defaultLimit),
    cursor: z.string().max(512).optional(),
  });

/** Cursor = base64url(JSON [sortValue, id]). Opaque to clients, stable under inserts. */
export function encodeCursor(sortValue, id) {
  return Buffer.from(JSON.stringify([sortValue, id])).toString("base64url");
}

export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[1] === "string" && ["string", "number"].includes(typeof parsed[0])) {
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
