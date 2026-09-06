/**
 * Compass Home — Phase 10.
 *
 * GET /api/compass/home
 *   Assembles the context-aware Compass Home payload from real signals only:
 *     - bestNextMove     — top-ranked item from the Phase 7 pipeline (for_you)
 *     - circleActivity   — Phase 9 who's-around (privacy-guarded, approximate only)
 *     - startingSoon     — public events starting within the next 6 hours
 *     - tonightVibe      — tonight's real events (evening/night hours only)
 *     - weatherWindow    — tomorrow's forecast for the user's current city
 *
 *   Honesty rules (master roadmap): every section is backed by real data or
 *   omitted (null) — no template cards, no fabricated content. Weather comes
 *   from the cached Open-Meteo layer; events from the events table with the
 *   same visibility/state guards as the search_events tool; circle presence
 *   through getWhosAround, which gates every target through consent checks.
 *
 * Security: requireUser. Feature-gated on COMPASS_ENABLED like all Compass
 * surfaces — disabled flag returns an honest fallback envelope.
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isCompassEnabled } from "../compass/flags.js";
import { getCompassProfile } from "../compass/CompassProfileService.js";
import { buildCompassContext, defaultSignals } from "../compass/CompassContextEngine.js";
import { hydrateCompassItems } from "../compass/CompassItemHydrator.js";
import { buildSection } from "../compass/CompassFeedBuilder.js";
import { getWhosAround } from "../compass/CompassSocialEngine.js";
import { getWeatherContext } from "../lib/weatherCache.js";
import type { CompassProfile } from "../compass/types.js";
import {
  localHourFor,
  parseTzOffsetParam,
  fetchUserTimezone,
  nowUtcInstant as sharedNowUtcInstant,
} from "../lib/localTime.js";

// Re-exported for existing consumers/tests.
export { localHourFor };

const router = Router();

/* ── Test hooks ──────────────────────────────────────────────────────────────
 * The home payload is time-aware (morning vs night differ). Tests inject a
 * fixed UTC hour so both shapes are exercised deterministically.
 */
let _testHourUtc: number | null = null;
export function _setTestHourUtc(hour: number | null): void {
  _testHourUtc = hour;
}

/* ── Per-user short-lived payload cache ─────────────────────────────────────
 * The full home build (Phase 7 ranking + who's-around + events + weather) is
 * expensive (~1.7s observed). Repeat opens within a short window serve the
 * cached payload instantly. Mirrors the discovery L1 in-memory cache pattern.
 *
 * Safety:
 *   - Keyed strictly per user (plus the tz offset param, which shapes the
 *     payload) — never shared across users.
 *   - Checked only AFTER auth and the COMPASS_ENABLED flag check, so the
 *     feature flag and privacy gates always apply.
 *   - Only successful, non-fallback payloads are cached.
 */
const HOME_CACHE_TTL_MS = 45_000;
const HOME_CACHE_MAX_ENTRIES = 1_000;
let _ttlMs = HOME_CACHE_TTL_MS;
const homeCache = new Map<string, { payload: unknown; expiresAt: number }>();

export function _clearCompassHomeCache(): void {
  homeCache.clear();
}

/**
 * Drop every cached home payload for one user (all tz-offset variants).
 * Called by profile/privacy/preference/block/mute write routes so a change
 * is reflected on the very next Home open — not up to TTL later.
 */
export function invalidateCompassHomeCache(userId: string): void {
  const prefix = `${userId}|`;
  for (const key of homeCache.keys()) {
    if (key.startsWith(prefix)) homeCache.delete(key);
  }
}
export function _setTestHomeCacheTtlMs(ms: number | null): void {
  _ttlMs = ms ?? HOME_CACHE_TTL_MS;
}

/**
 * Cache keys must partition by the traveler's clock so a time-of-day boundary
 * crossing within the TTL never serves the previous bucket's payload.
 * Mirrors feedCacheKey in routes/compass.ts:
 *   - explicit client offset → keyed by offset + resolved bucket (the local
 *     hour is already computed before the cache lookup, so a bucket boundary
 *     crossing within the TTL produces a different key even for offset travelers)
 *   - no offset ("auto")     → keyed by the resolved time-of-day bucket,
 *     since the stored-timezone local hour can cross a bucket mid-TTL.
 */
export function homeCacheKey(
  userId: string,
  tzOffsetMinutes: number | null,
  resolvedLocalHour?: number | null,
): string {
  const tzPart =
    tzOffsetMinutes !== null
      ? typeof resolvedLocalHour === "number" && Number.isFinite(resolvedLocalHour)
        ? `${tzOffsetMinutes}-${timeOfDayForHour(resolvedLocalHour)}`
        : String(tzOffsetMinutes)
      : typeof resolvedLocalHour === "number" && Number.isFinite(resolvedLocalHour)
        ? `auto-${timeOfDayForHour(resolvedLocalHour)}`
        : "auto";
  return `${userId}|${tzPart}`;
}

function getCachedHome(key: string): unknown | null {
  const entry = homeCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    homeCache.delete(key);
    return null;
  }
  return entry.payload;
}

function setCachedHome(key: string, payload: unknown): void {
  if (homeCache.size >= HOME_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of homeCache) {
      if (v.expiresAt <= now) homeCache.delete(k);
    }
    // Still full after pruning expired entries — drop the oldest.
    if (homeCache.size >= HOME_CACHE_MAX_ENTRIES) {
      const oldest = homeCache.keys().next().value;
      if (oldest !== undefined) homeCache.delete(oldest);
    }
  }
  homeCache.set(key, { payload, expiresAt: Date.now() + _ttlMs });
}

/** Current UTC instant; when a test hour is injected, today's date at that UTC hour. */
function nowUtcInstant(): Date {
  if (_testHourUtc !== null) {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), _testHourUtc, 0, 0));
  }
  // Shared clock honours localTime's _setTestNowUtc; real time otherwise.
  return sharedNowUtcInstant();
}

export type TimeOfDay = "morning" | "afternoon" | "evening" | "night";

export function timeOfDayForHour(hour: number): TimeOfDay {
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

/* Local-time resolution (localHourFor / parseTzOffsetParam / fetchUserTimezone)
 * lives in ../lib/localTime.ts — shared with the feed routes and any other
 * time-aware Compass surface. */

function hiddenUserIds(profile: CompassProfile | null): Set<string> {
  return new Set([
    ...(profile?.blockedUserIds ?? []),
    ...(profile?.blockerUserIds ?? []),
    ...(profile?.mutedUserIds ?? []),
  ]);
}

/* ── Events: starting soon / tonight ────────────────────────────────────────
 * Same visibility/state guards as the search_events Compass tool. Hidden
 * (blocked/blocker/muted) hosts are filtered out before anything surfaces.
 */
interface HomeEvent {
  id: string;
  title: string;
  city: string | null;
  country: string | null;
  startsAt: string | null;
  category: string | null;
}

async function fetchUpcomingEvents(
  sc: any,
  profile: CompassProfile | null,
  fromIso: string,
  toIso: string,
  limit: number,
): Promise<HomeEvent[]> {
  try {
    let q: any = sc
      .from("events")
      .select("id, title, city, country, starts_at, category, host_id, state, visibility")
      .eq("visibility", "public")
      // `deleted` and `banned` are not labels of the `event_state` enum (draft |
      // open | full | waitlist | started | completed | cancelled | archived).
      // PostgREST rejected them 22P02, so this read failed whole and the
      // `if (error) return []` below made Compass Home's event rail
      // permanently empty. Predicate copied verbatim from
      // mapSearch.loadNearbyEvents / discoverySearch:615.
      .not("state", "in", '("draft","cancelled","archived")')
      .gte("starts_at", fromIso)
      .lte("starts_at", toIso)
      .order("starts_at", { ascending: true });
    if (profile?.currentCity) q = q.ilike("city", `%${profile.currentCity}%`);
    const { data, error } = await q.limit(limit * 3);
    if (error) return [];
    const hidden = hiddenUserIds(profile);
    return ((data ?? []) as any[])
      .filter((e) => !hidden.has(e.host_id as string))
      .slice(0, limit)
      .map((e) => ({
        id: String(e.id),
        title: String(e.title ?? ""),
        city: (e.city as string | null) ?? null,
        country: (e.country as string | null) ?? null,
        startsAt: (e.starts_at as string | null) ?? null,
        category: (e.category as string | null) ?? null,
      }));
  } catch {
    return [];
  }
}

/* ── Tonight's vibe ──────────────────────────────────────────────────────────
 * Real events happening tonight, summarised by their dominant category.
 * Only assembled during evening/night hours; hides honestly when nothing is on.
 */
function buildTonightVibe(events: HomeEvent[]): { headline: string; events: HomeEvent[] } | null {
  if (events.length === 0) return null;
  const counts = new Map<string, number>();
  for (const e of events) {
    const c = (e.category ?? "").trim().toLowerCase();
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const headline =
    events.length === 1
      ? `1 event on tonight`
      : `${events.length} events on tonight${top ? ` — ${top} leads the night` : ""}`;
  return { headline, events: events.slice(0, 4) };
}

/* ── Tomorrow's weather window ──────────────────────────────────────────────── */
interface WeatherWindow {
  city: string;
  date: string;
  summary: string;
  maxTempC: number;
  minTempC: number;
  precipMm: number;
  headline: string;
}

async function fetchWeatherWindow(profile: CompassProfile | null): Promise<WeatherWindow | null> {
  const city = profile?.currentCity;
  if (!city) return null;
  try {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
    const wx = await getWeatherContext(city, tomorrow, tomorrow);
    const f = wx?.forecasts?.find((d) => d.date === tomorrow) ?? wx?.forecasts?.[0];
    if (!f) return null;
    const rainy = f.precipMm > 2 || f.weatherCode >= 51;
    const headline = rainy
      ? `${f.summary} tomorrow — plan an indoor window`
      : `${f.summary} tomorrow — good window for outdoor plans`;
    return {
      city,
      date: f.date,
      summary: f.summary,
      maxTempC: f.maxTempC,
      minTempC: f.minTempC,
      precipMm: f.precipMm,
      headline,
    };
  } catch {
    return null;
  }
}

/* ── Route ──────────────────────────────────────────────────────────────────── */

router.get("/compass/home", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  const enabled = await isCompassEnabled(sc).catch(() => false);
  if (!enabled) {
    res.json({ compassEnabled: false, fallback: true });
    return;
  }

  const tzOffsetMinutes = parseTzOffsetParam((req.query as any)?.tzOffsetMinutes);

  // Resolve the traveler's local hour BEFORE the cache lookup: for "auto"
  // (no client offset) travelers the cache key must include the resolved
  // time-of-day bucket, or a bucket boundary crossing within the TTL would
  // briefly serve the previous bucket's payload.
  const nowUtc = nowUtcInstant();
  const timezone =
    tzOffsetMinutes !== null ? null : await fetchUserTimezone(sc, user.id).catch(() => null);
  const localHour = localHourFor(nowUtc, tzOffsetMinutes, timezone);

  const cacheKey = homeCacheKey(user.id, tzOffsetMinutes, localHour);
  const cached = getCachedHome(cacheKey);
  if (cached !== null) {
    res.json(cached);
    return;
  }

  try {
    const profile = await getCompassProfile(sc, user.id);
    const timeOfDay = timeOfDayForHour(localHour);
    const signals = { ...defaultSignals(profile), hourUtc: localHour };
    const context = buildCompassContext(profile, signals);

    const now = new Date();
    const in6h = new Date(now.getTime() + 6 * 60 * 60 * 1_000);
    const in12h = new Date(now.getTime() + 12 * 60 * 60 * 1_000);
    const isEveningOrNight = timeOfDay === "evening" || timeOfDay === "night";

    const [bestNextMove, circleActivity, startingSoon, tonightEvents, weatherWindow] =
      await Promise.all([
        // Best next move — top item from the Phase 7 pipeline (for_you section)
        (async () => {
          try {
            const items = await hydrateCompassItems(sc, profile);
            if (items.length === 0) return null;
            const result = await buildSection("for_you", items, profile, context, sc, null);
            const top: any = result.section?.items?.[0] ?? null;
            if (!top?.item) return null;
            return {
              id: String(top.item.id),
              type: String(top.item.type ?? ""),
              title: (top.item.title as string | undefined) ?? null,
              category: (top.item.category as string | undefined) ?? null,
              city: (top.item.city as string | undefined) ?? null,
              data: top.item.data ?? null,
              explanationKey: top.explanationKey ?? null,
            };
          } catch {
            return null;
          }
        })(),
        // Circle activity — Phase 9 who's-around, consent-gated per target
        (async () => {
          try {
            const { people } = await getWhosAround(sc, user.id, hiddenUserIds(profile));
            if (people.length === 0) return null;
            return {
              people: people.slice(0, 5).map((p: any) => ({
                label: p.label,
                handle: p.handle ?? null,
                status: p.status,
                statusLabel: p.statusLabel ?? null,
                approximateArea: p.approximateArea ?? null,
                venue: p.venue ?? null,
                context: p.context ?? null,
              })),
            };
          } catch {
            return null;
          }
        })(),
        // Starting soon — public events in the next 6 hours
        fetchUpcomingEvents(sc, profile, now.toISOString(), in6h.toISOString(), 5),
        // Tonight — events within 12 hours, only assembled in evening/night hours
        isEveningOrNight
          ? fetchUpcomingEvents(sc, profile, now.toISOString(), in12h.toISOString(), 8)
          : Promise.resolve([] as HomeEvent[]),
        fetchWeatherWindow(profile),
      ]);

    const payload = {
      compassEnabled: true,
      fallback: false,
      timeOfDay,
      contextState: context.contextState,
      city: profile.currentCity ?? null,
      bestNextMove,
      circleActivity,
      startingSoon: startingSoon.length > 0 ? startingSoon : null,
      tonightVibe: isEveningOrNight ? buildTonightVibe(tonightEvents) : null,
      weatherWindow,
    };
    setCachedHome(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "compass/home: build failed, returning fallback");
    res.json({ compassEnabled: true, fallback: true });
  }
}));

export default router;
