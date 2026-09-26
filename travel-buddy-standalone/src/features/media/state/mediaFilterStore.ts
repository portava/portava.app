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
  mediaId: string | null;
}

export const INITIAL_MEDIA_FILTERS: MediaSearchFilters = {
  q: '',
  scope: 'all',
  city: null,
  category: null,
  tripId: null,
  freshOnly: false,
  mediaId: null,
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
  | { type: 'set_media'; mediaId: string | null }
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
    default:
      return state;
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
