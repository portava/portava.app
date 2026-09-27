/**
 * census-discovery DC-33 / §60 — the route→service→projection→CLIENT leg, as ONE
 * test, across the two packages.
 *
 * SPEC: `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:38` — *"Test real
 * route→service→projection→client wiring; include cache hits, expiry,
 * permission changes, sparse coverage, empty candidates, dependency failure and
 * retry."*
 *
 * WHAT WAS MISSING. §14.5 graded DC-33's client leg FAIL "as a leg": every
 * server suite stops at the HTTP response, and every client suite mocks the
 * service (or `fetch`'s response shape) it would have to cross. So the parse
 * boundary (`withParsedRefusal`), the device cache, the viewer lease and the
 * why-now receipt stamp were each proved against a hand-written body that a
 * server change could silently stop resembling.
 *
 * WHAT RUNS HERE, AND WHAT IS STOOD IN FOR
 *   REAL  the Discovery and rank-events express routers, in-process, over a
 *         real loopback socket — every server lib they call (serve log,
 *         recommendation ids, dismissal gate, candidate projection, live rank,
 *         refusal constructors, block/mute policy);
 *   REAL  `travel-buddy-standalone/src/services/discovery.ts` — the shipping
 *         client module: its `fetch`, its `openDiscoveryLease` header, its
 *         `withParsedRefusal` / `parseRefusal` boundary, its receipt stamp and
 *         its per-viewer device cache — plus the client projection
 *         (`features/discovery/candidateProjection.ts`) and byline resolver
 *         (`features/discovery/communityByline.ts`) a card renders through;
 *   DOUBLE the database, as the PostgREST client every server route suite uses
 *         (helpers/fakeDiscoveryTelemetryDb, helpers/fakeMapDb — both checked
 *         against the real supabase-js by supabaseContract.test.ts);
 *   DOUBLE Nominatim / Overpass (no network), and the viewer's token SOURCE —
 *         `_setDiscoveryTokenSourceForTests` replaces where the client gets a
 *         token (apiToken → lib/supabase → react-native cannot load under
 *         Node), and nothing downstream of it.
 * Nothing mocks the client service, and nothing hand-writes a response body:
 * every body the client parses here was produced by the route.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryClientRouteE2E.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import discoveryRouter, {
  _setTestDbPlacesOverride, _injectTestCacheEntry, _clearTestCacheEntry, _clearTestCompassCache,
  type DiscoveryPlace as ServerPlace,
} from "../routes/discovery.js";
import rankEventsRouter, { _resetRecommendationIdSchemaLatch } from "../routes/rankEvents.js";
import { invalidateServeLogFlagCache, DiscoveryServePoint, _resetServeRequestTableLatch } from "../lib/discoveryServeLog.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { invalidateLiveRankFlagCache } from "../lib/discoveryLiveRankRead.js";
import { invalidateCandidateProjectionFlagCache } from "../lib/discoveryCandidate.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { recommendationRecordsFromServeRequest } from "../lib/discoveryRecommendationRecord.js";
import { makeTelemetryDb } from "./helpers/fakeDiscoveryTelemetryDb.js";
import { makeFakeMapDb, type FakeState } from "./helpers/fakeMapDb.js";

// ── THE CLIENT, imported as the app imports it ───────────────────────────────
import {
  getDiscoveryPlaces, getCachedDiscoveryPlaces, isDiscoveryCacheFresh, getCommunityPlaces, getDiscoveryFeed,
  refusedEverything, _resetDiscoveryClientCache, _setDiscoveryTokenSourceForTests,
  type DiscoveryFilters, type DiscoveryResult,
} from "../../../../travel-buddy-standalone/src/services/discovery.ts";
import {
  _resetDiscoveryViewerScopeForTests, setDiscoveryViewerFromSession, invalidateDiscoveryCaches, VIEWER_CHANGED_ERROR,
} from "../../../../travel-buddy-standalone/src/services/discoveryViewerScope.ts";
import { parseDiscoveryCandidate, whyNowPresentation } from "../../../../travel-buddy-standalone/src/features/discovery/candidateProjection.ts";
import { communityBylineText } from "../../../../travel-buddy-standalone/src/features/discovery/communityByline.ts";

// ── Upstreams: no network. Nominatim answers through a per-test handler. ─────
type Reply = { status: number; body: unknown };
let nominatim: (() => Reply) | null = null;
const _originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (s.includes("nominatim.openstreetmap.org") && nominatim) {
    const { status, body } = nominatim();
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }
  if (s.includes("overpass-api.de") || s.includes("nominatim.openstreetmap.org")) throw new Error("network blocked");
  return _originalFetch(url, init);
}) as typeof globalThis.fetch;

// ── Viewers. JWT-SHAPED tokens, so the client keys its cache by the `sub`
// claim exactly as it does in production (discoveryViewerScope.viewerKeyForToken).
const ALICE = "a11ce000-0000-4000-8000-0000000000e2";
const BOB   = "b0b00000-0000-4000-8000-0000000000e2";
const XAVI  = "c0ffee00-0000-4000-8000-0000000000e2";   // a submitter Alice blocked
const jwt = (sub: string) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.sig`;
const TOKEN = { alice: jwt(ALICE), bob: jwt(BOB) } as const;
const USERS = { [TOKEN.alice]: ALICE, [TOKEN.bob]: BOB };

/** Who the client is signed in as. `null` is signed out. */
let signedIn: string | null = null;

// ── What reached the server: every request's path and whether it carried a token.
let seen: Array<{ path: string; auth: string | undefined }> = [];
/** When set, the NEXT matching request waits here — how an in-flight account switch is staged. */
let hold: { match: (path: string) => boolean; arrived: () => void; release: Promise<void> } | null = null;
/** When set, the NEXT matching request is answered 502 by the edge — a transport failure. */
let failNext: ((path: string) => boolean) | null = null;

let server: Server;
let base = "";
let db: ReturnType<typeof makeTelemetryDb>;

const KEY = "miami:for_you:10";   // routes/discovery.ts cacheKey(destination, category, radiusKm)
const FILTERS: DiscoveryFilters = { radiusKm: 10, openNow: false, minRating: null };

function place(id: string, savedCount: number): ServerPlace {
  return {
    id: `db/${id}`, name: id, category: "for_you", type: "traveler_pick",
    description: null, distanceKm: 1.0, lat: 25.77, lng: -80.19, tags: [],
    address: "Miami, FL", website: null, phone: null, openingHours: null,
    rating: null, isOpenNow: null, savedCount,
  } as ServerPlace;
}
const FOUR = () => [place("p1", 1), place("p2", 2), place("p3", 3), place("p4", 4)];

/** The page the For You tab asks for, through the shipping client. */
const loadMiami = () => getDiscoveryPlaces("Miami", "for_you", FILTERS, 1, null, null, null, null, 25.77, -80.19);

function install(opts: Parameters<typeof makeTelemetryDb>[0] = {}) {
  db = makeTelemetryDb({ users: USERS, flags: { discovery_serve_log_enabled: { enabled: true } }, ...opts });
  _setTestClient(db.client as any, true);
  _setTestServiceClient(db.client as any);
}

async function postOutcome(token: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await _originalFetch(`${base}/api/rank-events/outcome`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Serve-log writes land AFTER the response. Poll; never guess. */
async function until<T>(read: () => T, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read();
    if (ok(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
}

const ok = <T>(r: { ok: true; data: T } | { ok: false; error: string }, what: string): T => {
  assert.ok(r.ok, `${what}: the client answered ok:false (${(r as { error?: string }).error})`);
  return (r as { ok: true; data: T }).data;
};
const idsOf = (d: DiscoveryResult) => d.places.map((p) => p.id);
const recIdsOf = (d: DiscoveryResult) => d.places.map((p) => p.recommendationId);

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use(async (req, res, next) => {
    seen.push({ path: req.path, auth: req.headers.authorization });
    if (failNext?.(req.path)) { failNext = null; res.status(502).json({ error: "bad_gateway" }); return; }
    if (hold?.match(req.path)) { const h = hold; hold = null; h.arrived(); await h.release; }
    next();
  });
  app.use("/api", discoveryRouter);
  app.use("/api", rankEventsRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.EXPO_PUBLIC_API_BASE_URL = base;
  _setDiscoveryTokenSourceForTests(async () => (signedIn === ALICE ? TOKEN.alice : signedIn === BOB ? TOKEN.bob : null));
});

after(async () => {
  _setDiscoveryTokenSourceForTests(null);
  globalThis.fetch = _originalFetch;
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  seen = []; hold = null; failNext = null; nominatim = null; signedIn = null;
  _resetDiscoveryViewerScopeForTests();
  _resetDiscoveryClientCache();
  invalidateServeLogFlagCache();
  invalidateDiscoveryEngineModeCache();
  invalidateFlagsCache();
  invalidateLiveRankFlagCache();
  invalidateCandidateProjectionFlagCache();
  _clearPromotedScopeCache();
  _resetRecommendationIdSchemaLatch();
  _resetServeRequestTableLatch();
  _clearTestCompassCache();
});

afterEach(() => {
  _clearTestCacheEntry(KEY);
  _setTestDbPlacesOverride(null);
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
});

// ═════════════════════════════════════════════════════════════════════════════
// A normal page, signed in and signed out, and the served id's round trip
// ═════════════════════════════════════════════════════════════════════════════

describe("DC-33 — a normal page, route → client", () => {
  it("E1. signed in: the client holds the route's page, each item's served id is the id of ITS stored exposure, and the next paint is a device-cache hit", async () => {
    install();
    _setTestDbPlacesOverride(async () => []);
    _injectTestCacheEntry(KEY, FOUR());
    signedIn = ALICE;

    const page = ok(await loadMiami(), "Alice's page");
    assert.deepEqual(idsOf(page), ["db/p1", "db/p2", "db/p3", "db/p4"], "the client holds exactly the served page, in served order");
    assert.equal(page.refusal, undefined, "a healthy serve carries no refusal through the parse boundary");
    assert.equal(refusedEverything(page.refusal), false);
    assert.deepEqual(seen.filter((s) => s.path === "/api/discovery").map((s) => s.auth), [`Bearer ${TOKEN.alice}`],
      "the read went out AS the viewer — the header the route resolved her from");

    // The served-recommendation round trip, hops 1–2: the id the CLIENT now holds
    // for position i is the id on the rank_events row the ROUTE wrote for position i.
    const rows = await until(() => db.impressions(), (x) => x.length >= 4);
    assert.equal(rows[0]!.features.servePoint, DiscoveryServePoint.CACHE_A_L1, "precondition: the cache-A serve point wrote these");
    for (const row of rows) {
      assert.equal(row.user_id, ALICE);
      assert.equal(page.places[row.position]!.recommendationId, row.recommendation_id,
        `position ${row.position}: the id the client holds names the exposure the route stored`);
    }

    // Cache hit on the device: painted without a request, and still Alice's.
    const before = seen.length;
    const cached = getCachedDiscoveryPlaces("Miami", "for_you", 10, 1);
    assert.ok(cached, "a healthy page is kept for the next mount");
    assert.deepEqual(idsOf(cached!), idsOf(page));
    assert.equal(isDiscoveryCacheFresh("Miami", "for_you", 10, 1), true);
    assert.equal(seen.length, before, "a device-cache hit makes no request");
  });

  it("E1b. hop 3–4: the id the client holds, echoed on an outcome, moves THAT exposure and no other", async () => {
    install();
    _setTestDbPlacesOverride(async () => []);
    _injectTestCacheEntry(KEY, FOUR());
    signedIn = ALICE;
    const page = ok(await loadMiami(), "Alice's page");
    await until(() => db.impressions(), (x) => x.length >= 4);

    const tapped = page.places[2]!;
    const o = await postOutcome(TOKEN.alice, {
      item_id: tapped.id, surface: "discovery", outcome: "tap", recommendation_id: tapped.recommendationId,
    });
    assert.equal(o.status, 200);
    const moved = db.impressions().filter((r) => r.outcome === "tap");
    assert.deepEqual(moved.map((r) => r.recommendation_id), [tapped.recommendationId], "exactly the exposure the client's id names");

    // Bob replays the id Alice's client holds: nothing is credited to anyone.
    const replay = await postOutcome(TOKEN.bob, {
      item_id: page.places[0]!.id, surface: "discovery", outcome: "save", recommendation_id: page.places[0]!.recommendationId,
    });
    assert.equal(replay.status, 404, "another viewer's served id binds nothing");
    assert.equal(db.impressions().filter((r) => r.outcome === "save").length, 0);
  });

  it("E2. signed out: NO Authorization header leaves the client, the route serves anonymously, and the items still carry ids nobody is credited with", async () => {
    install();
    _setTestDbPlacesOverride(async () => []);
    _injectTestCacheEntry(KEY, FOUR());
    signedIn = null;

    const page = ok(await loadMiami(), "the anonymous page");
    assert.deepEqual(idsOf(page), ["db/p1", "db/p2", "db/p3", "db/p4"]);
    assert.deepEqual(seen.filter((s) => s.path === "/api/discovery").map((s) => s.auth), [undefined],
      "omitted, not blanked: a signed-out read carries no Authorization header at all");
    assert.ok(recIdsOf(page).every((id) => typeof id === "string" && id.length === 22), "04 §5: anonymous items are stamped too");

    const req = await until(() => db.serveRequests(), (x) => x.length >= 1);
    assert.equal(req[0]!.viewer_class, "anonymous", "the route resolved no viewer");
    assert.equal(req[0]!.user_id, null);
    assert.deepEqual(recommendationRecordsFromServeRequest(req[0]!).map((r) => r.recommendation_id), recIdsOf(page),
      "the anonymous serve's durable record reproduces exactly the ids the client holds");
    assert.deepEqual(db.impressions(), [], "and no exposure is attributed to a user");
  });

  it("E3. retry: the same request twice returns the same page (a new exposure each time), and a transport failure in between neither caches nor clears the good page", async () => {
    install();
    _setTestDbPlacesOverride(async () => []);
    _injectTestCacheEntry(KEY, FOUR());
    signedIn = ALICE;

    const first = ok(await loadMiami(), "first");
    failNext = (p) => p === "/api/discovery";
    const failed = await loadMiami();
    assert.deepEqual(failed, { ok: false, error: "HTTP 502" }, "a failed read is a failure on the client, never an empty page");
    assert.deepEqual(idsOf(getCachedDiscoveryPlaces("Miami", "for_you", 10, 1)!), idsOf(first),
      "the failure wrote nothing: the last good page is still what the device holds");
    const second = ok(await loadMiami(), "retry");
    assert.deepEqual(idsOf(second), idsOf(first), "the same request, answered the same way");
    assert.equal(new Set([...recIdsOf(first), ...recIdsOf(second)]).size, 8,
      "two serves are two exposures: no served id is reused across them");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Refusals: dependency failure, sparse coverage, empty candidates
// ═════════════════════════════════════════════════════════════════════════════

describe("DC-33 / DV-83 — a refusal reaches the client as a refusal, never as an empty result", () => {
  it("R1. dependency failure (Nominatim 429): coverage \"nothing\" arrives, is not cached, is answered the same on retry, and the recovery is not masked by the device", async () => {
    install();
    signedIn = ALICE;
    nominatim = () => ({ status: 429, body: { error: "Too Many Requests" } });
    const load = () => getDiscoveryPlaces("Atlantis", "for_you", FILTERS);   // no coordinates: the route must geocode

    const refused = ok(await load(), "refused page");
    assert.deepEqual(refused.places, []);
    assert.ok(refused.refusal, "the refusal survived the client's parse boundary");
    assert.equal(refused.refusal!.coverage, "nothing");
    assert.equal(refused.refusal!.route, "GET /discovery");
    assert.equal(refusedEverything(refused.refusal), true, "the predicate every consumer branches on says so");
    assert.equal(getCachedDiscoveryPlaces("Atlantis", "for_you", 10, 1), null, "a refused body is never written to the device cache");

    const again = ok(await load(), "the same request again");
    assert.deepEqual(again.refusal, refused.refusal, "retry: the same outage, the same answer");

    // Nominatim recovers. Because nothing was cached, the next load reaches the route.
    nominatim = () => ({ status: 200, body: [{ lat: "10.0", lon: "10.0", display_name: "Atlantis" }] });
    _setTestDbPlacesOverride(async () => FOUR());
    const recovered = ok(await load(), "after recovery");
    assert.equal(recovered.refusal, undefined);
    assert.equal(recovered.places.length, 4, "the recovered answer is served, not the outage replayed from the phone");
  });

  it("R2. sparse coverage: an unreadable curated source arrives as coverage \"partial\", naming it, and the real rows beside it are kept", async () => {
    install({ failReads: { discovery_places: { message: "discovery_places unavailable" } } });
    _injectTestCacheEntry(KEY, [place("osm1", 0), place("osm2", 0)]);
    signedIn = ALICE;

    const page = ok(await loadMiami(), "partial page");
    assert.equal(page.places.length, 2, "the half that answered is a real result");
    assert.equal(page.refusal?.coverage, "partial");
    assert.deepEqual(page.refusal?.failedSources, ["discovery_places"], "the client can name what is missing");
    assert.equal(refusedEverything(page.refusal), false, "partial is not \"nothing\"");
    assert.ok(getCachedDiscoveryPlaces("Miami", "for_you", 10, 1),
      "partial IS cached, by the service's documented rule: its items are real exposure");
  });

  it("R3. empty candidates: a genuinely empty city is an empty RESULT — no refusal, cached like any answer", async () => {
    install();
    _setTestDbPlacesOverride(async () => []);
    _injectTestCacheEntry(KEY, []);
    signedIn = ALICE;

    const page = ok(await loadMiami(), "empty page");
    assert.deepEqual(page.places, []);
    assert.equal(page.refusal, undefined, "emptiness the route could vouch for carries no refusal");
    assert.equal(refusedEverything(page.refusal), false);
    assert.deepEqual(getCachedDiscoveryPlaces("Miami", "for_you", 10, 1)?.places, [], "a real empty answer is kept");
  });

  it("R4. the feed the Live-from-events rail reads: a geocoder outage is \"nothing\", and the client drops the session id a refused load has no exposure behind", async () => {
    install();
    signedIn = ALICE;
    nominatim = () => ({ status: 429, body: { error: "Too Many Requests" } });
    // A city no earlier case geocoded: the route's in-process geocode cache must not answer for Nominatim.
    const refused = ok(await getDiscoveryFeed({ destination: "Lemuria", includePlaces: false }), "refused feed");
    assert.equal(refused.refusal?.coverage, "nothing");
    assert.equal(refused.refusal?.route, "GET /discovery/feed");
    assert.deepEqual(refused.posts, []);
    assert.equal(refused.sessionId, null, "no outcome can be reported against a load that served nothing");

    const healthy = ok(await getDiscoveryFeed({ destination: "Miami", lat: 25.77, lng: -80.19, includePlaces: false }), "healthy feed");
    assert.equal(healthy.refusal, undefined);
    assert.equal(typeof healthy.sessionId, "string", "control: a real load keeps its served rank context");
  });

  it("R5. the community read: an unreadable table is \"nothing\" on the client, not a city with no traveler places", async () => {
    install({ failReads: { discovery_places: { message: "discovery_places unavailable" } } });
    signedIn = ALICE;
    const r = await getCommunityPlaces("Cebu");
    const data = ok(r, "refused community read");
    assert.deepEqual(data.items, []);
    assert.equal(data.refusal?.coverage, "nothing");
    assert.equal(data.refusal?.code, "community_places_read_failed");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Why-now: validity from the route, expiry on the device's clock
// ═════════════════════════════════════════════════════════════════════════════

describe("DC-33 / DSV2-04 — why-now travels with its validity and expires on the phone", () => {
  const P1 = "11111111-aaaa-4aaa-8aaa-1111111111e2";
  const P2 = "22222222-bbbb-4bbb-8bbb-2222222222e2";
  const iso = (ms: number) => new Date(ms).toISOString();

  it("W1. the served duration becomes a device horizon: current strictly before it, explicitly stale at it, and a cache repaint keeps the ORIGINAL receipt", async () => {
    const now = Date.now();
    const world: FakeState = {
      feature_flags: [
        { flag: "intel_live_label_crowd", enabled: true },
        { flag: "intel_claim_projection_crowd", enabled: true },
        { flag: "intel_capture_quick_signal", enabled: true },
        { flag: "intel_limited_live", enabled: true },
        { flag: "discovery_live_rank_enabled", enabled: true },
        { flag: "discovery_candidate_projection_enabled", enabled: true },
      ],
      intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }],
      intel_state_snapshots: [{
        id: "snap-e2e-p1", subject_id: P1, zone_id: null, claim_type: "crowd.level", value: { level: "busy" },
        confidence: 0.9, source_count: 30, observed_at: iso(now - 3 * 60_000), expires_at: iso(now + 45 * 60_000),
        privacy_eligible: true, conflict_state: "none", source_class: "firsthand_unverified", computed_at: iso(now - 3 * 60_000),
      }],
    };
    _setTestServiceClient(makeFakeMapDb(world, { token: TOKEN.alice, userId: ALICE }) as any);
    _setTestDbPlacesOverride(async () => []);
    const withCanonical = (id: string, name: string) => ({ ...place(name, 1), id: `db/${id}`, canonicalPlaceId: id } as ServerPlace);
    _injectTestCacheEntry(KEY, [withCanonical(P1, "live"), withCanonical(P2, "quiet")]);
    signedIn = ALICE;

    const t0 = Date.now();
    const page = ok(await loadMiami(), "why-now page");
    const t1 = Date.now();
    const live = page.places.find((p) => p.id === `db/${P1}`)!;
    const unseen = page.places.find((p) => p.id === `db/${P2}`)!;
    const raw = live.candidate as { whyNow: string[] | null; whyNowValidForMs: number | null; receivedAtMs: number };
    assert.deepEqual(raw.whyNow, ["crowd_busy"], "the claim's own vocabulary reached the client");
    assert.ok(typeof raw.whyNowValidForMs === "number" && raw.whyNowValidForMs > 0 && raw.whyNowValidForMs <= 45 * 60_000,
      `the route sent a validity no longer than the claim's own expiry (got ${raw.whyNowValidForMs})`);
    assert.ok(raw.receivedAtMs >= t0 && raw.receivedAtMs <= t1, "stamped with the instant THIS device received it");

    const c = parseDiscoveryCandidate(live.candidate)!;
    assert.equal(c.whyNowExpiresAtMs, raw.receivedAtMs + raw.whyNowValidForMs!, "horizon = device receipt + server duration");
    const h = c.whyNowExpiresAtMs!;
    assert.deepEqual(whyNowPresentation(c, h - 1), { claims: ["crowd busy"], stale: false, expiresAtMs: h }, "current strictly before the horizon");
    assert.deepEqual(whyNowPresentation(c, h), { claims: ["crowd busy"], stale: true, expiresAtMs: null }, "explicitly stale AT it");
    assert.deepEqual(whyNowPresentation(parseDiscoveryCandidate(unseen.candidate), h - 1), { claims: [], stale: false, expiresAtMs: null },
      "nothing observed: no claim, never an invented one");

    const repaint = getCachedDiscoveryPlaces("Miami", "for_you", 10, 1)!.places.find((p) => p.id === `db/${P1}`)!;
    assert.equal(parseDiscoveryCandidate(repaint.candidate)!.whyNowExpiresAtMs, h,
      "expiry: a page repainted from the device cache is not re-dated, so the claim still expires on schedule");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Permission changes and cross-viewer isolation, through the client path
// ═════════════════════════════════════════════════════════════════════════════

describe("DC-33 — permission changes and cross-viewer isolation", () => {
  it("X1. Alice's accepted \"Not interested\" reaches HER next page and not Bob's; Bob never paints Alice's page, and his ids are his own", async () => {
    install();
    _setTestDbPlacesOverride(async () => []);
    _injectTestCacheEntry(KEY, FOUR());
    signedIn = ALICE;
    setDiscoveryViewerFromSession(ALICE);

    const aliceFirst = ok(await loadMiami(), "Alice");
    await until(() => db.impressions(), (x) => x.length >= 4);
    const p2 = aliceFirst.places[1]!;
    const d = await postOutcome(TOKEN.alice, { item_id: p2.id, surface: "discovery", outcome: "dismiss", recommendation_id: p2.recommendationId });
    assert.equal(d.status, 200, "the dismissal was accepted and bound to the exposure Alice's client named");
    invalidateDiscoveryCaches();   // what useRankOutcome's reportDismiss does on an accepted dismissal (hooks/useRankOutcome.ts:243)
    assert.equal(getCachedDiscoveryPlaces("Miami", "for_you", 10, 1), null, "the pre-dismissal page is gone from the device");

    const aliceAfter = ok(await loadMiami(), "Alice after dismissing");
    assert.deepEqual(idsOf(aliceAfter), ["db/p1", "db/p3", "db/p4"], "the permission change reached Alice's next page through the route");

    // The account switches (SessionContext's auth callback), BEFORE Bob's screen reads the cache.
    signedIn = BOB;
    setDiscoveryViewerFromSession(BOB);
    assert.equal(getCachedDiscoveryPlaces("Miami", "for_you", 10, 1), null, "Bob's first paint is never Alice's page");

    const bob = ok(await loadMiami(), "Bob");
    assert.deepEqual(idsOf(bob), ["db/p1", "db/p2", "db/p3", "db/p4"], "Alice's dismissal is Alice's: Bob is served p2");
    const aliceIds = new Set([...recIdsOf(aliceFirst), ...recIdsOf(aliceAfter)]);
    assert.ok(recIdsOf(bob).every((id) => !aliceIds.has(id)), "no id Alice was served reaches Bob");
    assert.deepEqual(seen.filter((s) => s.path === "/api/discovery").map((s) => s.auth),
      [`Bearer ${TOKEN.alice}`, `Bearer ${TOKEN.alice}`, `Bearer ${TOKEN.bob}`], "each read was sent as the viewer it was for");
    await until(() => db.impressions().filter((r) => r.user_id === BOB), (x) => x.length >= 4);
    assert.ok(db.impressions().filter((r) => r.user_id === BOB).every((r) => !aliceIds.has(r.recommendation_id)));
  });

  it("X2. a page fetched for Alice that lands after the switch to Bob is DISCARDED — not shown, not cached", async () => {
    install();
    _setTestDbPlacesOverride(async () => []);
    _injectTestCacheEntry(KEY, FOUR());
    signedIn = ALICE;
    setDiscoveryViewerFromSession(ALICE);

    let arrived!: () => void;
    const atServer = new Promise<void>((r) => { arrived = r; });
    let release!: () => void;
    hold = { match: (p) => p === "/api/discovery", arrived: () => arrived(), release: new Promise<void>((r) => { release = r; }) };

    const inFlight = loadMiami();
    await atServer;                       // Alice's request is at the route
    signedIn = BOB;
    setDiscoveryViewerFromSession(BOB);   // …and the account switches under it
    release();

    assert.deepEqual(await inFlight, { ok: false, error: VIEWER_CHANGED_ERROR }, "an answer fetched AS Alice is never handed to Bob's screen");
    assert.equal(getCachedDiscoveryPlaces("Miami", "for_you", 10, 1), null, "nor written where Bob's next paint would read it");
  });

  it("X3. the community byline: Alice sees her own name and never a submitter she blocked; Bob sees Alice as @alice, and Alice's name never reaches his client", async () => {
    install();
    const row = (id: string, name: string, by: string, handle: string, realName: string) => ({
      id, city: "Cebu", name, place_type: "hidden_gem", category: "food", neighborhood: null, blurb: "b",
      image_url: null, submitted_by: by, saved_count: 1, tag: null, note: null, rating: null, source: "traveler",
      status: "active", verified: false, created_at: "2026-01-01T00:00:00.000Z", lat: 10.3, lng: 123.9,
      profiles: { id: by, name: realName, avatar_url: null, username: handle, account_status: "active", is_private: false, show_profile_picture_publicly: true },
    });
    db.tables["discovery_places"] = [
      row("e2e-alice", "Alice's Pick", ALICE, "alice", "Alice Real"),
      row("e2e-xavi", "Xavi's Pick", XAVI, "xavi", "Xavi Real"),
    ];
    db.tables["blocks"] = [{ blocker_id: ALICE, blocked_id: XAVI }];

    signedIn = ALICE;
    const forAlice = ok(await getCommunityPlaces("Cebu"), "Alice's community read");
    assert.deepEqual(forAlice.items.map((i) => i.name), ["Alice's Pick"], "a submitter Alice blocked never reaches her client");
    assert.equal(communityBylineText(forAlice.items[0]!.submittedBy), "Alice Real", "self-exemption: the viewer sees her own name");

    signedIn = BOB;
    const forBob = ok(await getCommunityPlaces("Cebu"), "Bob's community read");
    const alicePick = forBob.items.find((i) => i.name === "Alice's Pick")!;
    assert.ok(forBob.items.some((i) => i.name === "Xavi's Pick"), "Alice's block is Alice's: Bob is served Xavi's pick");
    assert.equal(alicePick.submittedBy?.displayName, null, "the canonical field withholds Alice's name from Bob");
    assert.equal(communityBylineText(alicePick.submittedBy), "@alice", "and the byline Bob's card renders is her handle");
    assert.ok(!JSON.stringify(forBob).includes("Alice Real"), "Alice's real name is nowhere in what Bob's client received");
    assert.deepEqual(seen.filter((s) => s.path === "/api/discovery/community").map((s) => s.auth),
      [`Bearer ${TOKEN.alice}`, `Bearer ${TOKEN.bob}`]);
  });
});
