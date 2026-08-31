/**
 * features/media — contextual perspective-viewer model (spec §14).
 *
 * The §14 Media Viewer is CONTEXTUAL, not a TikTok-style vertical stranger feed
 * (§46.2). When a user taps a perspective in a place/experience mosaic, the
 * "collection" the viewer navigates is scoped to the ENTRY CONTEXT — the other
 * perspectives of that same entity (a Place's other perspectives when opened
 * from a Place, an Event's when opened from an Event, …) — and NEVER a global
 * engagement-ranked feed. The §14 entry-context swipe collections are:
 *   Place → other perspectives from that Place
 *   Event → other Event perspectives
 *   People → that person / social context
 *   Trip → Trip media
 *   Map → current geographic cluster
 *
 * This module is the PURE, framework-free core of that behaviour so it is unit
 * testable and can never crash on a partial / absent / mixed payload:
 *   • buildPerspectiveCollection — scopes candidate media to the entry context,
 *     groups it by the entity's perspective groups, and EXCLUDES anything that
 *     does not belong (foreign-entity media, media outside the entity's groups);
 *   • the navigation helpers — derive the active perspective, the related-
 *     perspective strip, and safe index math for the pager and the group jumps.
 *
 * No react-native / no service imports — safe to import from a node:test suite.
 */
import type { MediaProjection } from '../types/media.ts';
import type { PerspectiveGroup } from '../types/perspective.ts';

/** §14 entry-context kinds (the entity whose perspectives are being navigated). */
export type PerspectiveEntryContextKind =
  | 'place'
  | 'experience'
  | 'event'
  | 'people'
  | 'trip'
  | 'map';

/** Raw inputs handed by the mosaic that opened the viewer (already fetched). */
export interface BuildPerspectiveCollectionInput {
  kind: PerspectiveEntryContextKind;
  /** Canonical id of the entity (Place / Event / Trip / …), when known. */
  entityId?: string | null;
  /** Display label for the entity header ("An Thuong"). */
  entityLabel?: string | null;
  /** The entity's perspective groups (Street · Entrance · Rooftop · …). */
  groups?: PerspectiveGroup[] | null;
  /** Candidate media (each already stamped with its perspectiveKey server-side). */
  media: MediaProjection[];
}

/** A resolved, entry-context-scoped collection ready to navigate. */
export interface PerspectiveCollection {
  kind: PerspectiveEntryContextKind;
  entityId: string | null;
  entityLabel: string | null;
  /** Ordered, unique perspective groups that actually carry media. */
  groups: PerspectiveGroup[];
  /** Ordered media scoped to the entry context (group order, server order within). */
  items: MediaProjection[];
  /**
   * True when a group scope resolved so the RELATED PERSPECTIVES strip is
   * meaningful. False in the degrade path (no groups) where the viewer still
   * pages the entity's media as one flat collection.
   */
  grouped: boolean;
}

/** One chip in the §14 RELATED PERSPECTIVES strip. */
export interface RelatedPerspective {
  key: string;
  label: string;
  count: number;
  /** True when this is the group of the currently-shown media. */
  active: boolean;
  /** Index in `collection.items` to jump to when the chip is tapped. */
  index: number;
  cover: MediaProjection | null;
}

// ── Entry-context scoping ─────────────────────────────────────────────────────

/**
 * Whether a media item belongs to the entry-context entity.
 *
 * For a Place (and Place-shaped) context, a media item that is explicitly
 * tagged to a DIFFERENT canonical place is foreign and must be excluded — the
 * viewer is that place's current picture, not a global feed (§46.2). Media with
 * no place id, or a matching id, is kept. For entry contexts whose media
 * legitimately spans places (experience / trip / map), no place filter applies.
 */
function belongsToEntity(
  kind: PerspectiveEntryContextKind,
  entityId: string | null,
  m: MediaProjection,
): boolean {
  if (kind !== 'place') return true;
  if (!entityId) return true;
  const placeId = m.place?.id ?? null;
  if (placeId == null) return true; // unlabeled — cannot prove it is foreign
  return placeId === entityId;
}

function isRenderableMedia(m: unknown): m is MediaProjection {
  return !!m && typeof m === 'object' && typeof (m as MediaProjection).id === 'string' && (m as MediaProjection).id !== '';
}

/**
 * Build the entry-context-scoped, grouped collection for the contextual viewer.
 *
 * Never throws and always returns a well-formed collection (possibly empty) so
 * the viewer degrades to a clean empty state rather than crashing (§33/§39):
 *   • drops empty-id and foreign-entity media (the "excludes unrelated" scope);
 *   • buckets the remainder by the entity's perspective groups, in group order;
 *   • drops groups that ended up with no media (an un-navigable chip is a lie);
 *   • when NO group scope resolves (missing / unmatched groups), degrades to a
 *     single flat collection of the scoped media with an empty related strip.
 */
export function buildPerspectiveCollection(
  input: BuildPerspectiveCollectionInput,
): PerspectiveCollection {
  const kind = input.kind;
  const entityId = input.entityId ?? null;
  const entityLabel = input.entityLabel ?? null;

  // 1. Scope: renderable media that belongs to the entry-context entity.
  const scoped = (Array.isArray(input.media) ? input.media : [])
    .filter(isRenderableMedia)
    .filter((m) => belongsToEntity(kind, entityId, m));

  // 2. Ordered, unique group keys from the provided groups.
  const groupOrder: string[] = [];
  const groupByKey = new Map<string, PerspectiveGroup>();
  for (const g of Array.isArray(input.groups) ? input.groups : []) {
    if (!g || typeof g.key !== 'string' || g.key === '' || groupByKey.has(g.key)) continue;
    groupByKey.set(g.key, g);
    groupOrder.push(g.key);
  }

  // 3. Bucket scoped media by its perspectiveKey against the known groups.
  const buckets = new Map<string, MediaProjection[]>();
  for (const m of scoped) {
    const key = m.perspectiveKey ?? null;
    if (key == null || !groupByKey.has(key)) continue; // unrelated to any known group
    const arr = buckets.get(key);
    if (arr) arr.push(m);
    else buckets.set(key, [m]);
  }

  // 4. Grouped path: order items by group order, keep only non-empty groups.
  if (buckets.size > 0) {
    const items: MediaProjection[] = [];
    const groups: PerspectiveGroup[] = [];
    for (const key of groupOrder) {
      const arr = buckets.get(key);
      if (!arr || arr.length === 0) continue;
      const src = groupByKey.get(key)!;
      groups.push({
        key,
        label: src.label,
        // Prefer the server's fresh count; fall back to the loaded media count.
        count: typeof src.count === 'number' && src.count > 0 ? src.count : arr.length,
        cover: src.cover ?? arr[0] ?? null,
      });
      for (const m of arr) items.push(m);
    }
    return { kind, entityId, entityLabel, groups, items, grouped: true };
  }

  // 5. Degrade: no group scope resolved → one flat, un-grouped collection.
  return { kind, entityId, entityLabel, groups: [], items: scoped, grouped: false };
}

// ── Navigation helpers (pure index math; never throw / never go out of range) ─

/** True when the collection has nothing to show — the viewer shows an empty state. */
export function isEmptyCollection(c: PerspectiveCollection | null | undefined): boolean {
  return !c || c.items.length === 0;
}

/** Clamp an arbitrary index into a valid [0, len-1] slot (0 for an empty list). */
export function clampIndex(c: PerspectiveCollection, index: number): number {
  if (c.items.length === 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(0, Math.floor(index)), c.items.length - 1);
}

/** Index of a media id in the collection, or -1 when absent. */
export function indexOfMedia(
  c: PerspectiveCollection,
  mediaId: string | null | undefined,
): number {
  if (!mediaId) return -1;
  return c.items.findIndex((m) => m.id === mediaId);
}

/**
 * The index the viewer should open at for the tapped media. Falls back to 0
 * (the entity's first perspective) when the media is absent, so a stale /
 * excluded / deep-linked id opens the current picture rather than a blank pager.
 */
export function initialIndexForMedia(
  c: PerspectiveCollection,
  mediaId: string | null | undefined,
): number {
  const i = indexOfMedia(c, mediaId);
  return i === -1 ? 0 : i;
}

/** Move `delta` items through the collection, clamped to the ends (no wrap). */
export function stepIndex(c: PerspectiveCollection, index: number, delta: number): number {
  return clampIndex(c, clampIndex(c, index) + delta);
}

/** The perspective-group key of the media at `index`, or null when ungrouped. */
export function activeGroupKeyAt(c: PerspectiveCollection, index: number): string | null {
  const m = c.items[clampIndex(c, index)];
  return m?.perspectiveKey ?? null;
}

/** Display label for a group key, or null when unknown. */
export function groupLabelFor(c: PerspectiveCollection, key: string | null | undefined): string | null {
  if (!key) return null;
  return c.groups.find((g) => g.key === key)?.label ?? null;
}

/** First item index belonging to a group, or -1 when the group has no items. */
export function firstIndexOfGroup(c: PerspectiveCollection, key: string | null | undefined): number {
  if (!key) return -1;
  return c.items.findIndex((m) => (m.perspectiveKey ?? null) === key);
}

/**
 * The §14 RELATED PERSPECTIVES strip for the media at `activeIndex`: every group
 * of the entity (including the active one, which reads as selected), each with
 * the index the viewer jumps to when its chip is tapped.
 */
export function relatedPerspectives(
  c: PerspectiveCollection,
  activeIndex: number,
): RelatedPerspective[] {
  const activeKey = activeGroupKeyAt(c, activeIndex);
  return c.groups.map((g) => {
    const idx = firstIndexOfGroup(c, g.key);
    return {
      key: g.key,
      label: g.label,
      count: g.count,
      active: g.key === activeKey,
      index: idx === -1 ? 0 : idx,
      cover: g.cover ?? null,
    };
  });
}
