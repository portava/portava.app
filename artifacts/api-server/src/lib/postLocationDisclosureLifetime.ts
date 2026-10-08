/**
 * When a post's exact place stops being shown to other people — census-media
 * MD79 (spec §11 `locationDisclosureExpiresAt`), lead rulings D-26f and D-26g
 * (`docs/ops/lead-rulings-20261007-media.md`).
 *
 * THE RULE. Only a "Publish after I leave" post (`location_privacy_mode =
 * 'delayed_until_exit'`) has a disclosure lifetime. Once the delayed-publish
 * worker releases it (`post_status = 'published'`, `published_at` stamped by
 * lib/delayedPostPublisher), others see the place for
 * RELEASED_DELAYED_PLACE_WINDOW_MS; after that they see the city
 * (AFTER_LOCATION_DISCLOSURE_TIER) — the tier "City only" already uses. Every
 * other mode has no lifetime, so nothing about them changes.
 *
 * FAIL CLOSED. A released "Publish after I leave" row whose release time cannot
 * be read — null, unparseable, or NOT SELECTED by the reader — has ENDED. A
 * reader that wants the 24-hour window must select `published_at`; one that does
 * not shows the city from release, which is less than the rule allows, never
 * more.
 *
 * THE AUTHOR. Never capped: every caller applies the owner bypass before this
 * (mapPublicPost is not applied to the author's own reads; the media choke point
 * returns the owner's own location first).
 *
 * Pure, no imports, so both lib/postSchemas (mapPublicPost) and the media choke
 * point's callers can use it without an import cycle.
 */

/** D-26f: the exact place is shown for 24 hours after release. Change it here, in one place. */
export const RELEASED_DELAYED_PLACE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** D-26g: what the place falls to once its disclosure has ended. */
export const AFTER_LOCATION_DISCLOSURE_TIER = "city" as const;

/**
 * Served as the §11 instant when a lifetime applies but its start cannot be
 * read. It is deliberately not a date, so `locationDisclosureExpired` (lib/
 * mediaLocationVisibility) and this module both read it as ENDED, and the §11
 * member's ISO filter (lib/media/mediaTemporalState) never serves it.
 */
export const LOCATION_DISCLOSURE_END_UNREADABLE = "unreadable";

export interface PostDisclosureLifetimeRow {
  location_privacy_mode?: unknown;
  post_status?: unknown;
  published_at?: unknown;
}

function releasedAtMs(raw: unknown): number {
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw !== "string" || raw === "") return Number.NaN;
  return Date.parse(raw);
}

/**
 * The §11 `locationDisclosureExpiresAt` of a post row, or null when the post
 * has no disclosure lifetime. LOCATION_DISCLOSURE_END_UNREADABLE when it has
 * one whose start cannot be read.
 */
export function postLocationDisclosureExpiresAt(
  row: PostDisclosureLifetimeRow | null | undefined,
): string | null {
  if (row == null) return null;
  if (row.location_privacy_mode !== "delayed_until_exit") return null;
  if (row.post_status !== "published") return null; // unreleased: withheld by the delayed-publish rule already
  const released = releasedAtMs(row.published_at);
  if (!Number.isFinite(released)) return LOCATION_DISCLOSURE_END_UNREADABLE;
  return new Date(released + RELEASED_DELAYED_PLACE_WINDOW_MS).toISOString();
}

/** Has this post's place disclosure to others ended at `nowMs`? */
export function postLocationDisclosureEnded(
  row: PostDisclosureLifetimeRow | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const end = postLocationDisclosureExpiresAt(row);
  if (end == null) return false;
  const t = Date.parse(end);
  if (!Number.isFinite(t)) return true;
  return t <= nowMs;
}

/**
 * Has a disclosure end CARRIED SEPARATELY from its row (a cache entry that
 * stored `postLocationDisclosureExpiresAt(row)` when it read the row) passed at
 * `nowMs`? null ⇒ no lifetime ⇒ false; anything unparseable (the UNREADABLE
 * marker included) ⇒ true; an instant at or before `nowMs` ⇒ true.
 *
 * For readers that cache a row's place decision and serve it later: the
 * decision taken at read time cannot know that the 24-hour window ends inside
 * the cache's lifetime, so the end itself is cached and checked at serve time.
 */
export function locationDisclosureEndPassed(endsAt: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (endsAt == null) return false;
  const t = Date.parse(endsAt);
  if (!Number.isFinite(t)) return true;
  return t <= nowMs;
}

// ── Release timing (verifier F6, 2026-10-07) ─────────────────────────────────
//
// For a "Publish after I leave" post, `published_at` is the instant the
// delayed-publish worker released it — minutes after the author left the place —
// and `publish_eligible_at` / `publish_after_exit` describe that same exit. Told
// to anyone else, they date the author's departure. So no door serves them to
// anyone but the author. (3362 withholds them from the PostgREST client roles, and 3801 updated_at
// too — where applied; production has neither yet, census-media §50.16. This is the API's half.)

/** The posts columns that describe WHEN a delayed post was released. */
export const RELEASE_TIMING_FIELDS = ["published_at", "publish_after_exit", "publish_eligible_at"] as const;

/**
 * `row` as a viewer may receive it: the author gets it unchanged (the same
 * object); anyone else gets the release-timing fields the row carries set to
 * null. Keys the row does not carry are not added.
 */
export function withholdReleaseTiming<T>(row: T, viewerId: string | null | undefined): T {
  if (row == null || typeof row !== "object") return row;
  const r = row as Record<string, unknown>;
  if (typeof viewerId === "string" && viewerId.length > 0 && r.author_id != null && String(r.author_id) === viewerId) return row;
  let out: Record<string, unknown> | null = null;
  for (const k of RELEASE_TIMING_FIELDS) {
    if (k in r && r[k] != null) { out ??= { ...r }; out[k] = null; }
  } if ("updated_at" in r && r.updated_at != null && updatedAtForViewer(r, viewerId) !== r.updated_at) { out ??= { ...r }; out.updated_at = updatedAtForViewer(r, viewerId); } // verifier N2
  return (out ?? row) as T;
}

/**
 * The instant the Wall shows (and orders and pages by) for a post, per viewer.
 * The author: the release instant. Anyone else, for a "Publish after I leave"
 * post — or a row whose mode was not read: its creation instant, never the
 * release. Every other post: the release instant, falling back to creation.
 */
export function wallPublishedAtForViewer(
  row: { author_id?: unknown; location_privacy_mode?: unknown; published_at?: unknown; created_at?: unknown },
  viewerId: string | null | undefined,
): string {
  const isAuthor = typeof viewerId === "string" && viewerId.length > 0 && row.author_id != null && String(row.author_id) === viewerId;
  const modeUnread = !("location_privacy_mode" in row);
  if (!isAuthor && (modeUnread || row.location_privacy_mode === "delayed_until_exit")) {
    return String(row.created_at ?? row.published_at);
  }
  return String(row.published_at ?? row.created_at);
}

// ── `updated_at` (verifier N2, 2026-10-07) ───────────────────────────────────
// Appended at the tail so no cited line above moves.
//
// `posts.updated_at` is set by trg_posts_updated on EVERY update. For a "Publish
// after I leave" post the delayed-publish worker's release UPDATE sets it to the
// release instant, and the geofence-exit UPDATE before that sets it to the exit
// instant. Either one dates the author's departure as well as `published_at`
// does. So a non-author gets the post's creation instant in its place: for a
// delayed_until_exit row, and for a row whose mode was not read (an unread mode
// is not a known-safe mode). Every other post's `updated_at` is an edit time
// and is served as it is.

/** The `updated_at` a viewer may be told for a post row. */
export function updatedAtForViewer(
  row: { author_id?: unknown; location_privacy_mode?: unknown; updated_at?: unknown; created_at?: unknown },
  viewerId: string | null | undefined,
): unknown {
  const isAuthor = typeof viewerId === "string" && viewerId.length > 0 && row.author_id != null && String(row.author_id) === viewerId;
  if (isAuthor) return row.updated_at ?? null;
  const modeUnread = !("location_privacy_mode" in row);
  if (modeUnread || row.location_privacy_mode === "delayed_until_exit") return row.created_at ?? null;
  return row.updated_at ?? null;
}

