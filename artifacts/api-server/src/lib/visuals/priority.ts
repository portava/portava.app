/**
 * Centralized image priority resolver.
 *
 * ONE place decides which image an entity actually shows. Every card/detail screen
 * must consume this (or the normalized API field derived from it) instead of
 * re-implementing the ladder. Mirrors the client resolver in travel-buddy.
 *
 * Priority (highest first):
 *   1. user_upload      — a manually selected image always wins
 *   2. official         — verified official venue/event image
 *   3. provider         — trusted external provider photo
 *   4. portava_media    — approved existing Portava media tied to the entity
 *   5. ai_generated     — AI header/representation
 *   6. category_fallback— static branded fallback
 */
import type { ImageSource, ResolvedHeaderImage } from "./types.js";

const RANK: Record<ImageSource, number> = {
  user_upload: 6,
  official: 5,
  provider: 4,
  portava_media: 3,
  ai_generated: 2,
  category_fallback: 1,
};

export function sourceRank(s: ImageSource): number {
  return RANK[s] ?? 0;
}

/** A candidate image from some source. url null/empty means "not available". */
export interface HeaderCandidate {
  url: string | null | undefined;
  source: ImageSource;
  attribution?: string;
  generatedVisualId?: string;
}

/**
 * Resolve the winning header image from all available candidates. AI place images
 * are flagged isRepresentation so the UI can show the "AI-generated representation"
 * label. Returns null only if literally nothing (not even a fallback) is available.
 */
export function resolveHeaderImage(
  candidates: HeaderCandidate[],
  opts: { entityType?: string } = {},
): ResolvedHeaderImage | null {
  const usable = candidates.filter((c) => typeof c.url === "string" && c.url.trim() !== "");
  if (usable.length === 0) return null;
  usable.sort((a, b) => sourceRank(b.source) - sourceRank(a.source));
  const win = usable[0];
  const isPlace = opts.entityType === "place";
  return {
    url: win.url as string,
    source: win.source,
    attribution: win.attribution,
    generatedVisualId: win.generatedVisualId,
    isRepresentation: win.source === "ai_generated" && isPlace,
  };
}

/**
 * Guard for the async worker: may a freshly generated AI image be applied to the
 * entity? Only if nothing higher-priority arrived while it was generating, and the
 * entity's current image isn't newer than when generation started.
 */
export function mayApplyGenerated(current: {
  source?: ImageSource | null;
  updatedAt?: string | null;
}, generationStartedAt: string): boolean {
  // A higher-or-equal priority real source already present → do not overwrite.
  if (current.source && sourceRank(current.source) > sourceRank("ai_generated")) return false;
  // The entity image changed after we started generating → a newer upload won.
  if (current.updatedAt && current.updatedAt > generationStartedAt) return false;
  return true;
}
