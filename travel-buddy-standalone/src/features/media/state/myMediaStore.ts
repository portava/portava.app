/**
 * features/media — myMediaStore (spec §40 `state/myMediaStore.ts` · §30 My World;
 * census-media §19).
 *
 * The owner's My World navigation state, which used to be a `useState` inside
 * MyWorldMediaScreen: which §30 collection is selected, and whether "Search my
 * world" is open. Plus the pure selectors the screen and its Map mode share:
 *
 *   • orderedBuckets — the §30 order (All · Posts · Postcards · Memories · Trips
 *     · Tagged · Hidden Gems, then the owner-only Drafts · Archived · Uploads ·
 *     Processing), anything unknown after, in server order;
 *   • activeBucket — the selection, falling back to the first bucket when the
 *     selected one is not in this payload (never a phantom selection);
 *   • mapMediaOf — the media My World's MAP places: the owner's published and
 *     tagged media, de-duplicated. The owner-only operational buckets (drafts,
 *     archived, uploads, processing) are NOT placed on a map of where the owner
 *     has been — a draft is not somewhere they went.
 *
 * Pure — safe for node:test.
 */
import type { MediaProjection } from '../types/media.ts';
import type { MyWorldBucket } from '../types/myWorld.ts';

export const MY_WORLD_BUCKET_ORDER: readonly string[] = [
  'all',
  'posts',
  'postcards',
  'memories',
  'trips',
  'tagged',
  'gems',
  'drafts',
  'archived',
  'uploads',
  'processing',
];

export function orderedBuckets(buckets: readonly MyWorldBucket[]): MyWorldBucket[] {
  const rank = (k: string) => {
    const i = MY_WORLD_BUCKET_ORDER.indexOf(k);
    return i === -1 ? MY_WORLD_BUCKET_ORDER.length : i;
  };
  // Stable: equal ranks keep server order.
  return buckets
    .map((b, i) => ({ b, i }))
    .sort((x, y) => rank(x.b.key) - rank(y.b.key) || x.i - y.i)
    .map(({ b }) => b);
}

export interface MyMediaState {
  selectedKey: string;
  searchOpen: boolean;
}

export const INITIAL_MY_MEDIA_STATE: MyMediaState = { selectedKey: 'all', searchOpen: false };

export type MyMediaAction =
  | { type: 'select_bucket'; key: string }
  | { type: 'open_search' }
  | { type: 'close_search' };

export function myMediaReducer(state: MyMediaState, action: MyMediaAction): MyMediaState {
  switch (action.type) {
    case 'select_bucket':
      return state.selectedKey === action.key && !state.searchOpen
        ? state
        : { selectedKey: action.key, searchOpen: false };
    case 'open_search':
      return state.searchOpen ? state : { ...state, searchOpen: true };
    case 'close_search':
      return state.searchOpen ? { ...state, searchOpen: false } : state;
    default:
      return state;
  }
}

export function activeBucket(buckets: readonly MyWorldBucket[], selectedKey: string): MyWorldBucket | null {
  return buckets.find((b) => b.key === selectedKey) ?? buckets[0] ?? null;
}

/** Owner-only OPERATIONAL buckets — never placed on the map of where you've been. */
export const OPERATIONAL_BUCKETS: ReadonlySet<string> = new Set(['drafts', 'archived', 'uploads', 'processing']);

export function mapMediaOf(buckets: readonly MyWorldBucket[]): MediaProjection[] {
  const seen = new Set<string>();
  const out: MediaProjection[] = [];
  for (const b of buckets) {
    if (b.ownerOnly || OPERATIONAL_BUCKETS.has(b.key)) continue;
    for (const m of b.media) {
      if (!m?.id || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}
