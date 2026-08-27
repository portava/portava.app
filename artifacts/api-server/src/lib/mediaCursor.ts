/**
 * mediaCursor — stable opaque cursor for the Watch mode media feed.
 *
 * Encodes { created_at, id } as a base64 JSON string so the client treats it
 * as an opaque token. Decoding is validated and returns null on any tampering
 * or malformation — the feed simply restarts from the beginning on a bad cursor.
 *
 * Stability guarantee: new items inserted after the first page was fetched
 * never drift the window; we filter created_at < cursor.created_at OR
 * (created_at = cursor.created_at AND id < cursor.id) which is a total order.
 */

export interface CursorPayload {
  /** ISO 8601 timestamp of the last returned item. */
  created_at: string;
  /** UUID of the last returned item (tie-breaker). */
  id: string;
}

/** Encode a cursor payload to an opaque token string. */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

const CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Decode a cursor token. Returns null if the token is invalid. */
export function decodeCursor(token: string): CursorPayload | null {
  try {
    const raw = Buffer.from(token, "base64url").toString("utf8");
    const obj = JSON.parse(raw);
    if (typeof obj.created_at !== "string" || typeof obj.id !== "string") return null;
    if (!obj.created_at || !obj.id) return null;
    // Both fields are interpolated RAW into a PostgREST .or() filter
    // (applyCursorFilter), so they must be format-validated here or a crafted
    // token could inject filter conditions. id must be a plain UUID; created_at
    // must be a parseable timestamp AND carry none of the .or() structural
    // metacharacters ( ) , that could terminate the group.
    if (!CURSOR_UUID_RE.test(obj.id)) return null;
    if (/[(),]/.test(obj.created_at)) return null;
    if (isNaN(new Date(obj.created_at).getTime())) return null;
    return { created_at: obj.created_at, id: obj.id };
  } catch {
    return null;
  }
}

/**
 * Apply cursor constraints to a Supabase query builder.
 *
 * For a DESC created_at ordering, items after the cursor satisfy:
 *   created_at < cursor.created_at
 *   OR (created_at = cursor.created_at AND id < cursor.id)
 *
 * Supabase JS doesn't support OR across columns directly, so we use the
 * `or()` filter with PostgREST syntax.
 */
export function applyCursorFilter(
  query: any,
  cursor: CursorPayload,
): any {
  return query.or(
    `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`,
  );
}
