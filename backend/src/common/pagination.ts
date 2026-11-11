import { z } from 'zod';
import { Errors } from './errors';

export const MAX_PAGE_SIZE = 100;

export const pageQuery = (defaultLimit = 25, max = MAX_PAGE_SIZE) =>
  z.object({
    limit: z.coerce.number().int().min(1).max(max).default(defaultLimit).describe(`Page size (max ${max})`),
    cursor: z.string().max(512).optional().describe('Opaque cursor from page.nextCursor'),
  });

export interface Page<T> {
  data: T[];
  page: { nextCursor: string | null; limit: number };
}

/** Cursor = base64url(JSON [sortValue, id]). Opaque to clients, stable under inserts. */
export function encodeCursor(sortValue: string | number, id: string): string {
  return Buffer.from(JSON.stringify([sortValue, id])).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): [string | number, string] | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[1] === 'string' && ['string', 'number'].includes(typeof parsed[0])) {
      return parsed as [string | number, string];
    }
  } catch {
    // fall through
  }
  throw Errors.validation([{ path: 'cursor', message: 'Invalid cursor' }]);
}

/** Builds a page from rows fetched with limit + 1. */
export function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => [string | number, string]): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return { data, page: { nextCursor: hasMore && last ? encodeCursor(...cursorOf(last)) : null, limit } };
}
