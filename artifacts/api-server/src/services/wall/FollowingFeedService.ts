/**
 * FollowingFeedService — strict reverse-chronological Following feed
 * (spec §5 / TABLE 1 / TABLE 2).
 *
 * OWNS: the strict chronological eligible feed. DOES NOT OWN: relevance
 * reordering — there is NONE here, by contract (spec TABLE 1: "No relevance
 * reordering. Apply only safety/visibility filters."). The safety/visibility
 * filters have already run in WallProjectionService upstream, so this service's
 * only job is to impose a stable total order on the survivors.
 *
 * ORDER (spec §16/§28): publishedAt DESC — the publication clock is the spine,
 * never experienceAt — with canonicalObjectId DESC as the deterministic
 * tiebreaker so two objects published in the same instant never swap between
 * pages. The cursor is stable against exactly that (publishedAt + tiebreaker),
 * so a Following cursor is a precise position in a total order, not an offset
 * into a set that could shift.
 *
 * `caughtUp` is true once the viewer has reached the end of eligible followed
 * content (spec §27) — the predictable "you're all caught up" trust signal.
 *
 * Pure and DB-free: it orders and paginates an already-fetched, already-gated
 * projection list.
 */
import type { WallProjection } from "../../lib/wallProjection.js";

export interface FollowingCursor {
  /** publishedAt of the last item on the previous page. */
  publishedAt: string;
  /** canonicalObjectId of the last item on the previous page (tiebreaker). */
  id: string;
}

export interface BuildFollowingOptions {
  limit: number;
  cursor?: FollowingCursor | null;
  /**
   * Whether the underlying candidate fetch reached the TRUE end of eligible
   * followed content (returned fewer than its fetch cap). `caughtUp` is asserted
   * ONLY when this is true (or unspecified, for callers that fetch the whole set),
   * so exhausting a capped fetch window never masquerades as "you're all caught
   * up" while older eligible posts remain unfetched (spec §27).
   */
  reachedEnd?: boolean;
}

export interface BuildFollowingResult {
  items: WallProjection[];
  nextCursor: FollowingCursor | null;
  caughtUp: boolean;
}

export function encodeFollowingCursor(c: FollowingCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

export function decodeFollowingCursor(token: string): FollowingCursor | null {
  try {
    const obj = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (typeof obj.publishedAt !== "string" || isNaN(new Date(obj.publishedAt).getTime())) {
      return null;
    }
    if (typeof obj.id !== "string" || !obj.id) return null;
    return { publishedAt: obj.publishedAt, id: obj.id };
  } catch {
    return null;
  }
}

/**
 * Total order: newest first. publishedAt DESC, then canonicalObjectId DESC. A
 * NaN/invalid publishedAt sorts to the very end (oldest) rather than corrupting
 * the order — a malformed row never jumps to the top of a Following feed.
 */
function compareDesc(a: WallProjection, b: WallProjection): number {
  const ta = Date.parse(a.publishedAt);
  const tb = Date.parse(b.publishedAt);
  const na = Number.isNaN(ta) ? -Infinity : ta;
  const nb = Number.isNaN(tb) ? -Infinity : tb;
  if (nb !== na) return nb - na;
  // Tiebreaker: canonicalObjectId DESC (string compare) — deterministic + total.
  if (a.canonicalObjectId !== b.canonicalObjectId) {
    return a.canonicalObjectId < b.canonicalObjectId ? 1 : -1;
  }
  return 0;
}

/** Is `p` strictly after the cursor position in the DESC total order? */
function isAfterCursor(p: WallProjection, cursor: FollowingCursor): boolean {
  const tp = Date.parse(p.publishedAt);
  const tc = Date.parse(cursor.publishedAt);
  const np = Number.isNaN(tp) ? -Infinity : tp;
  const nc = Number.isNaN(tc) ? -Infinity : tc;
  if (np !== nc) return np < nc; // older than cursor ⇒ comes after it (DESC)
  // Same instant: tiebreak on id DESC ⇒ smaller id comes after.
  return p.canonicalObjectId < cursor.id;
}

/**
 * Build one page of the strict reverse-chronological Following feed.
 *
 * Deduplicates by canonicalObjectId (first occurrence wins after sort), imposes
 * the total order, applies the cursor, and slices to `limit`. `caughtUp` is true
 * exactly when there is no next page — the viewer has seen every eligible item.
 */
export function buildFollowing(
  projections: WallProjection[],
  opts: BuildFollowingOptions,
): BuildFollowingResult {
  const limit = Math.max(1, Math.min(opts.limit, 50));

  // Dedupe (spec §28: never duplicate canonicalObjectId in one feed session).
  const seen = new Set<string>();
  const unique: WallProjection[] = [];
  for (const p of projections) {
    if (seen.has(p.canonicalObjectId)) continue;
    seen.add(p.canonicalObjectId);
    unique.push(p);
  }

  const ordered = unique.sort(compareDesc);
  const afterCursor = opts.cursor ? ordered.filter((p) => isAfterCursor(p, opts.cursor!)) : ordered;

  const page = afterCursor.slice(0, limit);
  const hasMore = afterCursor.length > page.length;
  const last = page[page.length - 1];
  const nextCursor: FollowingCursor | null =
    hasMore && last ? { publishedAt: last.publishedAt, id: last.canonicalObjectId } : null;

  // Honest "caught up": this page exhausted the gated set AND the underlying fetch
  // actually reached the end. A capped fetch window that merely ran out of rows in
  // the gated set (older eligible posts still unfetched) is NOT caught up (§27).
  // `reachedEnd` undefined ⇒ the caller fetched the whole set, so !hasMore suffices.
  const reachedEnd = opts.reachedEnd ?? true;

  return {
    items: page,
    nextCursor,
    caughtUp: !hasMore && reachedEnd,
  };
}
