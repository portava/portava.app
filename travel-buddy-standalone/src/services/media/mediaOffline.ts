/**
 * mediaOffline — Media's degraded mode: each §39 line as a cache SCOPE, filled
 * from the same projection fetchers the lenses use, and served back — aged,
 * labelled, never live — when the network is gone (spec §39).
 *
 *   §39 line                               scope                source
 *   Cache Trip media                       trip_media           GET /media/experiences/:tripId
 *   Saved Places                           saved_places         GET /media/places/:placeId (the viewer's saved places)
 *   Hidden Gems where permitted            hidden_gems          GET /media/gems (disclosure-gated; location-hidden gems NOT stored)
 *   Event checkpoint visuals               event_checkpoints    GET /media/experiences/:eventId
 *   Recent relevant Place perspectives     place_perspectives   GET /media/places/:placeId (as viewed)
 *   Map thumbnails                         —                    NOT CACHED: /media/map carries no image (see mediaCache.ts)
 *   Crew-relevant permitted media          crew_media           GET /media/people → only the trip_crew groups
 *   Cached intelligence shows its age      every read           decayFreshness + `offline.label`
 *
 * WHEN THE CACHE IS SERVED, AND WHEN IT IS NOT
 *   • The server answered with content → it is shown, and it REPLACES the
 *     cached copy (so a cache never outlives the server's own narrowing).
 *   • The server answered "nothing for you" (null / empty / not found) → the
 *     cached copy is DELETED. An offline copy must not survive a revocation the
 *     device has been told about.
 *   • The server could not be reached (network / 5xx / unknown) → the cached
 *     copy is served, re-aged, with `offline.label` ("Cached · updated 2h ago").
 *   • An auth failure → nothing is served from the cache: that is a session
 *     problem, not an outage, and it may be a ban.
 */
import {
  fetchExperience,
  fetchGems,
  fetchPeople,
  fetchPlaceView,
} from '../../features/media/services/mediaProjection.ts';
import type { ProjectionErrorKind, ProjectionResult } from '../../features/media/types/media.ts';
import type { PlaceCurrentView } from '../../features/media/types/perspective.ts';
import type { MediaExperienceProjection } from '../../features/media/types/mediaExperience.ts';
import type { HiddenGemLensProjection } from '../../features/media/types/hiddenGemMedia.ts'; import { gemLensReadState } from '../../features/media/state/gemLens.ts';
import type { PeopleLensProjection } from '../../features/media/types/peopleLens.ts';
import { getMediaCache, type MediaCacheScope } from './mediaCache.ts';

export interface OfflineMeta {
  cachedAt: number;
  ageMinutes: number;
  /** "Cached · updated 2h ago" — the §39 label a surface must show with cached content. */
  label: string;
}

/** A ProjectionResult that says, when it came from the cache, how old it is. */
export type OfflineResult<T> = ProjectionResult<T> & { offline?: OfflineMeta };

/** Outages the cache may cover for. Everything else is an ANSWER. */
const OUTAGE: ReadonlySet<ProjectionErrorKind> = new Set(['network', 'server', 'unknown']);

export function offlineLabel(ageMinutes: number): string {
  const m = Math.floor(ageMinutes);
  const rel = m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
  return `Cached · updated ${rel}`;
}

/**
 * Every image reference a payload shows, cover-first: `thumbnailUrl`s, and the
 * `url` of an IMAGE item that has no thumbnail. A video's `url` is the video
 * file itself and is never collected — the offline set is visuals, not clips.
 */
export function collectImageRefs(value: unknown, limit = 24): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: unknown) => {
    if (typeof s === 'string' && s.length > 0 && !seen.has(s) && out.length < limit) {
      seen.add(s);
      out.push(s);
    }
  };
  const walk = (v: unknown) => {
    if (out.length >= limit) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if ('thumbnailUrl' in o) add(o.thumbnailUrl);
    if (!o.thumbnailUrl && o.mediaType === 'image') add(o.url);
    for (const child of Object.values(o)) if (child && typeof child === 'object') walk(child);
  };
  walk(value);
  return out;
}

/**
 * The one cache-through rule, shared by every scope. `readScopes` are tried in
 * order when the network is down (a place may be cached as recent AND saved).
 */
async function cacheThrough<T>(
  writeScope: MediaCacheScope | null,
  readScopes: readonly MediaCacheScope[],
  key: string,
  online: () => Promise<ProjectionResult<T>>,
  opts: { isEmpty?: (data: T) => boolean; toStore?: (data: T) => unknown; fromStore?: (stored: unknown) => T } = {},
): Promise<OfflineResult<T>> {
  // A cache that cannot load must not take the lens down with it: online only.
  const cache = await getMediaCache().catch(() => null);
  let result: ProjectionResult<T>;
  try {
    result = await online();
  } catch {
    result = { ok: false, data: null, errorKind: 'network', message: 'Network error' };
  }
  if (result.ok) {
    const empty = result.data == null || (opts.isEmpty ? opts.isEmpty(result.data) : false);
    if (!cache) return result;
    if (empty) {
      // The server answered "nothing for you here". Whatever was cached goes.
      for (const s of readScopes) void cache.forget(s, key);
    } else if (writeScope) {
      const stored = opts.toStore ? opts.toStore(result.data) : result.data;
      void cache.put(writeScope, key, stored, collectImageRefs(stored));
    }
    return result;
  }
  if (!cache) return result;
  if (result.errorKind === 'not_found' || result.errorKind === 'empty') {
    for (const s of readScopes) void cache.forget(s, key);
    return result;
  }
  if (!OUTAGE.has(result.errorKind)) return result;
  for (const s of readScopes) {
    const hit = await cache.get<unknown>(s, key);
    if (hit) {
      const data = opts.fromStore ? opts.fromStore(hit.payload) : (hit.payload as T);
      return {
        ok: true,
        data,
        offline: { cachedAt: hit.cachedAt, ageMinutes: hit.ageMinutes, label: offlineLabel(hit.ageMinutes) },
      };
    }
  }
  return result;
}

// ── The seven scopes ──────────────────────────────────────────────────────────

/**
 * A place's current view (Recent relevant Place perspectives; Saved Places).
 * Written to `place_perspectives` as it is viewed; read back from either scope,
 * so a saved place that was pre-warmed is there offline even if never opened.
 */
export function placeViewOffline(
  placeId: string,
  opts?: { signal?: AbortSignal; nowMs?: number },
): Promise<OfflineResult<PlaceCurrentView | null>> {
  return cacheThrough<PlaceCurrentView | null>(
    'place_perspectives',
    ['place_perspectives', 'saved_places'],
    placeId,
    () => fetchPlaceView(placeId, opts),
  );
}

function experienceScope(exp: MediaExperienceProjection | null): MediaCacheScope | null {
  if (!exp) return null;
  if (exp.eventId) return 'event_checkpoints';
  if (exp.tripId) return 'trip_media';
  return null;
}

/** One experience (Trip media; Event checkpoint visuals), filed by its kind. */
export async function experienceOffline(
  experienceId: string,
  opts?: { signal?: AbortSignal },
): Promise<OfflineResult<MediaExperienceProjection | null>> {
  let scope: MediaCacheScope | null = null;
  const r = await cacheThrough<MediaExperienceProjection | null>(
    null,
    ['trip_media', 'event_checkpoints'],
    experienceId,
    async () => {
      const res = await fetchExperience(experienceId, opts);
      if (res.ok) scope = experienceScope(res.data);
      return res;
    },
  );
  if (r.ok && !r.offline && r.data && scope) {
    const cache = await getMediaCache().catch(() => null);
    if (cache) void cache.put(scope, experienceId, r.data, collectImageRefs(r.data));
  }
  return r;
}

/** A list of experiences, each through `experienceOffline`, in the input order. */
export async function experiencesOffline(
  ids: string[],
  opts?: { signal?: AbortSignal },
): Promise<OfflineResult<MediaExperienceProjection[]>> {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
  if (unique.length === 0) return { ok: true, data: [] };
  const results = await Promise.all(unique.map((id) => experienceOffline(id, opts)));
  const data: MediaExperienceProjection[] = [];
  let oldest: OfflineMeta | undefined;
  let firstErr: ProjectionErrorKind | null = null;
  for (const r of results) {
    if (r.ok) {
      if (r.data) data.push(r.data);
      if (r.offline && (!oldest || r.offline.cachedAt < oldest.cachedAt)) oldest = r.offline;
    } else if (firstErr === null) {
      firstErr = r.errorKind;
    }
  }
  if (data.length === 0 && firstErr !== null && results.every((r) => !r.ok)) {
    return { ok: false, data: null, errorKind: firstErr, message: 'Could not load experiences' };
  }
  // A mixed list is labelled by its OLDEST cached member: the label may not flatter it.
  return oldest ? { ok: true, data, offline: oldest } : { ok: true, data };
}

/** Only the trip-crew groups of the People lens (Crew-relevant permitted media). */
export function crewSlice(p: PeopleLensProjection): PeopleLensProjection {
  return { generatedAt: p.generatedAt, people: p.people.filter((g) => g.relation === 'trip_crew') };
}

/**
 * The People lens with an offline fallback. What is STORED is the crew slice
 * only: the lens's followed and creator groups are not §39 content, and are
 * never kept on the device. Offline, the lens shows the crew groups it has.
 */
export function peopleOffline(opts?: { signal?: AbortSignal }): Promise<OfflineResult<PeopleLensProjection>> {
  return cacheThrough<PeopleLensProjection>('crew_media', ['crew_media'], 'crew', () => fetchPeople(opts), {
    isEmpty: (p) => crewSlice(p).people.length === 0,
    toStore: (p) => crewSlice(p),
  });
}

/**
 * The Hidden Gems lens, stored "where permitted": the lens already drops gems
 * the server may not disclose, and of those none it declined to NAME
 * (mayDiscloseGemIdentity) is copied onto a device, where the server's live
 * gate cannot follow it. A list the server could not read (gemLensReadState's
 * `list_unreadable`) is an outage, never "no gems here": served from cache.
 */
export function permittedGems(p: HiddenGemLensProjection): HiddenGemLensProjection {
  const gems = p.gems.filter((g) => g.name !== null);
  return { ...p, gems, total: gems.length };
}
export function gemsOffline(opts?: { city?: string | null; signal?: AbortSignal }): Promise<OfflineResult<HiddenGemLensProjection>> {
  const outage = (r: ProjectionResult<HiddenGemLensProjection>): ProjectionResult<HiddenGemLensProjection> =>
    r.ok && gemLensReadState(r.data) === 'list_unreadable' ? { ok: false, data: null, errorKind: 'server', message: 'Hidden gems could not be read' } : r;
  return cacheThrough<HiddenGemLensProjection>('hidden_gems', ['hidden_gems'], opts?.city ?? 'here', () => fetchGems(opts).then(outage), {
    isEmpty: (p) => permittedGems(p).gems.length === 0,
    toStore: (p) => permittedGems(p),
  });
}

// ── Warming: fill the scopes while the network is here ────────────────────────

export interface OfflineContext {
  savedPlaceIds?: string[];
  tripIds?: string[];
  eventIds?: string[];
  gemsCity?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pre-fill the scopes the user is likely to need offline — their saved places,
 * their trips, their events, the gems of their city — in the background, one
 * request at a time. A saved place whose id is not a canonical place id cannot
 * be resolved by the media place endpoint and is skipped, not guessed at.
 */
export async function prepareOfflineMedia(ctx: OfflineContext): Promise<{ stored: number; skipped: number }> {
  const cache = await getMediaCache().catch(() => null);
  if (!cache) return { stored: 0, skipped: 0 };
  let stored = 0;
  let skipped = 0;
  for (const id of ctx.savedPlaceIds ?? []) {
    if (!UUID_RE.test(id)) {
      skipped++;
      continue;
    }
    const r = await fetchPlaceView(id);
    if (r.ok && r.data) {
      await cache.put('saved_places', id, r.data, collectImageRefs(r.data));
      stored++;
    }
  }
  for (const id of [...(ctx.tripIds ?? []), ...(ctx.eventIds ?? [])]) {
    if (!UUID_RE.test(id)) {
      skipped++;
      continue;
    }
    const r = await experienceOffline(id);
    if (r.ok && r.data && !r.offline) stored++;
  }
  if (ctx.gemsCity !== undefined) {
    const r = await gemsOffline({ city: ctx.gemsCity });
    if (r.ok && !r.offline) stored++;
  }
  return { stored, skipped };
}
