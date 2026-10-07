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
