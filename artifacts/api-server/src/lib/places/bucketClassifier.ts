/**
 * bucketClassifier — classify a post into one or more coverage bucket types.
 *
 * Each bucket represents a content niche that a place may have gaps in.
 * A post can match multiple buckets (e.g. a drone shot at sunrise matches
 * both "drone" and "sunrise").
 *
 * Pure function — no DB, no side effects.
 */

// ── Bucket type ───────────────────────────────────────────────────────────────

export type BucketType =
  | "drone"
  | "night"
  | "sunrise"
  | "underwater"
  | "adventure"
  | "food_nearby"
  | "hidden_angles"
  | "tips"
  | "rainy_season"
  | "festival";

export const ALL_BUCKET_TYPES: BucketType[] = [
  "drone",
  "night",
  "sunrise",
  "underwater",
  "adventure",
  "food_nearby",
  "hidden_angles",
  "tips",
  "rainy_season",
  "festival",
];

// ── Keyword maps (per bucket) ─────────────────────────────────────────────────

/** Each bucket's keyword signals — checked against lowercased tokens. */
const BUCKET_KEYWORDS: Record<BucketType, readonly string[]> = {
  drone: [
    "drone", "aerial", "dji", "fpv", "birdseye", "bird's eye", "bird eye",
    "above", "flyover", "fly over", "overhead", "quadcopter", "uav",
  ],
  night: [
    "night", "midnight", "nighttime", "dark", "after dark", "nightlife",
    "stars", "starry", "galaxy", "long exposure", "light trail",
    "city lights", "neon", "low light", "moonlight", "moon",
  ],
  sunrise: [
    "sunrise", "sunset", "golden hour", "golden ratio", "dusk", "dawn",
    "first light", "last light", "magic hour", "blue hour", "sundown",
    "sunup", "morning light", "evening light",
  ],
  underwater: [
    "underwater", "diving", "dive", "snorkel", "snorkeling", "scuba",
    "reef", "coral", "freedive", "freediving", "ocean floor", "beneath the surface",
    "sub surface", "subsurface",
  ],
  adventure: [
    "adventure", "hiking", "hike", "trek", "trekking", "climbing", "cliff",
    "rappel", "abseil", "kayak", "rafting", "bungee", "paraglide", "paragliding",
    "canyoning", "zipline", "zip line", "extreme", "offroad", "off-road",
  ],
  food_nearby: [
    "food", "eat", "restaurant", "cafe", "coffee", "brunch", "lunch", "dinner",
    "breakfast", "street food", "local food", "cuisine", "foodie", "menu",
    "dessert", "snack", "market", "bakery", "bar", "drink",
  ],
  hidden_angles: [
    "hidden", "secret", "lesser known", "off the beaten", "hidden gem",
    "local secret", "underrated", "undiscovered", "angles", "perspective",
    "unique angle", "behind", "inside view", "overlooked",
  ],
  tips: [
    "tip", "tips", "advice", "guide", "how to", "must know", "what to know",
    "best time", "avoid", "don't miss", "pro tip", "hack", "local tip",
    "insider", "recommendation", "recommended", "things to know",
  ],
  rainy_season: [
    "rain", "rainy", "monsoon", "wet season", "storm", "cloudy", "fog",
    "foggy", "mist", "misty", "overcast", "drizzle", "shower",
    "rainy season", "grey day", "gray day",
  ],
  festival: [
    "festival", "carnival", "celebration", "parade", "event", "ceremony",
    "fiesta", "fete", "lantern", "fireworks", "new year", "christmas",
    "holiday", "fair", "concert", "street party", "local festival",
    "cultural event",
  ],
};

// ── Tokenizer ─────────────────────────────────────────────────────────────────

/**
 * Produce a lowercased, whitespace-normalised string combining all textual
 * signals for a post.  Keeps punctuation so multi-word phrases can still
 * appear (e.g. "golden hour").
 */
function buildSearchText(post: ClassifyInput): string {
  const parts: string[] = [];
  if (post.caption)   parts.push(post.caption);
  if (post.category)  parts.push(post.category);
  if (Array.isArray(post.tags)) parts.push(...post.tags);
  if (post.metadata && typeof post.metadata === "object") {
    const m = post.metadata as Record<string, unknown>;
    if (typeof m.description === "string") parts.push(m.description);
    if (Array.isArray(m.keywords)) parts.push(...m.keywords.map(String));
  }
  return parts.join(" ").toLowerCase();
}

// ── Public input type ─────────────────────────────────────────────────────────

export interface ClassifyInput {
  /** Hashtags / user-applied tags. */
  tags?: string[] | null;
  /** Free-text caption. */
  caption?: string | null;
  /** Editorial category (e.g. "adventure", "food"). */
  category?: string | null;
  /** Any additional structured metadata (keywords, description, …). */
  metadata?: Record<string, unknown> | null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Classify a post into zero or more coverage bucket types.
 *
 * Uses keyword matching on the combined lowercase text of tags, caption,
 * category, and metadata.  A post may match multiple buckets.
 *
 * Returns an empty array when no bucket keywords match.
 */
export function classifyBuckets(post: ClassifyInput): BucketType[] {
  const text = buildSearchText(post);
  if (!text.trim()) return [];

  const matched: BucketType[] = [];

  for (const bucket of ALL_BUCKET_TYPES) {
    const keywords = BUCKET_KEYWORDS[bucket];
    for (const kw of keywords) {
      if (text.includes(kw)) {
        matched.push(bucket);
        break; // one keyword per bucket is enough
      }
    }
  }

  return matched;
}

// ── DB upsert helper ──────────────────────────────────────────────────────────

/**
 * Idempotent, concurrent-safe bucket count increment.
 *
 * Processes each bucket independently so partial failures are retryable:
 *
 *  For each bucket:
 *   a. Insert one row into `post_bucket_ledger` ON CONFLICT DO NOTHING.
 *      If the row already exists the bucket was already counted — skip.
 *   b. Call `increment_bucket_count()` RPC, which is an atomic
 *      `ON CONFLICT DO UPDATE post_count + 1` — no fetch-then-write race.
 *   c. If the RPC fails, delete the ledger row so the next retry
 *      sees this bucket as unprocessed and can try again.
 *
 * Returns false as soon as any bucket fails (caller leaves
 * `bucket_classified = false` so the backfill worker retries).
 * Already-succeeded buckets in the same call are not undone.
 */
export async function incrementBucketCounts(
  db: any,
  postId: string,
  canonicalPlaceId: string,
  buckets: BucketType[],
  postedAt: string,
): Promise<boolean> {
  if (buckets.length === 0) return true;

  try {
    for (const bucket of buckets) {
      // ── a. Insert ledger row (ON CONFLICT DO NOTHING) ─────────────────────
      const { data: inserted, error: ledgerErr } = await db
        .from("post_bucket_ledger")
        .insert(
          { post_id: postId, canonical_place_id: canonicalPlaceId, bucket },
          { ignoreDuplicates: true },
        )
        .select("bucket");

      if (ledgerErr) return false;

      const isNew = Array.isArray(inserted) && inserted.length > 0;
      if (!isNew) continue; // already counted — move to next bucket

      // ── b. Atomically increment place_coverage_buckets ────────────────────
      const { error: rpcErr } = await db.rpc("increment_bucket_count", {
        p_canonical_place_id: canonicalPlaceId,
        p_bucket:             bucket,
        p_last_post_at:       postedAt,
      });

      if (rpcErr) {
        // ── c. Roll back the ledger row so next retry can re-attempt ────────
        // Best-effort: ignore errors from the delete itself.
        await db
          .from("post_bucket_ledger")
          .delete()
          .eq("post_id", postId)
          .eq("bucket", bucket);

        return false; // signal partial failure; caller should not mark classified
      }
    }

    return true;
  } catch {
    return false;
  }
}
