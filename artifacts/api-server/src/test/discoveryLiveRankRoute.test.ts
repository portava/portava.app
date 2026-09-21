/**
 * Sensing §8 through the REAL route — GET /discovery behind
 * `discovery_live_rank_enabled` (migration 2850, seeded FALSE), over a
 * deterministic Cache A hit so no Overpass or geocode is needed (the harness
 * lib/test/discoveryPdeServePath.test.ts established).
 *
 * Nothing here is mocked past the database boundary: the request goes through
 * the real express router, the real lib/discoveryLiveRankRead, the real
 * lib/liveClaimRead gate chain and the real lib/discoveryLiveRank engine. The
 * only double is the PostgREST client (helpers/fakeMapDb), which is what every
 * other gateway suite uses.
 *
 * The OFF case is the load-bearing one: with the flag absent — production's
 * state — the served order is the cached order and no claim is read.
 *
 * Run: node --import tsx/esm --test src/test/discoveryLiveRankRoute.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";

import discoveryRouter, {
  _setTestDbPlacesOverride,
  _injectTestCacheEntry,
  _clearTestCacheEntry,
  type DiscoveryPlace,
} from "../routes/discovery.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";
import { invalidateLiveRankFlagCache } from "../lib/discoveryLiveRankRead.js";
import { invalidateCandidateProjectionFlagCache } from "../lib/discoveryCandidate.js";
import { makeFakeMapDb, type FakeState } from "./helpers/fakeMapDb.js";

const USER  = "bbbb2222-0000-0000-0000-000000000002";
const TOKEN = "live-rank-tok";
const KEY   = "miami:for_you:10"; // cacheKey(destination, category, radiusKm)

const P1 = "11111111-aaaa-4aaa-8aaa-111111111111";
const P2 = "22222222-bbbb-4bbb-8bbb-222222222222";
const P3 = "33333333-cccc-4ccc-8ccc-333333333333";

const NOW = Date.now();
const iso = (min: number) => new Date(NOW + min * 60_000).toISOString();

const LIVE_GATES_OPEN = [
  { flag: "intel_live_label_crowd", enabled: true },
  { flag: "intel_claim_projection_crowd", enabled: true },
  { flag: "intel_capture_quick_signal", enabled: true },
  { flag: "intel_limited_live", enabled: true },
];

function place(canonicalId: string, name: string, distanceKm: number): DiscoveryPlace {
  return {
    id: `db/${canonicalId}`, canonicalPlaceId: canonicalId, name, category: "for_you",
    type: "traveler_pick", description: null, distanceKm, lat: 25.77, lng: -80.19,
    tags: [], address: "Miami, FL", website: null, phone: null, openingHours: null,
    rating: null, isOpenNow: null, savedCount: 1,
  } as DiscoveryPlace;
}

/** The injected cache order: P1, P2, P3. */
const CACHED_ORDER = [`db/${P1}`, `db/${P2}`, `db/${P3}`];
function cachedPlaces(): DiscoveryPlace[] {
  return [place(P1, "First", 1), place(P2, "Second", 1), place(P3, "Third", 1)];
}

function snapshot(subject: string, over: Record<string, unknown> = {}) {
  return {
    id: `snap-${subject.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`,
    subject_id: subject,
    zone_id: null,
    claim_type: "crowd.level",
    value: { level: "quiet" },
    confidence: 0.9,
    source_count: 30,
    observed_at: iso(-3),
    expires_at: iso(45),
    privacy_eligible: true,
    conflict_state: "none",
    source_class: "firsthand_unverified",
    computed_at: iso(-3),
    ...over,
  };
}

function world(flags: { flag: string; enabled: boolean }[], snapshots: any[] = []): FakeState {
  return {
    feature_flags: [...LIVE_GATES_OPEN, ...flags],
    intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }],
    intel_state_snapshots: snapshots,
  };
}

function makeApp() {
  const app = express();
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use(discoveryRouter);
  return app;
}

function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(makeApp());
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port as number;
      server.unref();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

interface Body {
  places: Array<{ id: string; candidate?: { whyNow: string[] | null } }>;
  total: number;
  meta: { cacheLevel: string; liveRank?: { mode: string; readable: boolean; windowSize: number; demoted: number } };
}

describe("Sensing §8 — GET /discovery ranks on live intelligence behind 2850", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestDbPlacesOverride(async () => []);
    invalidateDiscoveryEngineModeCache();
    invalidateLiveRankFlagCache();
    invalidateCandidateProjectionFlagCache();
    _clearPromotedScopeCache();
  });
  afterEach(async () => {
    _clearTestCacheEntry(KEY);
    _setTestDbPlacesOverride(null);
    _setTestServiceClient(null);
    invalidateDiscoveryEngineModeCache();
    invalidateLiveRankFlagCache();
    invalidateCandidateProjectionFlagCache();
    _clearPromotedScopeCache();
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function get(state: FakeState, query = ""): Promise<Body> {
    _setTestServiceClient(makeFakeMapDb(state, { token: TOKEN, userId: USER }));
    _injectTestCacheEntry(KEY, cachedPlaces());
    const res = await fetch(`${url}/discovery?destination=Miami&lat=25.77&lng=-80.19${query}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    return (await res.json()) as Body;
  }

  it("flag ABSENT (production's state): the cached order is served and intel_state_snapshots is never read", async () => {
    const state = world([], []);
    // Any read of the snapshot table would surface as a 500-shaped error here;
    // the assertion is the ORDER plus the absence of the liveRank meta block.
    state.intel_state_snapshots = { error: { message: "must not be read" } };
    const body = await get(state);
    assert.deepEqual(body.places.map((p) => p.id), CACHED_ORDER);
    assert.equal(body.meta.liveRank, undefined);
  });

  it("flag FALSE (2850 applied, nothing flipped): identical", async () => {
    const state = world([{ flag: "discovery_live_rank_enabled", enabled: false }], []);
    state.intel_state_snapshots = { error: { message: "must not be read" } };
    const body = await get(state);
    assert.deepEqual(body.places.map((p) => p.id), CACHED_ORDER);
    assert.equal(body.meta.liveRank, undefined);
  });

  it("an UNREADABLE feature_flags table is OFF (fail-closed)", async () => {
    const state: FakeState = { feature_flags: { error: { message: "boom" } } };
    const body = await get(state);
    assert.deepEqual(body.places.map((p) => p.id), CACHED_ORDER);
    assert.equal(body.meta.liveRank, undefined);
  });

  it("ON, gates open: the quiet place is promoted for a QUIET viewer and the meta says so", async () => {
    const body = await get(
      world([{ flag: "discovery_live_rank_enabled", enabled: true }], [
        snapshot(P3, { value: { level: "quiet" } }),
        snapshot(P1, { value: { level: "packed" } }),
      ]),
      "&intentMode=quiet",
    );
    const ids = body.places.map((p) => p.id);
    assert.equal(body.meta.liveRank?.mode, "quiet");
    assert.equal(body.meta.liveRank?.readable, true);
    assert.equal(body.meta.liveRank?.windowSize, 3);
    assert.ok(ids.indexOf(`db/${P3}`) < ids.indexOf(`db/${P1}`),
      `the quiet place must outrank the packed one for a quiet viewer — got ${JSON.stringify(ids)}`);
    assert.equal(body.total, 3, "the ranking layer may not add or drop a candidate");
    assert.deepEqual([...ids].sort(), [...CACHED_ORDER].sort(), "the same candidate set, re-ordered");
  });

  it("ON: a Live unsafe_density place is demoted to last, whatever its cached position", async () => {
    const body = await get(
      world([{ flag: "discovery_live_rank_enabled", enabled: true }], [
        snapshot(P1, { value: { level: "unsafe_density" } }),
      ]),
      "&intentMode=social",
    );
    const ids = body.places.map((p) => p.id);
    assert.equal(ids[ids.length - 1], `db/${P1}`, `unsafe place not demoted — got ${JSON.stringify(ids)}`);
    assert.equal(body.meta.liveRank?.demoted, 1);
  });

  it("ON but the Live pilot CLOSED: readable is false, and the cached order is untouched", async () => {
    const state = world([
      { flag: "discovery_live_rank_enabled", enabled: true },
      { flag: "intel_limited_live", enabled: false },
    ], [snapshot(P3, { value: { level: "quiet" } })]);
    // intel_limited_live appears twice; the fake returns the first match, so
    // remove the open one rather than shadow it.
    state.feature_flags = [
      { flag: "intel_live_label_crowd", enabled: true },
      { flag: "intel_claim_projection_crowd", enabled: true },
      { flag: "intel_capture_quick_signal", enabled: true },
      { flag: "intel_limited_live", enabled: false },
      { flag: "discovery_live_rank_enabled", enabled: true },
    ];
    const body = await get(state, "&intentMode=quiet");
    assert.equal(body.meta.liveRank?.readable, false);
    assert.deepEqual(body.places.map((p) => p.id), CACHED_ORDER);
  });

  it("ON with an EMPTY promoted-scope allowlist: nothing is live, and nothing moves", async () => {
    const state = world([{ flag: "discovery_live_rank_enabled", enabled: true }], [
      snapshot(P3, { value: { level: "quiet" } }),
    ]);
    state.intel_live_promoted_scopes = [];
    const body = await get(state, "&intentMode=quiet");
    assert.equal(body.meta.liveRank?.readable, true, "the gates were open; the allowlist is the empty one");
    assert.deepEqual(body.places.map((p) => p.id), CACHED_ORDER);
  });

  it("an unknown intentMode is not honoured as one: the default mode is used, never the raw string", async () => {
    const body = await get(
      world([{ flag: "discovery_live_rank_enabled", enabled: true }], []),
      "&intentMode=whatever-the-client-sent",
    );
    assert.equal(body.meta.liveRank?.mode, "explore");
  });

  it("with the candidate projection also ON, whyNow carries grounded reasons — and stays null where nothing was observed", async () => {
    const body = await get(
      world([
        { flag: "discovery_live_rank_enabled", enabled: true },
        { flag: "discovery_candidate_projection_enabled", enabled: true },
      ], [snapshot(P1, { value: { level: "busy" } })]),
      "&intentMode=social",
    );
    const byId = new Map(body.places.map((p) => [p.id, p]));
    // The place with a reading carries the claim's own vocabulary, not prose.
    assert.deepEqual(byId.get(`db/${P1}`)?.candidate?.whyNow, ["crowd_busy"]);
    // The two with no reading carry null — "nothing observed", never [].
    assert.equal(byId.get(`db/${P2}`)?.candidate?.whyNow, null);
    assert.equal(byId.get(`db/${P3}`)?.candidate?.whyNow, null);
  });

  it("candidate projection ON but live rank OFF: every whyNow is null, as before the producer existed", async () => {
    const state = world([{ flag: "discovery_candidate_projection_enabled", enabled: true }], []);
    state.intel_state_snapshots = { error: { message: "must not be read" } };
    const body = await get(state, "&intentMode=social");
    for (const p of body.places) assert.equal(p.candidate?.whyNow, null);
  });

  it("nothing person-shaped reaches the wire — no contributor, count or coordinate from the claim", async () => {
    const body = await get(
      world([{ flag: "discovery_live_rank_enabled", enabled: true }], [snapshot(P1)]),
      "&intentMode=social",
    );
    const text = JSON.stringify(body.meta);
    assert.doesNotMatch(text, /distinct_actors|actor_id|source_count/);
  });
});
