/**
 * layoverPlanCache — census §16 L151 and §20 L233, the CLIENT half.
 *
 * ── WHY A SECOND CACHE AND NOT A BIGGER FIRST ONE ────────────────────────────
 * `components/layover/layoverDeadlineCache.ts` states in its own header what it
 * refuses to store: *"Only the deadline and its certification instants. Not the
 * plan, not the map, not the envelope … §16 gives each of those its own row
 * (L151-L155) and each is a separate decision about what may be shown from a
 * cache; bundling them behind this one would close those rows by accident
 * rather than by argument."*
 *
 * This is two of those decisions, made deliberately and separately:
 *
 *   L151 (map — cache airport + selected route/area). The AIRPORT is cached:
 *        code, name, city, timezone and coordinate, straight off the bundle.
 *        The AREA is cached as the certified envelope's two radii. NO ROUTE is
 *        cached, because there is no routed provider on this tree
 *        (`route: unavailable("no_routing_provider")`) — a cache cannot store a
 *        thing that was never produced, and inventing a line between two points
 *        offline would be the §13 defect with the network off.
 *
 *   L233 (offline after leaving — the cached return plan stays visible with a
 *        stale indicator). The STOPS are cached, in the server's own bundle
 *        shape, so a traveller who lost signal in the city still has the plan
 *        they left with.
 *
 * ── THE BOUND IS THE SERVER'S AND IS NEVER RENEWED ───────────────────────────
 * `certifiedAt` and `staleAfter` are copied verbatim and are never extended,
 * refreshed or recomputed at write time. A cache that renewed the bound as it
 * wrote would turn an hour-old plan into a current one — the single failure
 * §16 exists to prevent — and the suite pins it byte-for-byte.
 *
 * Freshness is decided by ONE rule, `layoverReturnFacts.bundleFreshness`, the
 * same one a live bundle goes through. There is deliberately no second, gentler
 * offline rule here: that is how a cache ends up presenting an old answer as a
 * current one.
 *
 * ── WHAT IS STILL NOT CACHED, AND WHY ────────────────────────────────────────
 *   L152 route         no routing provider exists to cache from.
 *   L153 flight/gate   `flightStatus: unavailable("no_flight_feed")`; the
 *                      traveller's own typed schedule is not a confirmed
 *                      flight status and must not be dressed up as one.
 *   L154 crew point    the server still answers `no_crew_storage` on the
 *                      bundle; `crewMeetingPoint` is typed for the day it does.
 *   L155 phrases       `no_phrase_catalogue` — there is nothing to cache.
 * Each of those is a server-side absence, not a client decision, and none is
 * papered over here.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { LayoverOfflineBundle, LayoverSafeEnvelope } from '../services/layover.ts';

/**
 * Bumped whenever the stored SHAPE changes. A record written by another version
 * is discarded whole rather than read field-by-field: once it is JSON, a field
 * that moved is indistinguishable from a field that was never there.
 */
export const CACHED_PLAN_VERSION = 1;

const KEY_PREFIX = 'layover.plan.v1';

/** Per-session, because a plan belongs to one layover. Exported for the suite. */
export function cachedPlanKey(sessionId: string): string {
  return `${KEY_PREFIX}:${sessionId}`;
}

export interface CachedPlanStop {
  title: string;
  durationMin: number;
  travelMin: number;
  insideAirport: boolean;
}

/**
 * L151's AREA, and only the parts that can be rendered without a basemap.
 *
 * `certifiedInward` is NOT stored, because it is a constant `false` and storing
 * it invites a reader to branch on it. The rendering rule it encodes is carried
 * by the surface instead: being inside the disc is not a certification that
 * anything fits, and no offline surface may say otherwise.
 */
export interface CachedPlanEnvelope {
  /** Metres. Outside this, nothing fits at any speed. */
  radiusMetres: number;
  /** The contracted planning edge after the confidence haircut. */
  plannedRadiusMetres: number;
  /** The certified window the radii were cut from. */
  usableMinutes: number;
  maxOneWayMinutes: number;
}

export interface CachedLayoverPlan {
  sessionId: string;
  /** The server's own bundle-shape version, carried so support can read it. */
  bundleVersion: string;
  certifiedAt: string;
  staleAfter: string;
  airport: {
    iataCode: string;
    name: string;
    city: string;
    timezone: string;
    lat: number | null;
    lng: number | null;
  };
  /** The plan as the server certified it. `[]` is a real answer. */
  stops: CachedPlanStop[];
  /** `null` for an airport with no usable coordinate — never a zero disc. */
  envelope: CachedPlanEnvelope | null;
  /** DEVICE instant of the write. For support only — never a freshness input. */
  cachedAt: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function normaliseStops(raw: unknown): CachedPlanStop[] {
  if (!Array.isArray(raw)) return [];
  const out: CachedPlanStop[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const stop = s as Record<string, unknown>;
    if (!isNonEmptyString(stop.title)) continue;
    out.push({
      title: stop.title,
      durationMin: num(stop.durationMin),
      travelMin: num(stop.travelMin),
      insideAirport: stop.insideAirport === true,
    });
  }
  return out;
}

/**
 * Persist the plan and the certified area from a freshly-read overview.
 *
 * Returns whether anything was written. `false` has the same two causes, and
 * the same meaning, as in `cacheCertifiedDeadline`:
 *
 *   NO BUNDLE / NO INSTANTS   a response that said nothing about the plan is
 *                             not a new answer about it, so any existing record
 *                             is LEFT ALONE rather than cleared.
 *   STORAGE REFUSED           reported, never thrown: the caller is a render
 *                             path and a rejected write must not take the
 *                             screen down with it.
 *
 * The envelope is a SEPARATE argument rather than read off the bundle, because
 * the bundle's own `mapGeometry` is `unavailable("no_envelope_geometry")` — the
 * geometry lives on `overview.safeEnvelope`. Passing it explicitly keeps the
 * fact that they come from two different fields visible at the call site.
 */
export async function cacheCertifiedPlan(
  sessionId: string,
  bundle: LayoverOfflineBundle | null | undefined,
  envelope: LayoverSafeEnvelope | null | undefined,
): Promise<boolean> {
  if (!bundle) return false;
  if (!isNonEmptyString(bundle.certifiedAt) || !isNonEmptyString(bundle.staleAfter)) return false;
  const airport = bundle.airport;
  if (!airport || !isNonEmptyString(airport.iataCode)) return false;

  const record: CachedLayoverPlan & { v: number } = {
    v: CACHED_PLAN_VERSION,
    sessionId,
    bundleVersion: bundle.bundleVersion,
    // VERBATIM. See the header: the bound is the server's.
    certifiedAt: bundle.certifiedAt,
    staleAfter: bundle.staleAfter,
    airport: {
      iataCode: airport.iataCode,
      name: isNonEmptyString(airport.name) ? airport.name : airport.iataCode,
      city: isNonEmptyString(airport.city) ? airport.city : '',
      timezone: isNonEmptyString(airport.timezone) ? airport.timezone : 'UTC',
      lat: typeof airport.lat === 'number' ? airport.lat : null,
      lng: typeof airport.lng === 'number' ? airport.lng : null,
    },
    stops: normaliseStops(bundle.stops),
    envelope: envelope
      ? {
          radiusMetres: num(envelope.radiusMetres),
          plannedRadiusMetres: num(envelope.plannedRadiusMetres),
          usableMinutes: num(envelope.usableMinutes),
          maxOneWayMinutes: num(envelope.maxOneWayMinutes),
        }
      : null,
    cachedAt: new Date().toISOString(),
  };

  try {
    await AsyncStorage.setItem(cachedPlanKey(sessionId), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * The last certified plan this device wrote down for this session.
 *
 * `null` means NOTHING IS CACHED and must be rendered as that. Every failure —
 * unparseable bytes, an unknown version, another session's record, a storage
 * layer that throws — answers `null` rather than a partial record: a plan with
 * no provenance is the worst thing to put in front of someone deciding whether
 * they still have time to get back.
 */
export async function readCachedPlan(sessionId: string): Promise<CachedLayoverPlan | null> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(cachedPlanKey(sessionId));
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;

  if (rec.v !== CACHED_PLAN_VERSION) return null;
  // One layover's plan shown on another is worse than showing none.
  if (rec.sessionId !== sessionId) return null;
  if (!isNonEmptyString(rec.certifiedAt) || !isNonEmptyString(rec.staleAfter)) return null;

  const airport = (rec.airport ?? null) as Record<string, unknown> | null;
  if (!airport || !isNonEmptyString(airport.iataCode)) return null;

  const env = (rec.envelope ?? null) as Record<string, unknown> | null;

  return {
    sessionId,
    bundleVersion: typeof rec.bundleVersion === 'string' ? rec.bundleVersion : '',
    certifiedAt: rec.certifiedAt,
    staleAfter: rec.staleAfter,
    airport: {
      iataCode: airport.iataCode,
      name: isNonEmptyString(airport.name) ? airport.name : airport.iataCode,
      city: isNonEmptyString(airport.city) ? airport.city : '',
      timezone: isNonEmptyString(airport.timezone) ? airport.timezone : 'UTC',
      lat: typeof airport.lat === 'number' ? airport.lat : null,
      lng: typeof airport.lng === 'number' ? airport.lng : null,
    },
    stops: normaliseStops(rec.stops),
    envelope: env
      ? {
          radiusMetres: num(env.radiusMetres),
          plannedRadiusMetres: num(env.plannedRadiusMetres),
          usableMinutes: num(env.usableMinutes),
          maxOneWayMinutes: num(env.maxOneWayMinutes),
        }
      : null,
    cachedAt: isNonEmptyString(rec.cachedAt) ? rec.cachedAt : rec.certifiedAt,
  };
}
