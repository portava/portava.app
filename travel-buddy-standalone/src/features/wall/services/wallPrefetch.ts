/**
 * wallPrefetch — the Wall's caching & prefetch layer (Wall spec §31/§34/§40).
 *
 * Two jobs, both fail-soft so the social feed never depends on either:
 *
 *  1. FIRST-PAGE CACHE (fast reopen, §31)
 *     The first page of a feed session is written to AsyncStorage so a reopen
 *     paints instantly instead of a blank spinner. The server is still the
 *     authority — a live fetch REVALIDATES eligibility and replaces the cached
 *     page as soon as it arrives (§31 "revalidate eligibility"). The cache is
 *     only ever DISPLAYED on its own when the network is unavailable, and then
 *     only with a visible "saved feed" label (§31 offline + §37 no fake-live).
 *
 *     Two horizons govern it:
 *       FIRST_PAGE_TTL_MS  — within this the page is fresh enough to seed the
 *                            initial paint silently;
 *       FIRST_PAGE_MAX_AGE_MS — past this the page is too old to show at all
 *                            and is discarded.
 *     A page between the two is served offline WITH the stale label; a page
 *     past the max age is dropped, so an old cache never masquerades as the
 *     feed.
 *
 *     Only the canonical (no-session-intent) feed is cached: a typed-intent
 *     session is a temporary Wall context (§17) and must not be restored as if
 *     it were the user's feed.
 *
 *  2. MEDIA PREFETCH (§31 "prefetch media for the next small number of visible
 *     objects only"). The next N objects' images are hydrated through the
 *     EXISTING signing path (hydrateMediaUrls → batch-sign → mediaAccess, so
 *     private-bucket bytes get a signed URL) and warmed into the same disk /
 *     memory cache CachedImage reads from (expo-image's Image.prefetch). Never
 *     more than a few, never video payloads, never a bare unsigned reference.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from 'expo-image';
import { hydrateMediaUrls } from '../../../services/mediaUrl.ts';
import { revalidateCachedObjects } from './wallApi.ts';
import type { WallMode, WallProjection } from '../types/wallProjection.ts';

/** Minimal AsyncStorage subset — injected in tests. */
export interface StorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const WALL_PREFETCH_VERSION = 1;
/** Fresh-enough to seed the initial paint without a stale label. */
export const FIRST_PAGE_TTL_MS = 10 * 60 * 1000; // 10 min
/** Older than this and the page is discarded — never shown, even offline. */
export const FIRST_PAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 h
/** Cap the persisted page so the cache stays small (§31 "first page"). */
export const FIRST_PAGE_MAX_ITEMS = 12;
/** How many upcoming objects to warm media for (§31 "small number"). */
export const DEFAULT_PREFETCH_COUNT = 4;

function cacheKey(mode: WallMode): string {
  return `wall:firstpage:v${WALL_PREFETCH_VERSION}:${mode}`;
}

interface StoredFirstPage {
  v: number;
  mode: WallMode;
  items: WallProjection[];
  cachedAt: number;
}

export interface CachedFirstPage {
  items: WallProjection[];
  cachedAt: number;
  ageMs: number;
  /** True once the page is past FIRST_PAGE_TTL_MS — show only with a label. */
  stale: boolean;
}

/**
 * AsyncStorage wrapped so a native failure can never escape as a rejection —
 * a broken cache degrades to "no cache", never to a thrown error (§40 #7).
 */
export const wallStorage: StorageLike = {
  async getItem(key) {
    try {
      return await AsyncStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async setItem(key, value) {
    try {
      await AsyncStorage.setItem(key, value);
    } catch {
      /* best-effort */
    }
  },
  async removeItem(key) {
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      /* best-effort */
    }
  },
};

function isProjectionArray(v: unknown): v is WallProjection[] {
  return (
    Array.isArray(v) &&
    v.every(
      (x) =>
        x != null &&
        typeof x === 'object' &&
        typeof (x as WallProjection).projectionId === 'string' &&
        typeof (x as WallProjection).canonicalObjectId === 'string',
    )
  );
}

/**
 * Read the cached first page for `mode`, or null when there is none, it is
 * unreadable / malformed / from an old version, or it is past
 * FIRST_PAGE_MAX_AGE_MS (in which case it is also evicted). The returned
 * `stale` flag says whether it is past the fresh TTL.
 */
export async function readFirstPageCache(
  mode: WallMode,
  opts: { storage?: StorageLike; now?: number } = {},
): Promise<CachedFirstPage | null> {
  const storage = opts.storage ?? wallStorage;
  const now = opts.now ?? Date.now();
  const raw = await storage.getItem(cacheKey(mode));
  if (!raw) return null;

  let parsed: StoredFirstPage;
  try {
    parsed = JSON.parse(raw) as StoredFirstPage;
  } catch {
    await storage.removeItem(cacheKey(mode));
    return null;
  }

  if (
    !parsed ||
    parsed.v !== WALL_PREFETCH_VERSION ||
    parsed.mode !== mode ||
    typeof parsed.cachedAt !== 'number' ||
    !isProjectionArray(parsed.items)
  ) {
    await storage.removeItem(cacheKey(mode));
    return null;
  }

  const ageMs = Math.max(0, now - parsed.cachedAt);
  if (ageMs > FIRST_PAGE_MAX_AGE_MS || parsed.items.length === 0) {
    await storage.removeItem(cacheKey(mode));
    return null;
  }

  return {
    items: parsed.items,
    cachedAt: parsed.cachedAt,
    ageMs,
    stale: ageMs > FIRST_PAGE_TTL_MS,
  };
}

/**
 * Persist the first page of a freshly-fetched session for fast reopen. Caps
 * the stored item count and is a no-op for an empty page. Best-effort.
 */
export async function writeFirstPageCache(
  mode: WallMode,
  items: WallProjection[],
  opts: { storage?: StorageLike; now?: number } = {},
): Promise<void> {
  const storage = opts.storage ?? wallStorage;
  const now = opts.now ?? Date.now();
  if (!items || items.length === 0) return;
  const payload: StoredFirstPage = {
    v: WALL_PREFETCH_VERSION,
    mode,
    items: items.slice(0, FIRST_PAGE_MAX_ITEMS),
    cachedAt: now,
  };
  await storage.setItem(cacheKey(mode), JSON.stringify(payload));
}

/**
 * Re-check a cached page against the SERVER's canonical eligibility gate and
 * persist the corrected page (Wall spec §31 "revalidate eligibility"; §37
 * "moderation takedowns propagate to cached Wall projections").
 *
 * The cache used to be write-once-read-many: a page written while an object was
 * eligible kept painting for up to 24 h, so a takedown that landed in between
 * never reached it. This is the propagation path.
 *
 * THE SERVER DECIDES, ALWAYS. Nothing here re-derives eligibility — there is no
 * client-side moderation predicate to drift out of step, and none is wanted
 * (spec §37: "Server-side eligibility is authoritative; never rely on client
 * hiding"; Sensing S6: no client truth duplication). The client's entire job is
 * to send ids and keep what comes back.
 *
 * A revalidation the server did not answer (genuinely offline, unauthenticated,
 * unconfigured) leaves the cache untouched and returns `null`: destroying a
 * cached feed on a flaky connection would break the offline behaviour §31
 * requires, and an unreachable server is not a takedown. A revalidation the
 * server DID answer is honoured in full, including an empty answer — that is a
 * real "none of this may be shown any more", and the page is evicted.
 *
 * Returns the surviving items, or null when nothing could be decided.
 */
export async function revalidateFirstPageCache(
  mode: WallMode,
  opts: {
    storage?: StorageLike;
    now?: number;
    revalidate?: typeof revalidateCachedObjects;
  } = {},
): Promise<WallProjection[] | null> {
  const storage = opts.storage ?? wallStorage;
  const revalidate = opts.revalidate ?? revalidateCachedObjects;
  const cached = await readFirstPageCache(mode, { storage, now: opts.now });
  if (!cached || cached.items.length === 0) return null;

  const result = await revalidate(cached.items.map((i) => i.canonicalObjectId));
  if (!result.ok) return null; // not a verdict — leave the cache as it is

  const allowed = new Set(result.eligibleObjectIds);
  const survivors = cached.items.filter((i) => allowed.has(i.canonicalObjectId));
  if (survivors.length === cached.items.length) return survivors; // nothing changed

  if (survivors.length === 0) {
    await clearFirstPageCache(mode, { storage });
    return [];
  }
  // Rewrite the page in place, PRESERVING the original `cachedAt` — a
  // revalidation is not a refresh, and must not make a 20-hour-old page look
  // freshly fetched (which would suppress the stale label §31 requires).
  await writeFirstPageCache(mode, survivors, { storage, now: cached.cachedAt });
  return survivors;
}

/** Drop the cached page for a mode (e.g. after a policy-driven revalidation). */
export async function clearFirstPageCache(
  mode: WallMode,
  opts: { storage?: StorageLike } = {},
): Promise<void> {
  const storage = opts.storage ?? wallStorage;
  await storage.removeItem(cacheKey(mode));
}

/** Pull the still-image URLs worth warming from one projection. */
function imageRefsOf(item: WallProjection): string[] {
  const out: string[] = [];
  for (const m of item.media ?? []) {
    if (!m || m.processing) continue;
    // Video: warm the still poster only, never the payload (§11/§31).
    const ref = m.kind === 'video' ? m.thumbnailUrl : (m.url ?? m.thumbnailUrl);
    if (typeof ref === 'string' && ref.length > 0) out.push(ref);
  }
  return out;
}

/**
 * Warm the media of the next `count` objects into the shared image cache.
 * Hydrates through the existing signing path first, so private-bucket refs are
 * prefetched as signed URLs (a bare storage path would 404). Fail-soft and
 * bounded; returns the URLs it warmed (for tests / callers that want to log).
 */
export async function prefetchWallMedia(
  items: WallProjection[],
  opts: {
    count?: number;
    hydrate?: typeof hydrateMediaUrls;
    prefetch?: (urls: string[]) => Promise<unknown>;
  } = {},
): Promise<string[]> {
  const count = opts.count ?? DEFAULT_PREFETCH_COUNT;
  const hydrate = opts.hydrate ?? hydrateMediaUrls;
  const prefetch =
    opts.prefetch ?? ((urls: string[]) => Image.prefetch(urls, { cachePolicy: 'disk' }));

  if (count <= 0) return [];

  // De-dup the raw refs across the next `count` objects.
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const item of items.slice(0, count)) {
    for (const ref of imageRefsOf(item)) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      refs.push(ref);
    }
  }
  if (refs.length === 0) return [];

  try {
    const signed = await hydrate(refs);
    const urls = refs
      .map((r) => signed[r])
      .filter((u): u is string => typeof u === 'string' && u.length > 0);
    if (urls.length === 0) return [];
    await prefetch(urls);
    return urls;
  } catch {
    // Prefetch is a pure optimisation — a failure must never surface.
    return [];
  }
}

/** Human "saved N ago" label for the offline stale banner (§31/§37). */
export function formatCacheAge(ageMs: number): string {
  const s = Math.max(0, Math.floor(ageMs / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
