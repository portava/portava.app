/**
 * census-discovery §71 (lane P31), rows A05 and DV-42 — the Discovery client's
 * intent-mode vocabulary IS the server's, and the mode the client sends is the
 * mode GET /discovery ranks on.
 *
 * SPEC. Sensing §8 `:137`: *"Support intent modes using the same shared
 * intelligence: Right Now, Tonight, Explore, Quiet, Social, High Energy,
 * Nearby, Trip."* DSV2-03: *"Each intent reaches the actual ranking path …; UI
 * selection is not merely decorative."*
 *
 * WHY A PARITY GUARD. The client cannot import a server module, so
 * `travel-buddy-standalone/src/services/discovery.ts` restates the eight
 * (DISCOVERY_INTENT_MODES). The server's `parseIntentMode` maps anything it
 * does not know to null, and the live rank then uses its DEFAULT mode — so a
 * client value that drifted (a rename, a typo, a ninth mode) would be silently
 * ranked as "explore", never rejected. Nothing but this suite would notice.
 *
 * WHAT RUNS
 *   V1–V3  the two vocabularies are one: members, order and labels, and every
 *          client value parses to itself on the server.
 *   R1     THROUGH THE REAL ROUTE, driven by the SHIPPING CLIENT MODULE: with
 *          `discovery_live_rank_enabled` ON, each of the client's eight values
 *          is sent by `getDiscoveryPlaces` and the served page reports that the
 *          live rank ran in exactly that mode.
 *   R2     with no selection the client sends no `intentMode`, and the server
 *          ranks in its default (the request before §71).
 *   R3     2850 FALSE (production's state): the client's mode reaches the route
 *          and changes nothing — cached order, no live-rank block, snapshot
 *          table never read. This is what "inert until 2850 is on" means.
 *   C1     the capability the client's selector waits for is REPORTED: GET
 *          /api/feature-flags (what FeatureFlagsContext fetches) carries
 *          `discovery_live_rank_enabled` as stored, TRUE and FALSE alike — it
 *          is not in the route's INERT_FLAGS, so the selector can appear the
 *          moment an owner turns 2850 on, and not before.
 *
 * REAL: the Discovery express router, lib/intentModes, lib/discoveryLiveRankRead,
 * lib/liveClaimRead's gates, the live rank engine, and the client module
 * (`fetch`, lease, parse). DOUBLE: the database (helpers/fakeMapDb, as
 * discoveryLiveRankRoute.test.ts uses it) and the client's token source.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryIntentModeSender.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pino from "pino";

import discoveryRouter, {
  _setTestDbPlacesOverride,
  _injectTestCacheEntry,
  _clearTestCacheEntry,
  type DiscoveryPlace as ServerPlace,
} from "../routes/discovery.js";
import featureFlagsRouter from "../routes/featureFlags.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";
import { invalidateLiveRankFlagCache, DISCOVERY_LIVE_RANK_FLAG } from "../lib/discoveryLiveRankRead.js";
import { invalidateCandidateProjectionFlagCache } from "../lib/discoveryCandidate.js";
import { INTENT_MODES, INTENT_MODE_LABELS, parseIntentMode } from "../lib/intentModes.js";
import { makeFakeMapDb, type FakeState } from "./helpers/fakeMapDb.js";

// ── THE CLIENT, imported as the app imports it ───────────────────────────────
import {
  getDiscoveryPlaces,
  _resetDiscoveryClientCache,
  _setDiscoveryTokenSourceForTests,
  DISCOVERY_INTENT_MODES,
  DISCOVERY_INTENT_MODE_LABELS,
  DISCOVERY_LIVE_RANK_FLAG as CLIENT_LIVE_RANK_FLAG,
  type DiscoveryFilters,
  type DiscoveryIntentMode,
} from "../../../../travel-buddy-standalone/src/services/discovery.ts";
import { _resetDiscoveryViewerScopeForTests } from "../../../../travel-buddy-standalone/src/services/discoveryViewerScope.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SENSING_SPEC = "docs/specs/Portava_Sensing_World_Experience_Intelligence_Upgrade_Architecture_v1.txt";

const USER = "d1c0ffee-0000-4000-8000-000000000071";
const TOKEN = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: USER })).toString("base64url")}.sig`;
const KEY = "miami:for_you:10";   // routes/discovery.ts cacheKey(destination, category, radiusKm)
const FILTERS: DiscoveryFilters = { radiusKm: 10, openNow: false, minRating: null };

const P1 = "11111111-aaaa-4aaa-8aaa-111111111171";
const P2 = "22222222-bbbb-4bbb-8bbb-222222222271";
const P3 = "33333333-cccc-4ccc-8ccc-333333333371";
const CACHED_ORDER = [`db/${P1}`, `db/${P2}`, `db/${P3}`];

function place(canonicalId: string, name: string): ServerPlace {
  return {
    id: `db/${canonicalId}`, canonicalPlaceId: canonicalId, name, category: "for_you",
    type: "traveler_pick", description: null, distanceKm: 1, lat: 25.77, lng: -80.19,
    tags: [], address: "Miami, FL", website: null, phone: null, openingHours: null,
    rating: null, isOpenNow: null, savedCount: 1,
  } as ServerPlace;
}

/** Live gates open, as discoveryLiveRankRoute.test.ts opens them. */
function world(flags: { flag: string; enabled: boolean }[]): FakeState {
  return {
    feature_flags: [
      { flag: "intel_live_label_crowd", enabled: true },
      { flag: "intel_claim_projection_crowd", enabled: true },
      { flag: "intel_capture_quick_signal", enabled: true },
      { flag: "intel_limited_live", enabled: true },
      ...flags,
    ],
    intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }],
    intel_state_snapshots: [],
  };
}

// ── What the client put on the wire ──────────────────────────────────────────
let sent: string[] = [];
const _originalFetch = globalThis.fetch;
let server: Server;

before(async () => {
  const app = express();
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use("/api", discoveryRouter);
  app.use("/api", featureFlagsRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  server.unref();
  process.env.EXPO_PUBLIC_API_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  _setDiscoveryTokenSourceForTests(async () => TOKEN);
  globalThis.fetch = (async (url: any, init?: any) => {
    sent.push(String(url));
    return _originalFetch(url, init);
  }) as typeof globalThis.fetch;
});

after(async () => {
  globalThis.fetch = _originalFetch;
  _setDiscoveryTokenSourceForTests(null);
  await new Promise<void>((r) => server.close(() => r()));
});

function resetCaches() {
  invalidateDiscoveryEngineModeCache();
  invalidateLiveRankFlagCache();
  invalidateCandidateProjectionFlagCache();
  _clearPromotedScopeCache();
  _resetDiscoveryClientCache();
  _resetDiscoveryViewerScopeForTests();
}

beforeEach(() => {
  sent = [];
  resetCaches();
  _setTestDbPlacesOverride(async () => []);
});
afterEach(() => {
  _clearTestCacheEntry(KEY);
  _setTestDbPlacesOverride(null);
  _setTestServiceClient(null);
  resetCaches();
});

interface Served {
  places: Array<{ id: string }>;
  meta?: { liveRank?: { mode: string; readable: boolean } };
}

/** The For You page for Miami, fetched by the shipping client with `intentMode` (or none). */
async function loadVia(state: FakeState, intentMode?: DiscoveryIntentMode | null): Promise<Served> {
  _setTestServiceClient(makeFakeMapDb(state, { token: TOKEN, userId: USER }) as any);
  _injectTestCacheEntry(KEY, [place(P1, "First"), place(P2, "Second"), place(P3, "Third")]);
  const filters = intentMode === undefined ? FILTERS : { ...FILTERS, intentMode };
  const res = await getDiscoveryPlaces("Miami", "for_you", filters, 1, null, null, null, null, 25.77, -80.19);
  assert.ok(res.ok, `the client read failed: ${JSON.stringify(res)}`);
  return res.data as unknown as Served;
}

describe("V — one vocabulary on both sides of the wire", () => {
  it("V1. the client's DISCOVERY_INTENT_MODES is the server's INTENT_MODES: same members, same order", () => {
    assert.deepEqual([...DISCOVERY_INTENT_MODES], [...INTENT_MODES]);
  });

  it("V2. the client's labels are the server's labels, which are Sensing §8's names verbatim", () => {
    assert.deepEqual({ ...DISCOVERY_INTENT_MODE_LABELS }, { ...INTENT_MODE_LABELS });
    const specLine = readFileSync(join(REPO, SENSING_SPEC), "utf8")
      .split("\n")
      .find((l) => l.startsWith("Support intent modes using the same shared intelligence:"));
    assert.ok(specLine, "Sensing §8's intent-mode sentence was not found in the spec");
    const specNames = specLine!.replace(/^[^:]*:\s*/, "").replace(/\.\s*$/, "").split(/,\s*/);
    assert.deepEqual(DISCOVERY_INTENT_MODES.map((m) => DISCOVERY_INTENT_MODE_LABELS[m]), specNames);
  });

  it("V3. every client value parses to ITSELF on the server (never to null, never to the default), and the flag names agree", () => {
    for (const m of DISCOVERY_INTENT_MODES) assert.equal(parseIntentMode(m), m, `the server does not accept the client's "${m}"`);
    assert.equal(CLIENT_LIVE_RANK_FLAG, DISCOVERY_LIVE_RANK_FLAG);
  });
});

describe("R — through GET /discovery, sent by the shipping client", () => {
  const ON = () => world([{ flag: "discovery_live_rank_enabled", enabled: true }]);

  for (const mode of DISCOVERY_INTENT_MODES) {
    it(`R1. 2850 ON, the client sends ${mode}: the route ranks in ${mode}`, async () => {
      const body = await loadVia(ON(), mode);
      assert.deepEqual(sent.map((u) => new URL(u).searchParams.getAll("intentMode")), [[mode]]);
      assert.equal(body.meta?.liveRank?.mode, mode, `sent "${mode}", ranked as "${body.meta?.liveRank?.mode}"`);
    });
  }

  it("R2. no selection: no intentMode on the wire, and the route ranks in its own default", async () => {
    const body = await loadVia(ON(), null);
    assert.equal(sent.length, 1);
    assert.ok(!new URL(sent[0]).searchParams.has("intentMode"), `sent ${sent[0]}`);
    assert.equal(body.meta?.liveRank?.mode, "explore");
  });

  it("R3. 2850 FALSE (production's state): the client's mode reaches the route and changes nothing", async () => {
    const state = world([{ flag: "discovery_live_rank_enabled", enabled: false }]);
    state.intel_state_snapshots = { error: { message: "must not be read" } } as any;
    const withMode = await loadVia(state, "quiet");
    assert.equal(new URL(sent[0]).searchParams.get("intentMode"), "quiet");
    assert.deepEqual(withMode.places.map((p) => p.id), CACHED_ORDER);
    assert.equal(withMode.meta?.liveRank, undefined);

    resetCaches();
    const without = await loadVia(state, null);
    assert.deepEqual(without.places.map((p) => p.id), withMode.places.map((p) => p.id));
    assert.equal(without.meta?.liveRank, undefined);
  });
});

describe("C — the capability the client waits for is reported to it", () => {
  for (const enabled of [true, false]) {
    it(`C1. GET /api/feature-flags reports discovery_live_rank_enabled = ${enabled} as stored`, async () => {
      _setTestServiceClient(makeFakeMapDb({
        feature_flags: [
          { flag: "discovery_live_rank_enabled", enabled, description: "2850" },
          { flag: "freeze_city", enabled: true, description: "inert, filtered by the route" },
        ],
      }, { token: TOKEN, userId: USER }) as any);
      const res = await _originalFetch(`${process.env.EXPO_PUBLIC_API_BASE_URL}/api/feature-flags`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { flags: Record<string, boolean> };
      assert.equal(body.flags[CLIENT_LIVE_RANK_FLAG], enabled, JSON.stringify(body.flags));
      assert.equal("freeze_city" in body.flags, false, "control: the route's inert filter is live");
    });
  }
});
