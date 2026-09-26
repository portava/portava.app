/**
 * features/media — the §7 CONTEXT GRAPH of one media item, as the MediaContextSheet
 * shows it (spec §7 / §40 `MediaContextSheet.tsx`; census-media §19, MD314).
 *
 *   MediaAsset ├─ Person ├─ Place ├─ Neighborhood ├─ Event ├─ Trip
 *              ├─ Hidden Gem ├─ Shared Moment ├─ Time └─ Observation
 *
 * §7 closes with "Context resolution is server-side", and this module keeps it
 * that way: every edge comes from what the server already resolved and gated —
 * the projection the viewer is holding (Person, Place, Time) and the
 * `entityRefs` of `GET /media/:id/actions` (Place, Trip, Hidden Gem, Shared
 * Moment), each emitted there only when the viewer may see it. The Event edge
 * comes from the §14 entry context the viewer was opened with, when that was an
 * Event. The client derives NO edge, and an edge the server did not send is
 * simply absent — including Observation, which no projection carries today
 * (census MD53), so the sheet never draws one.
 *
 * `mapContextRefs` exists because the action rail's mapper
 * (`services/mediaActions.mapMediaActionSet`) narrows kinds to
 * media | place | trip | gem and relabels anything else — the §28 Shared Moment
 * edge the server resolves arrives as `shared_moment` and would be misfiled.
 * This mapper keeps the §7 kind set whole and DROPS an unknown kind rather than
 * relabelling it.
 *
 * Pure — safe for node:test.
 */
import type { MediaProjection } from '../types/media.ts';
import type { PerspectiveEntryContextKind } from './perspectiveViewer.ts';

export type ContextEdgeKind =
  | 'person'
  | 'place'
  | 'event'
  | 'trip'
  | 'hidden_gem'
  | 'shared_moment'
  | 'time';

export interface ContextEdge {
  kind: ContextEdgeKind;
  /** Canonical id the edge points at, when it has one (Time has none). */
  id: string | null;
  label: string;
  /** Where tapping the edge goes, or null when it is informational. */
  href: string | null;
}

/** One `entityRefs` entry as the server serves it (the full §7 graph kinds). */
export interface ContextRef {
  kind: 'place' | 'trip' | 'gem' | 'shared_moment';
  id: string;
  label: string | null;
}

const REF_KINDS: ReadonlySet<string> = new Set(['place', 'trip', 'gem', 'shared_moment']);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The `entityRefs` of a `GET /media/:id/actions` body. `media` and unknown kinds are dropped. */
export function mapContextRefs(raw: unknown): ContextRef[] {
  const o = isObj(raw) ? raw : {};
  const out: ContextRef[] = [];
  for (const r of Array.isArray(o.entityRefs) ? o.entityRefs : []) {
    if (!isObj(r)) continue;
    const kind = typeof r.kind === 'string' ? r.kind : '';
    const id = typeof r.id === 'string' && r.id ? r.id : null;
    if (!id || !REF_KINDS.has(kind)) continue;
    out.push({ kind: kind as ContextRef['kind'], id, label: typeof r.label === 'string' && r.label ? r.label : null });
  }
  return out;
}

/** "3 Sep, 21:40" — the capture time, never a relative "live" phrase. */
export function captureTimeLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}

export interface ContextGraphInput {
  media: MediaProjection;
  refs: readonly ContextRef[];
  /** The §14 entry context the viewer was opened with. */
  entry?: { kind: PerspectiveEntryContextKind; entityId: string | null; entityLabel: string | null } | null;
}

/**
 * The ordered §7 edges for one media item. Order follows §7's own list. Each
 * kind appears at most once; a server ref wins over the projection's own place
 * (the ref went through the location choke point for THIS viewer).
 */
export function buildContextGraph({ media, refs, entry }: ContextGraphInput): ContextEdge[] {
  const edges: ContextEdge[] = [];
  const c = media.contributor ?? null;
  if (c && c.id) {
    const handle = c.username ? `@${c.username}` : null;
    edges.push({
      kind: 'person',
      id: c.id,
      label: handle ?? c.displayName,
      href: c.username ? `/u/${encodeURIComponent(c.username)}` : null,
    });
  }

  const placeRef = refs.find((r) => r.kind === 'place') ?? null;
  const placeId = placeRef?.id ?? media.place?.id ?? null;
  const placeLabel = placeRef?.label ?? media.place?.name ?? null;
  if (placeId && placeLabel) {
    edges.push({ kind: 'place', id: placeId, label: placeLabel, href: `/place/${encodeURIComponent(placeId)}` });
  }

  if (entry && entry.kind === 'event' && entry.entityId) {
    edges.push({
      kind: 'event',
      id: entry.entityId,
      label: entry.entityLabel ?? 'This event',
      href: `/event/${encodeURIComponent(entry.entityId)}`,
    });
  }

  const tripRef = refs.find((r) => r.kind === 'trip');
  if (tripRef) {
    edges.push({ kind: 'trip', id: tripRef.id, label: tripRef.label ?? 'A trip', href: `/trip/${encodeURIComponent(tripRef.id)}` });
  }

  const gemRef = refs.find((r) => r.kind === 'gem');
  if (gemRef) {
    edges.push({ kind: 'hidden_gem', id: gemRef.id, label: gemRef.label ?? 'Hidden gem', href: `/gems/${encodeURIComponent(gemRef.id)}` });
  }

  const momentRef = refs.find((r) => r.kind === 'shared_moment');
  if (momentRef) {
    edges.push({
      kind: 'shared_moment',
      id: momentRef.id,
      label: momentRef.label ?? 'A shared moment',
      href: `/shared-moments/${encodeURIComponent(momentRef.id)}`,
    });
  }

  const when = captureTimeLabel(media.capturedAt);
  if (when) edges.push({ kind: 'time', id: null, label: when, href: null });

  return edges;
}

export const CONTEXT_EDGE_LABEL: Record<ContextEdgeKind, string> = {
  person: 'Captured by',
  place: 'Place',
  event: 'Event',
  trip: 'Trip',
  hidden_gem: 'Hidden gem',
  shared_moment: 'Shared moment',
  time: 'Captured',
};

/** §38 "Where was this photo taken?" — the search that answers it for this item. */
export function whereTakenHref(mediaId: string): string {
  return `/media-search?mediaId=${encodeURIComponent(mediaId)}`;
}
