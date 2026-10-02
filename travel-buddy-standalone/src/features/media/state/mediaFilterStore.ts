/**
 * features/media — mediaFilterStore (spec §40 `state/mediaFilterStore.ts` · §38
 * Search; census-media §19).
 *
 * The filter state behind Media Search and "Search my world": a pure reducer
 * over the §38 criteria `GET /media/search` accepts, and the one function that
 * turns that state into a request. Nothing else builds the query string, so the
 * client and the server agree on two rules by construction:
 *
 *   • EMPTY MEANS EMPTY. A filter state with no criterion produces NO request
 *     (`toSearchQueryString` → null). The server already refuses to turn a
 *     criteria-free search into a feed; the client does not even ask.
 *   • `scope: 'trip'` WITHOUT a trip is not a criterion, it is a mistake — it
 *     produces no request rather than a doomed one.
 *
 * The §38 example queries map onto these filters as the server can answer them:
 * "Show my Bangkok rooftop photos" is q=rooftop · city=Bangkok · scope=me;
 * "Nightlife that looks social tonight" is category=nightlife · freshOnly;
 * "Show festival media from my Vietnam Trip" is q=festival · scope=trip · tripId.
 *
 * Pure and framework-free — safe for node:test.
 */

export type MediaSearchScope = 'all' | 'me' | 'trip';

export interface MediaSearchFilters {
  q: string;
  scope: MediaSearchScope;
  city: string | null;
  category: string | null;
  tripId: string | null;
  /** Only perspectives inside the fresh window ("right now" / "tonight"). */
  freshOnly: boolean;
  /** §38 "Where was this photo taken?" — one media id resolved to its coarse place. */
  mediaId: string | null; near: boolean; // §38 "near": a bounded radius around a center, sent only as `toSearchNear` builds it (census-media §29)
}

export const INITIAL_MEDIA_FILTERS: MediaSearchFilters = {
  q: '',
  scope: 'all',
  city: null,
  category: null,
  tripId: null,
  freshOnly: false,
  mediaId: null, near: false,
};

/**
 * The category chips the screen offers — the keys MediaPerspectiveService's
 * CATEGORY_LABELS already knows, so a chip never asks for a category the server
 * has no bucket for.
 */
export const SEARCH_CATEGORIES: readonly { key: string; label: string }[] = [
  { key: 'nightlife', label: 'Nightlife' },
  { key: 'food', label: 'Food' },
  { key: 'cafe', label: 'Cafe' },
  { key: 'beach', label: 'Beach' },
  { key: 'nature', label: 'Nature' },
  { key: 'culture', label: 'Culture' },
  { key: 'festival', label: 'Festival' },
  { key: 'shopping', label: 'Shopping' },
];

export type MediaFilterAction =
  | { type: 'set_query'; q: string }
  | { type: 'set_scope'; scope: MediaSearchScope; tripId?: string | null }
  | { type: 'set_city'; city: string | null }
  | { type: 'toggle_category'; category: string }
  | { type: 'toggle_fresh' }
  | { type: 'set_media'; mediaId: string | null } | { type: 'toggle_near' }
  | { type: 'reset'; keepScope?: boolean };

const MAX_TERM = 120;

function clean(s: string | null | undefined): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t.length === 0 ? null : t.slice(0, MAX_TERM);
}

export function mediaFilterReducer(state: MediaSearchFilters, action: MediaFilterAction): MediaSearchFilters {
  switch (action.type) {
    case 'set_query':
      return { ...state, q: action.q.slice(0, MAX_TERM) };
    case 'set_scope':
      return {
        ...state,
        scope: action.scope,
        // A trip id only means something under the trip scope.
        tripId: action.scope === 'trip' ? clean(action.tripId ?? state.tripId) : null,
      };
    case 'set_city':
      return { ...state, city: clean(action.city) };
    case 'toggle_category':
      return { ...state, category: state.category === action.category ? null : action.category };
    case 'toggle_fresh':
      return { ...state, freshOnly: !state.freshOnly };
    case 'set_media':
      return { ...state, mediaId: clean(action.mediaId) };
    case 'reset':
      return action.keepScope
        ? { ...INITIAL_MEDIA_FILTERS, scope: state.scope, tripId: state.tripId }
        : INITIAL_MEDIA_FILTERS;
    default: // 'toggle_near' (census-media §29) is reduced at the file's tail
      return reduceNear(state, action);
  }
}

/** True when the filters carry at least one criterion the server will apply. */
export function hasSearchCriteria(f: MediaSearchFilters): boolean {
  if (f.scope === 'trip' && !f.tripId) return false;
  return (
    clean(f.q) != null ||
    f.city != null ||
    f.category != null ||
    f.freshOnly ||
    f.mediaId != null ||
    f.scope !== 'all'
  );
}

/**
 * The `GET /media/search` query string for these filters, or NULL when there is
 * nothing to ask. The parameter names are exactly the route's: q, city,
 * category, tripId, mediaId, scope, freshOnly.
 */
export function toSearchQueryString(f: MediaSearchFilters): string | null {
  if (!hasSearchCriteria(f)) return null;
  const qs = new URLSearchParams();
  const q = clean(f.q);
  if (q) qs.set('q', q);
  if (f.city) qs.set('city', f.city);
  if (f.category) qs.set('category', f.category);
  if (f.scope !== 'all') qs.set('scope', f.scope);
  if (f.scope === 'trip' && f.tripId) qs.set('tripId', f.tripId);
  if (f.freshOnly) qs.set('freshOnly', 'true');
  if (f.mediaId) qs.set('mediaId', f.mediaId);
  return qs.toString();
}

// ── §38 "near X": a center and a bounded radius (census-media §29, MD288) ─────
//
// Appended at the TAIL so no line census-media cites above moves.
//
// "Near" is not part of the query string. `fetchMediaSearch(q, { near })`
// appends it (census-media §24), and refuses on the device, with no request, a
// `near` the server would refuse. So the store holds only WHETHER "near" is on
// (`near`). From what the screen was handed, `searchNearCenter` says what it is
// near, and `toSearchNear` builds what is sent. Nothing here invents a center:
// with no place and no viewer point there is nothing to be near, the screen
// offers no "near" at all, and no answer is ever shown under a "near" label
// that was not asked with a radius.
//
// The city chip is unchanged: "Near <city>" is still the coarse CITY criterion.

import type { MediaSearchNearParam } from '../services/mediaProjection.ts';

/** How near "near" is: a walkable neighbourhood, inside the server's 100 m – 5 km bound. */
export const MEDIA_SEARCH_NEAR_RADIUS_M = 1_500;

/** Only a canonical place can be a center: the Map positions places by their canonical id. */
const CANONICAL_PLACE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the Search screen was handed that a "near" search can be centred on. */
export interface MediaSearchNearContext {
  /** The canonical place the search was opened from. When present, it is the center. */
  place?: { id: string; label?: string | null } | null;
  /**
   * The viewer's point: the SAME one the World shell hands the Media Map
   * (`useActiveLocation`'s coords, only when its state is ok). Used only when
   * there is no place. Search reads no location of its own.
   */
  viewerPoint?: { lat: number; lng: number } | null;
}

export type MediaSearchNearCenter =
  | { kind: 'place'; placeId: string; label: string | null }
  | { kind: 'viewer'; lat: number; lng: number };

/** The center "near" uses here: the place context, else the viewer's point, else none. */
export function searchNearCenter(ctx: MediaSearchNearContext): MediaSearchNearCenter | null {
  const place = ctx.place;
  if (place && typeof place.id === 'string' && CANONICAL_PLACE_ID_RE.test(place.id)) {
    return { kind: 'place', placeId: place.id, label: clean(place.label ?? null) };
  }
  const p = ctx.viewerPoint;
  if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180) {
    return { kind: 'viewer', lat: p.lat, lng: p.lng };
  }
  return null;
}

/** The `near` to send, or null when "near" is off or has nothing to be centred on. */
export function toSearchNear(
  f: Pick<MediaSearchFilters, 'near'>,
  center: MediaSearchNearCenter | null,
  radiusM: number = MEDIA_SEARCH_NEAR_RADIUS_M,
): MediaSearchNearParam | null {
  if (!f.near || !center) return null;
  return center.kind === 'place' ? { placeId: center.placeId, radiusM } : { lat: center.lat, lng: center.lng, radiusM };
}

/** "1.5 km", "800 m". */
export function nearRadiusLabel(radiusM: number): string {
  if (radiusM < 1000) return `${Math.round(radiusM)} m`;
  const km = radiusM / 1000;
  return `${Number.isInteger(km) ? km : km.toFixed(1)} km`;
}

/** The chip says what it is near and how near: "Near me · 1.5 km". */
export function nearChipLabel(center: MediaSearchNearCenter, radiusM: number = MEDIA_SEARCH_NEAR_RADIUS_M): string {
  const what = center.kind === 'place' ? center.label ?? 'this place' : 'me';
  return `Near ${what} · ${nearRadiusLabel(radiusM)}`;
}

/**
 * The server's `near.refusal === 'center_unpositioned'`: the canonical Map would
 * not place the center, so every list is empty for THAT reason. Said as such —
 * never as "nothing matched", which would claim the area was searched.
 */
export function nearRefusalCopy(center: MediaSearchNearCenter | null): { title: string; message: string } {
  const lead =
    center?.kind === 'place'
      ? `The map has no position for ${center.label ?? 'this place'}, so nothing could be searched near it.`
      : center?.kind === 'viewer'
        ? 'The map could not place where you are, so nothing could be searched near you.'
        : 'The map could not place that center, so nothing could be searched near it.';
  return {
    title: "We can't place that center",
    message: `${lead} That is not the same as there being nothing there.`,
  };
}

function reduceNear(state: MediaSearchFilters, action: MediaFilterAction): MediaSearchFilters {
  return action.type === 'toggle_near' ? { ...state, near: !state.near } : state;
}
