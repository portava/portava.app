/**
 * discoveryLegacyScenarios — a fixed set of Discovery requests whose responses
 * are pinned byte-for-byte against the tree BEFORE census-discovery §47.
 *
 * WHY A GOLDEN, AND WHY IT IS HONEST. "Legacy mode is byte-identical to today"
 * is a claim about a DIFFERENT tree, so no assertion written against this tree
 * alone can prove it: a test that compares legacy with itself passes for any
 * change to legacy. The golden at `src/test/fixtures/discoveryLegacyGolden.json`
 * was produced by running THIS module against `709b7b800` (the parent of the
 * §47 commits) — `routes/discovery.ts` and `lib/discoveryCacheEligibility.ts`
 * checked out at that commit, everything else unchanged — and the test replays
 * it against the working tree.
 *
 * WHAT IS NORMALISED AWAY, AND WHY EACH IS NOT A LOOPHOLE:
 *   - `meta.timings` — wall-clock milliseconds.
 *   - any key matching /recommendation|exposure|servedAt|sessionId/i — minted
 *     per request from a random session id, and the telemetry lane (P3) owns
 *     their shape; pinning them here would pin another lane's contract.
 * Nothing else is removed. Order, membership, every place field, `total`,
 * `cursor`, `cached`, `meta.cacheLevel`, `refusal` and `ageFilterMeta` are
 * compared exactly.
 *
 * NO SCENARIO TRIGGERS A §47 RULE: nobody is muted, every submitter is active,
 * no row is moderated, and the one age-filtered request is an ADULT's. That is
 * the point — §47 changes what an ineligible row does, and must change nothing
 * else.
 */
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import discoveryRouter, {
  _injectTestCacheEntry, _clearTestCacheEntry, _clearTestCompassCache, type DiscoveryPlace,
} from "../../routes/discovery.js";
import { _setTestServiceClient } from "../../lib/supabase.js";
import { _setTestClient } from "../../lib/http.js";
import { invalidateDiscoveryEngineModeCache } from "../../lib/discoveryEngineMode.js";
import { invalidateFlagsCache } from "../../compass/flags.js";
import { invalidateServeLogFlagCache } from "../../lib/discoveryServeLog.js";
import { invalidateCandidateProjectionFlagCache } from "../../lib/discoveryCandidate.js";
import { invalidateLiveRankFlagCache } from "../../lib/discoveryLiveRankRead.js";
import { invalidateDiscoveryModifiersFlagCache } from "../../lib/discoveryModifiers.js";
import { invalidateOnePipelineFlagCache } from "../../lib/discoveryOnePipeline.js";
import { newWorld, worldClient, flag, communityRow, profileRow, overpassBody, type WorldState } from "./fakeDiscoveryWorld.js";

export const LEGACY_VIEWER = "aaaa0000-0000-4000-8000-00000000000a";
export const LEGACY_SUBMITTER_S = "55550000-0000-4000-8000-000000000005";
export const LEGACY_SUBMITTER_T = "77770000-0000-4000-8000-000000000007";
export const LEGACY_TOKEN = "tok-legacy";

export const CACHE_A_FOR_YOU = "miami:for_you:10";

export function osmCached(): DiscoveryPlace[] {
  const mk = (n: number, name: string, type: string, rating: number | null, saved: number): DiscoveryPlace => ({
    id: `node/${n}`, name, category: "for_you", type, description: null, distanceKm: n / 10,
    lat: 25.77 + n / 1000, lng: -80.19, tags: [type], address: null, neighborhood: null,
    website: null, phone: null, openingHours: null, rating, isOpenNow: null, savedCount: saved,
  } as DiscoveryPlace);
  return [mk(1, "Cafe Uno", "cafe", 4.5, 2), mk(2, "Harbour Walk", "attraction", null, 9), mk(3, "Night Owl", "bar", 3.9, 0), mk(4, "Museo", "museum", 4.8, 5)];
}

export function legacyWorld(opts: { compass?: boolean; extraFlags?: ReturnType<typeof flag>[] } = {}): WorldState {
  return newWorld({
    users: { [LEGACY_TOKEN]: LEGACY_VIEWER },
    tables: {
      feature_flags: [...(opts.compass ? [flag("COMPASS_V1_RULE_BASED_ENABLED", true)] : []), ...(opts.extraFlags ?? [])],
      discovery_places: [
        communityRow("p1", { saved_count: 7 }),
        communityRow("p2", { submitted_by: LEGACY_SUBMITTER_S, saved_count: 1 }),
        communityRow("p3", { submitted_by: LEGACY_SUBMITTER_T, saved_count: 12, rating: 4.9 }),
      ],
      profiles: [profileRow(LEGACY_VIEWER), profileRow(LEGACY_SUBMITTER_S), profileRow(LEGACY_SUBMITTER_T)],
      blocks: [], user_mutes: [], rank_events: [], identity_verifications: [],
    },
  });
}

const STRIP = /recommendation|exposure|servedAt|sessionId/i;

export function normalise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalise);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (STRIP.test(k)) continue;
      if (k === "timings") continue;
      out[k] = normalise(x);
    }
    return out;
  }
  return v;
}

function resetCaches(): void {
  _clearTestCompassCache();
  _clearTestCacheEntry(CACHE_A_FOR_YOU);
  _clearTestCacheEntry("miami:food:10");
  invalidateDiscoveryEngineModeCache();
  invalidateFlagsCache();
  invalidateServeLogFlagCache();
  invalidateCandidateProjectionFlagCache();
  invalidateLiveRankFlagCache();
  invalidateDiscoveryModifiersFlagCache();
  invalidateOnePipelineFlagCache();
}

interface Scenario {
  name: string;
  compass?: boolean;
  seedCacheA?: boolean;
  /** Overpass answers with these nodes (cold paths); otherwise it is blocked. */
  overpass?: boolean;
  path: string;
  auth: boolean;
  /** Issue the same request this many times and record the LAST (cache-B hit). */
  repeat?: number;
}

const Q = "destination=Miami&lat=25.77&lng=-80.19&radiusKm=10";

export const LEGACY_SCENARIOS: Scenario[] = [
  { name: "S1 anonymous cache-A hit, for_you", seedCacheA: true, path: `/discovery?${Q}&category=for_you`, auth: false },
  { name: "S2 signed-in cache-A hit, for_you", seedCacheA: true, path: `/discovery?${Q}&category=for_you`, auth: true },
  { name: "S3 signed-in cache-A hit, popular + openNow", seedCacheA: true, path: `/discovery?${Q}&category=for_you&sortBy=popular&openNow=1`, auth: true },
  { name: "S4 signed-in cache-A hit, adult with open_to_me", seedCacheA: true, path: `/discovery?${Q}&category=for_you&ageFilter=open_to_me`, auth: true },
  { name: "S5 anonymous cold fetch, food", overpass: true, path: `/discovery?${Q}&category=food`, auth: false },
  { name: "S6 signed-in cold fetch, food (PDE-ranked in every mode)", overpass: true, path: `/discovery?${Q}&category=food`, auth: true },
  { name: "S7 signed-in Compass fresh rank, for_you", compass: true, path: `/discovery?${Q}&category=for_you`, auth: true },
  { name: "S8 signed-in Compass cache-B hit, for_you", compass: true, path: `/discovery?${Q}&category=for_you`, auth: true, repeat: 2 },
  { name: "S9 anonymous community", path: "/discovery/community?city=Miami", auth: false },
  { name: "S10 signed-in community", path: "/discovery/community?city=Miami", auth: true },
  { name: "S11 signed-in feed", path: "/discovery/feed?city=Miami&lat=25.77&lng=-80.19&category=food", auth: true },
];

/**
 * `extraFlags` (census-discovery §79) seeds more flag rows into every scenario's
 * world — e.g. a new flag present and FALSE — so a suite can prove the golden
 * holds with the row there as well as with it absent. Absent ⇒ the world the
 * golden was captured in.
 */
export async function runLegacyScenarios(extraFlags: ReturnType<typeof flag>[] = []): Promise<Record<string, unknown>> {
  const server: Server = createServer(express()
    .use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); })
    .use(discoveryRouter));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const realFetch = globalThis.fetch;
  let overpassOn = false;
  globalThis.fetch = (async (url: any, init?: any) => {
    const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
    if (s.includes("overpass-api.de")) {
      if (!overpassOn) throw new Error("Network blocked in test environment");
      return new Response(JSON.stringify(overpassBody([
        { id: 11, name: "Taco Stand", amenity: "fast_food" },
        { id: 12, name: "Bistro Doce", amenity: "restaurant", lat: 25.775 },
        { id: 13, name: "Corner Bar", amenity: "bar", lat: 25.78 },
      ])), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (s.includes("nominatim.openstreetmap.org")) throw new Error("Network blocked in test environment");
    return realFetch(url, init);
  }) as typeof globalThis.fetch;

  const out: Record<string, unknown> = {};
  try {
    for (const sc of LEGACY_SCENARIOS) {
      resetCaches();
      const w = legacyWorld({ compass: sc.compass, extraFlags });
      const c = worldClient(w);
      _setTestServiceClient(c as any);
      _setTestClient(c as any, true);
      overpassOn = !!sc.overpass;
      if (sc.seedCacheA) _injectTestCacheEntry(CACHE_A_FOR_YOU, osmCached());
      let body: unknown = null;
      for (let i = 0; i < (sc.repeat ?? 1); i++) {
        const res = await realFetch(`${base}${sc.path}`, { headers: sc.auth ? { authorization: `Bearer ${LEGACY_TOKEN}` } : {} });
        body = { status: res.status, body: await res.json() };
      }
      out[sc.name] = normalise(body);
    }
  } finally {
    globalThis.fetch = realFetch;
    resetCaches();
    _setTestServiceClient(null);
    await new Promise<void>((r) => server.close(() => r()));
  }
  return out;
}
