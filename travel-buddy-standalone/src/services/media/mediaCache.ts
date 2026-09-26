/**
 * mediaCache — the on-device store behind Media's offline / degraded mode
 * (spec §39; §40 services/mediaCache.ts).
 *
 * WHAT IT HOLDS
 *   • Projection payloads, per SCOPE (one per §39 line) and key, as JSON in
 *     AsyncStorage — the same versioned-key, never-throw idiom as
 *     services/discoveryLocalCache.ts and features/map/cache/mapCache.ts.
 *   • The images those payloads show, as FILES in the app's document
 *     directory, keyed by their storage reference. A private-bucket image can
 *     only be fetched with a signed URL that expires; a cached payload whose
 *     images need the network is not offline at all. mediaUrl.ts serves the
 *     local file when — and only when — signing is unreachable.
 *
 * THE RULES THAT MAKE A CACHE SAFE TO SHOW (§39's closing sentence)
 *   1. FRESHNESS ONLY DECAYS. `decayFreshness` re-ages every served object by
 *      the time it sat in the cache and recomputes its class from that age;
 *      nothing served from here can read `live`, a server-computed "Updated 4m
 *      ago" label is replaced by the true age, and a live crowd state label is
 *      dropped outright. The map cache follows the same rule for the same
 *      reason.
 *   2. EVERY READ CARRIES ITS AGE (`cachedAt`, `ageMinutes`) so the surface can
 *      say "Cached · updated 2h ago" without arithmetic of its own.
 *   3. NO COORDINATES ARE EVER STORED. The projections carry none by
 *      construction (the server scrubs at its boundary); `scrubCoordinates`
 *      removes any that a regression reintroduces before a byte is written —
 *      a device backup must not become a location archive.
 *   4. ACCOUNT-SCOPED, FAIL-CLOSED. Everything is filed under the signed-in
 *      account and nothing is read or written with no account. Another person
 *      signing in on this device sees none of it.
 *   5. BOUNDED. Per-scope TTL and entry cap (least-recently-read goes first),
 *      a per-entry image cap, and a global image byte budget.
 *
 * Every effect (storage, files, signing, clock, account) is injected, so the
 * whole policy is tested under node:test with no react-native.
 */

/**
 * One scope per §39 line that has a projection to cache. "Map thumbnails" has
 * NONE: GET /media/map carries per-place counts and no image at all
 * (MediaProjectionService.buildMediaMapProjection), and no client surface
 * renders it — so there is deliberately no scope for it here rather than an
 * empty one that would read as coverage.
 */
export type MediaCacheScope =
  | 'trip_media'
  | 'saved_places'
  | 'hidden_gems'
  | 'event_checkpoints'
  | 'place_perspectives'
  | 'crew_media';

export interface ScopePolicy {
  /** The §39 line this scope implements. */
  requirement: string;
  ttlMs: number;
  maxEntries: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const SCOPE_POLICY: Readonly<Record<MediaCacheScope, ScopePolicy>> = {
  trip_media: { requirement: 'Cache Trip media', ttlMs: 14 * DAY, maxEntries: 12 },
  saved_places: { requirement: 'Saved Places', ttlMs: 7 * DAY, maxEntries: 60 },
  hidden_gems: { requirement: 'Hidden Gems where permitted', ttlMs: 3 * DAY, maxEntries: 6 },
  // Events are over quickly; their checkpoint visuals stop being useful fast.
  event_checkpoints: { requirement: 'Event checkpoint visuals', ttlMs: 2 * DAY, maxEntries: 12 },
  // "Recent relevant": a short life and least-recently-read eviction ARE the definition.
  place_perspectives: { requirement: 'Recent relevant Place perspectives', ttlMs: 1 * DAY, maxEntries: 30 },
  crew_media: { requirement: 'Crew-relevant permitted media', ttlMs: 3 * DAY, maxEntries: 12 },
};

/** Images stored per cached entry — a cover per item, not a whole library. */
export const MAX_IMAGES_PER_ENTRY = 24;
/** Global budget for stored image files. */
export const MAX_IMAGE_BYTES_TOTAL = 150 * 1024 * 1024;

const KEY_VERSION = 'media_cache_v1';

// ── Pure policy ───────────────────────────────────────────────────────────────

type Freshness = 'live' | 'fresh' | 'recent' | 'historical';
const FRESHNESS_ORDER: readonly Freshness[] = ['live', 'fresh', 'recent', 'historical'];

/** The class an age earns once it has been cached: never `live`. */
export function cachedFreshnessFromAge(ageMinutes: number): Freshness {
  if (ageMinutes < 60) return 'fresh';
  if (ageMinutes < 60 * 24) return 'recent';
  return 'historical';
}

function worse(a: Freshness, b: Freshness): Freshness {
  return FRESHNESS_ORDER.indexOf(a) >= FRESHNESS_ORDER.indexOf(b) ? a : b;
}

function relativeAge(minutes: number): string {
  const m = Math.floor(minutes);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const COORDINATE_KEYS = new Set([
  'lat', 'lng', 'lon', 'latitude', 'longitude', 'coordinates', 'geometry',
  'location_lat', 'location_lng', 'public_lat', 'public_lng', 'original_lat', 'original_lng',
  'user_gps_lat', 'user_gps_lng', 'locationLat', 'locationLng', 'gps',
]);

/** A deep copy with every coordinate-shaped key removed. */
export function scrubCoordinates<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => scrubCoordinates(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (COORDINATE_KEYS.has(k)) continue;
      out[k] = scrubCoordinates(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Re-age a cached payload by `elapsedMinutes`. Returns a deep copy:
 *   • `ageMinutes` += elapsed;
 *   • `freshness` / `freshnessClass` → the WORSE of (stored, recomputed from the
 *     new age), and never `live` — an object with no age of its own is demoted
 *     one class at least from `live`;
 *   • `freshnessLabel` → the true age, or null;
 *   • `stateLabel` (a live crowd state) → null, and `live` flags → false —
 *     a live reading is never served from a cache;
 *   • `consensus` (§18, fresh-window witnesses and "Mixed reports") → null.
 */
export function decayFreshness<T>(value: T, elapsedMinutes: number): T {
  const elapsed = Math.max(0, elapsedMinutes);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(src)) out[k] = walk(child);
    const age = typeof src.ageMinutes === 'number' && Number.isFinite(src.ageMinutes) ? src.ageMinutes + elapsed : null;
    if (age !== null) out.ageMinutes = age;
    for (const key of ['freshness', 'freshnessClass']) {
      const f = src[key];
      if (typeof f === 'string' && (FRESHNESS_ORDER as readonly string[]).includes(f)) {
        const stored = f as Freshness;
        const recomputed = age !== null ? cachedFreshnessFromAge(age) : stored === 'live' ? 'fresh' : stored;
        out[key] = worse(stored === 'live' ? 'fresh' : stored, recomputed);
      }
    }
    if ('freshnessLabel' in src) out.freshnessLabel = age !== null ? `Updated ${relativeAge(age)}` : null;
    if ('stateLabel' in src) out.stateLabel = null;
    // §18: a consensus is a statement about the FRESH window at generation time — never replayed from a cache.
    if ('consensus' in src) out.consensus = null;
    if (typeof src.live === 'boolean') out.live = false;
    if (Array.isArray(src.liveClaims)) out.liveClaims = [];
    return out;
  };
  return walk(value) as T;
}

// ── Effects (injected) ────────────────────────────────────────────────────────

export interface CacheStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface CacheFiles {
  /** Directory for one account's image files (created on demand by `download`). */
  dirFor(accountId: string): string;
  /** Fetch `url` into `toUri`. Resolves the byte size, or null on any failure. Never throws. */
  download(url: string, toUri: string): Promise<number | null>;
  remove(uri: string): Promise<void>;
}

export interface CacheEnv {
  storage: CacheStorage;
  /** Null where image files are unavailable (web): payloads are still cached. */
  files: CacheFiles | null;
  accountId(): Promise<string | null>;
  now(): number;
  /** Resolve storage references to fetchable (signed) URLs. */
  sign(refs: string[]): Promise<Record<string, string | null>>;
}

interface StoredImage {
  ref: string;
  file: string;
  bytes: number;
}

interface IndexEntry {
  scope: MediaCacheScope;
  key: string;
  cachedAt: number;
  lastReadAt: number;
  images: StoredImage[];
}

interface CacheIndex {
  v: 1;
  entries: IndexEntry[];
}

export interface CacheRead<T> {
  payload: T;
  cachedAt: number;
  ageMinutes: number;
}

function hashRef(ref: string): string {
  // FNV-1a 32-bit, twice with different seeds: a short stable file name.
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ ref.length;
  for (let i = 0; i < ref.length; i++) {
    a = Math.imul(a ^ ref.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ ref.charCodeAt(ref.length - 1 - i), 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

export class MediaCache {
  private readonly env: CacheEnv;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(env: CacheEnv) {
    this.env = env;
  }

  private indexKey(accountId: string): string {
    return `${KEY_VERSION}:${accountId}:index`;
  }

  private entryKey(accountId: string, scope: MediaCacheScope, key: string): string {
    return `${KEY_VERSION}:${accountId}:${scope}:${key}`;
  }

  private async loadIndex(accountId: string): Promise<CacheIndex> {
    try {
      const raw = await this.env.storage.getItem(this.indexKey(accountId));
      const parsed = raw ? (JSON.parse(raw) as CacheIndex) : null;
      return parsed && parsed.v === 1 && Array.isArray(parsed.entries) ? parsed : { v: 1, entries: [] };
    } catch {
      return { v: 1, entries: [] };
    }
  }

  /** Serialise index read-modify-writes. */
  private locked<R>(fn: () => Promise<R>): Promise<R> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private async removeEntry(accountId: string, entry: IndexEntry, keepFiles: ReadonlySet<string>): Promise<void> {
    await this.env.storage.removeItem(this.entryKey(accountId, entry.scope, entry.key)).catch(() => {});
    if (this.env.files) {
      for (const img of entry.images) if (!keepFiles.has(img.file)) await this.env.files.remove(img.file).catch(() => {});
    }
  }

  /** Enforce TTL, per-scope caps and the image budget. Mutates `index`. */
  private async enforce(accountId: string, index: CacheIndex, now: number): Promise<void> {
    const evicted: IndexEntry[] = [];
    let keep = index.entries.filter((e) => {
      const alive = now - e.cachedAt <= SCOPE_POLICY[e.scope].ttlMs;
      if (!alive) evicted.push(e);
      return alive;
    });
    for (const scope of Object.keys(SCOPE_POLICY) as MediaCacheScope[]) {
      const inScope = keep.filter((e) => e.scope === scope).sort((a, b) => b.lastReadAt - a.lastReadAt);
      const over = inScope.slice(SCOPE_POLICY[scope].maxEntries);
      if (over.length) {
        evicted.push(...over);
        keep = keep.filter((e) => !over.includes(e));
      }
    }
    const fileBytes = new Map<string, number>();
    for (const e of keep) for (const img of e.images) fileBytes.set(img.file, img.bytes);
    let total = [...fileBytes.values()].reduce((a, b) => a + b, 0);
    if (total > MAX_IMAGE_BYTES_TOTAL) {
      for (const e of [...keep].sort((a, b) => a.lastReadAt - b.lastReadAt)) {
        if (total <= MAX_IMAGE_BYTES_TOTAL) break;
        evicted.push(e);
        keep = keep.filter((x) => x !== e);
        const stillUsed = new Set(keep.flatMap((x) => x.images.map((i) => i.file)));
        for (const img of e.images) if (!stillUsed.has(img.file)) total -= img.bytes;
      }
    }
    index.entries = keep;
    const stillUsed = new Set(keep.flatMap((e) => e.images.map((i) => i.file)));
    for (const e of evicted) await this.removeEntry(accountId, e, stillUsed);
  }

  /**
   * Store a payload (coordinates scrubbed) and up to MAX_IMAGES_PER_ENTRY of
   * the images it shows. Never throws; a failed write is a cache miss later.
   */
  async put<T>(scope: MediaCacheScope, key: string, payload: T, imageRefs: readonly string[] = []): Promise<void> {
    const accountId = await this.env.accountId();
    if (!accountId || !key) return;
    try {
      const clean = scrubCoordinates(payload);
      const now = this.env.now();
      await this.env.storage.setItem(this.entryKey(accountId, scope, key), JSON.stringify({ cachedAt: now, payload: clean }));
      const images = await this.storeImages(accountId, [...new Set(imageRefs)].slice(0, MAX_IMAGES_PER_ENTRY));
      await this.locked(async () => {
        const index = await this.loadIndex(accountId);
        const prior = index.entries.find((e) => e.scope === scope && e.key === key);
        index.entries = index.entries.filter((e) => e !== prior);
        index.entries.push({ scope, key, cachedAt: now, lastReadAt: now, images });
        if (prior && this.env.files) {
          // The entry's previous images that nothing references any more are orphans.
          const used = new Set(index.entries.flatMap((e) => e.images.map((i) => i.file)));
          for (const img of prior.images) if (!used.has(img.file)) await this.env.files.remove(img.file).catch(() => {});
        }
        await this.enforce(accountId, index, now);
        await this.env.storage.setItem(this.indexKey(accountId), JSON.stringify(index));
      });
    } catch {
      // A cache that cannot write is a cache that misses. Never an error.
    }
  }

  private async storeImages(accountId: string, refs: string[]): Promise<StoredImage[]> {
    const files = this.env.files;
    if (!files || refs.length === 0) return [];
    let signed: Record<string, string | null> = {};
    try {
      signed = await this.env.sign(refs);
    } catch {
      return [];
    }
    const out: StoredImage[] = [];
    for (const ref of refs) {
      const url = signed[ref];
      if (!url) continue; // the server would not sign it for this viewer: never stored
      const file = `${files.dirFor(accountId)}${hashRef(ref)}.img`;
      const bytes = await files.download(url, file);
      if (bytes != null && bytes > 0) out.push({ ref, file, bytes });
    }
    return out;
  }

  /** A cached payload, re-aged, or null (miss, expired, no account). */
  async get<T>(scope: MediaCacheScope, key: string): Promise<CacheRead<T> | null> {
    const accountId = await this.env.accountId();
    if (!accountId || !key) return null;
    try {
      const raw = await this.env.storage.getItem(this.entryKey(accountId, scope, key));
      if (!raw) return null;
      const stored = JSON.parse(raw) as { cachedAt: number; payload: T };
      const now = this.env.now();
      if (typeof stored.cachedAt !== 'number' || now - stored.cachedAt > SCOPE_POLICY[scope].ttlMs) {
        await this.forget(scope, key);
        return null;
      }
      const ageMinutes = Math.max(0, (now - stored.cachedAt) / 60_000);
      await this.locked(async () => {
        const index = await this.loadIndex(accountId);
        const e = index.entries.find((x) => x.scope === scope && x.key === key);
        if (e) {
          e.lastReadAt = now;
          await this.env.storage.setItem(this.indexKey(accountId), JSON.stringify(index));
        }
      });
      return { payload: decayFreshness(stored.payload, ageMinutes), cachedAt: stored.cachedAt, ageMinutes };
    } catch {
      return null;
    }
  }

  /** Drop one entry (the server said the content is gone, or no longer the viewer's to see). */
  async forget(scope: MediaCacheScope, key: string): Promise<void> {
    const accountId = await this.env.accountId();
    if (!accountId) return;
    await this.locked(async () => {
      const index = await this.loadIndex(accountId);
      const gone = index.entries.filter((e) => e.scope === scope && e.key === key);
      index.entries = index.entries.filter((e) => !gone.includes(e));
      const stillUsed = new Set(index.entries.flatMap((e) => e.images.map((i) => i.file)));
      for (const e of gone) await this.removeEntry(accountId, e, stillUsed);
      if (gone.length === 0) await this.env.storage.removeItem(this.entryKey(accountId, scope, key)).catch(() => {});
      await this.env.storage.setItem(this.indexKey(accountId), JSON.stringify(index));
    }).catch(() => {});
  }

  /** The local file holding `ref`'s image for the signed-in account, or null. */
  async localFileFor(ref: string): Promise<string | null> {
    const accountId = await this.env.accountId();
    if (!accountId) return null;
    const index = await this.loadIndex(accountId);
    for (const e of index.entries) {
      if (this.env.now() - e.cachedAt > SCOPE_POLICY[e.scope].ttlMs) continue;
      const img = e.images.find((i) => i.ref === ref);
      if (img) return img.file;
    }
    return null;
  }

  /**
   * The server REFUSED to sign `ref` for this viewer: whatever was cached of it
   * goes now, from every entry. A cache must never outlive a revocation it has
   * been told about.
   */
  async forgetRef(ref: string): Promise<void> {
    const accountId = await this.env.accountId();
    if (!accountId) return;
    await this.locked(async () => {
      const index = await this.loadIndex(accountId);
      let changed = false;
      for (const e of index.entries) {
        const hit = e.images.filter((i) => i.ref === ref);
        if (hit.length === 0) continue;
        changed = true;
        e.images = e.images.filter((i) => i.ref !== ref);
        if (this.env.files) for (const img of hit) await this.env.files.remove(img.file).catch(() => {});
      }
      if (changed) await this.env.storage.setItem(this.indexKey(accountId), JSON.stringify(index));
    }).catch(() => {});
  }

  /** Everything this account cached, gone. */
  async clearAccount(): Promise<void> {
    const accountId = await this.env.accountId();
    if (!accountId) return;
    await this.locked(async () => {
      const index = await this.loadIndex(accountId);
      for (const e of index.entries) await this.removeEntry(accountId, e, new Set());
      await this.env.storage.removeItem(this.indexKey(accountId)).catch(() => {});
    }).catch(() => {});
  }

  /** What is cached, for a settings screen or a test. */
  async inventory(): Promise<Array<{ scope: MediaCacheScope; key: string; cachedAt: number; images: number }>> {
    const accountId = await this.env.accountId();
    if (!accountId) return [];
    const index = await this.loadIndex(accountId);
    return index.entries.map((e) => ({ scope: e.scope, key: e.key, cachedAt: e.cachedAt, images: e.images.length }));
  }
}

// ── The device cache ──────────────────────────────────────────────────────────

let _cache: MediaCache | null = null;

/** Test seam: replace (or clear with null) the device cache. */
export function _setMediaCache(cache: MediaCache | null): void {
  _cache = cache;
}

let _loadFailure: Error | null = null;

/** Test seam: make the device cache fail to load (as it would where storage is unavailable). */
export function _failMediaCacheLoad(err: Error | null): void {
  _loadFailure = err;
}

export async function getMediaCache(): Promise<MediaCache> {
  if (_loadFailure) throw _loadFailure;
  if (_cache) return _cache;
  const { deviceCacheEnv } = await import('./mediaCacheDevice.ts');
  _cache = new MediaCache(await deviceCacheEnv());
  return _cache;
}
