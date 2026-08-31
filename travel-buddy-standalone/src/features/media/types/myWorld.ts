/**
 * features/media — My World (owner library) projection types (spec §29/§30/§31).
 *
 * The owner's own library and personal experience history, organized into
 * buckets (All · Posts · Postcards · Memories · Trips · Tagged · Hidden Gems)
 * plus owner-only operational buckets (Drafts · Archived · Uploads · Processing).
 * Passport remains the primary Postcard surface — this lens does not duplicate
 * the full Passport media product (§29).
 *
 * The projection also carries the §31 / §31.1 Memory Integration surface: the
 * owner's derived memory groupings and Hidden Gem Memory lines. That surface is
 * OWNER-ONLY and private — every entry is `visibility: 'owner_only'`, it is read
 * from the viewer's OWN activity, and it is never shown on a public profile or
 * anyone else's My World.
 *
 * Pure type module — no runtime imports.
 */
import type { MediaProjection } from './media.ts';

/** One collection of the owner's media (§30). */
export interface MyWorldBucket {
  /** Stable key, e.g. 'all' | 'posts' | 'trips' | 'drafts' | 'gems'. */
  key: string;
  label: string;
  /** True for operational buckets only the owner may see (drafts/archived/processing). */
  ownerOnly: boolean;
  /** Total items in the bucket (may exceed `media.length`, which is a bounded sample). */
  count: number;
  media: MediaProjection[];
}

// ── §31 / §31.1 Memory Integration (owner-only) ──────────────────────────────

/**
 * One derived memory entry within a §31 group. Owner-only, always — it is read
 * from the viewer's own activity and is never surfaced to anyone else.
 */
export interface MyWorldMemoryEntry {
  /** Stable, namespaced client id. */
  id: string;
  /** The §31 group key this entry belongs to (kept open for forward-compat). */
  group: string;
  /** Short headline for the entry (usually the group label). */
  title: string;
  /** The specific place / vibe / item this entry is about, when known. */
  detail: string | null;
  /** When it happened, best-effort; null when the source has no date. */
  occurredAt: string | null;
  /** Owner-only, always. */
  visibility: 'owner_only';
}

/** A §31 memory group with its entries (e.g. "Returned to Place"). */
export interface MyWorldMemoryGroup {
  group: string;
  label: string;
  description: string;
  entries: MyWorldMemoryEntry[];
}

/** One §31.1 Hidden Gem Memory line (e.g. "You discovered this Gem."). */
export interface HiddenGemMemoryLine {
  gemId: string;
  /** The gem's name, when known; null when it is not readable. */
  gemName: string | null;
  /** The line kind, e.g. 'discovered' | 'early_contributor' (open for forward-compat). */
  kind: string;
  /** The human line, e.g. "You visited before it became popular." */
  label: string;
  occurredAt: string | null;
  visibility: 'owner_only';
}

/**
 * §31 / §31.1 owner-only Memory Integration surface. Private to the viewer —
 * derived from what they did, never a second memory store, and never public.
 */
export interface MyWorldMemory {
  visibility: 'owner_only';
  groups: MyWorldMemoryGroup[];
  hiddenGemMemory: HiddenGemMemoryLine[];
  /** Observable proof of the boundary: how many entries the deny gate removed. */
  totals: { surfaced: number; suppressed: number };
  /** Human-readable privacy notes from the backend, best-effort. */
  notes: string[];
}

/** The full My World projection (GET /media/me, §43). */
export interface MyWorldLibrary {
  buckets: MyWorldBucket[];
  /** §31 / §31.1 owner-only memory surface (always well-formed, may be empty). */
  memory: MyWorldMemory;
  generatedAt: string | null;
}
