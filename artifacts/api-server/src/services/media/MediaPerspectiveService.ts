/**
 * MediaPerspectiveService (§41) — groups coarse MediaProjections into the
 * "perspective" primitive the World shell renders (§12/§13).
 *
 * A perspective is a permitted visual contribution showing an aspect of a place
 * or experience. There is no perspective COLUMN in the schema today (the audit
 * confirms the perspective primitive is net-new), so this service derives a
 * perspective bucket from the only honest signals a media row already carries:
 * its `category` (nightlife / food / …) and place. It NEVER invents a specific
 * physical vantage ("Rooftop", "Entrance") that the data does not support — an
 * ungrouped item lands in a truthful `general` bucket.
 *
 * This is a PURE aggregator over already-projected, already-eligible items — no
 * DB, no network — so it unit-tests trivially and cannot itself leak anything
 * the projector did not already coarsen.
 */

import type { MediaProjection } from "../../lib/media/mediaProjection.js";
import { aggregateFreshness, countFresh, type FreshnessState } from "../../lib/media/mediaFreshness.js";

export interface PerspectiveGroup {
  /** Stable bucket key derived from the media category (or 'general'). */
  key: string;
  /** Human label for the bucket. */
  label: string;
  perspectiveCount: number;
  /** How many of those perspectives are fresh (< 1h). */
  freshCount: number;
  freshness: FreshnessState;
  /** Distinct contributors in this group. */
  contributorCount: number;
  /** Newest-first sample of the group's media (bounded). */
  media: MediaProjection[];
}

export interface PerspectiveSummary {
  totalPerspectives: number;
  freshPerspectives: number;
  contributorCount: number;
  /** Distinct contributors AND distinct source variety — §12 "3 independent sources". */
  independentSourceCount: number;
  freshness: FreshnessState;
  groups: PerspectiveGroup[];
}

const CATEGORY_LABELS: Record<string, string> = {
  nightlife: "Nightlife",
  food: "Food",
  restaurant: "Food",
  cafe: "Cafe",
  beach: "Beach",
  nature: "Nature",
  culture: "Culture",
  shopping: "Shopping",
  nightclub: "Nightclub",
  bar: "Bar",
  festival: "Festival",
  event: "Event",
  general: "All",
};

function labelFor(key: string): string {
  return CATEGORY_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

function bucketKey(p: MediaProjection): string {
  const c = (p.category ?? "").trim().toLowerCase();
  return c.length > 0 ? c : "general";
}

/**
 * Group projected media into perspective groups + a summary, newest-first,
 * capping the sample media per group. Empty input yields a well-formed empty
 * summary (`totalPerspectives: 0`, `freshness: 'none'`) — never an error.
 */
export function buildPerspectiveSummary(
  media: MediaProjection[],
  nowMs: number,
  opts: { samplePerGroup?: number } = {},
): PerspectiveSummary {
  const samplePerGroup = opts.samplePerGroup ?? 12;

  const byKey = new Map<string, MediaProjection[]>();
  for (const m of media) {
    const k = bucketKey(m);
    const list = byKey.get(k) ?? [];
    list.push(m);
    byKey.set(k, list);
  }

  const groups: PerspectiveGroup[] = [];
  for (const [key, items] of byKey.entries()) {
    const sorted = [...items].sort(
      (a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime(),
    );
    const capturedAts = sorted.map((m) => m.capturedAt);
    const contributors = new Set(sorted.map((m) => m.contributor?.id).filter(Boolean));
    groups.push({
      key,
      label: labelFor(key),
      perspectiveCount: sorted.length,
      freshCount: countFresh(capturedAts, nowMs),
      freshness: aggregateFreshness(capturedAts, nowMs),
      contributorCount: contributors.size,
      media: sorted.slice(0, samplePerGroup),
    });
  }

  // Largest groups first; ties broken by freshest.
  groups.sort((a, b) => {
    if (b.perspectiveCount !== a.perspectiveCount) return b.perspectiveCount - a.perspectiveCount;
    return b.freshCount - a.freshCount;
  });

  const allCapturedAts = media.map((m) => m.capturedAt);
  const contributors = new Set(media.map((m) => m.contributor?.id).filter(Boolean));

  return {
    totalPerspectives: media.length,
    freshPerspectives: countFresh(allCapturedAts, nowMs),
    contributorCount: contributors.size,
    // "Independent sources" is a coarser, honest proxy: the number of distinct
    // contributors is the ceiling on independence. We do not overstate it.
    independentSourceCount: contributors.size,
    freshness: aggregateFreshness(allCapturedAts, nowMs),
    groups,
  };
}

/** The category-count buckets for the World "FOR YOU NOW" list (§4.1). */
export interface CategoryBucket {
  category: string;
  label: string;
  freshPerspectives: number;
  totalPerspectives: number;
}

export function buildCategoryBuckets(media: MediaProjection[], nowMs: number): CategoryBucket[] {
  const byKey = new Map<string, MediaProjection[]>();
  for (const m of media) {
    const k = bucketKey(m);
    const list = byKey.get(k) ?? [];
    list.push(m);
    byKey.set(k, list);
  }
  const buckets: CategoryBucket[] = [];
  for (const [key, items] of byKey.entries()) {
    const capturedAts = items.map((m) => m.capturedAt);
    buckets.push({
      category: key,
      label: labelFor(key),
      freshPerspectives: countFresh(capturedAts, nowMs),
      totalPerspectives: items.length,
    });
  }
  buckets.sort((a, b) => {
    if (b.freshPerspectives !== a.freshPerspectives) return b.freshPerspectives - a.freshPerspectives;
    return b.totalPerspectives - a.totalPerspectives;
  });
  return buckets;
}
