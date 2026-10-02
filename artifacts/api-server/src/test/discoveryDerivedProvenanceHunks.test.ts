/**
 * census-discovery §75 (lane P33), DC-17 — §68.6's routed hunks, built.
 *
 * `10` §5: "Derived features must retain: source event window · feature
 * version · model version · computation time". §68.2 graded four derived
 * features below 4 of 4. This file pins what §75 built for three of them and
 * the one false path §68.6 H-P21-5 named. H-P21-1 (the trend API's wire
 * record) is pinned in discoveryTrendingApi.test.ts (§75 P1–P4), next to the
 * suite that owns that route; the PDE row, end to end through GET /discovery,
 * in discoveryServedGraphReading.test.ts (§75 H-P21-2).
 *
 *   Q  H-P21-2  the PDE feature vector: feature version, rank clock, window,
 *               and the momentum input's own record, stamped per scored row
 *   R  H-P21-3  Trail health: the three facts in memory, and in the snapshot
 *               behind a column-absent latch (3436)
 *   S  H-P21-5  Trail `trending`: when only the per-item read fails the served
 *               boolean is measured, so its provenance is the fold's — never
 *               null beside a measured answer; §61.17's empty Trail and §64.13's
 *               all-withheld Trail are unchanged
 *
 * Provenance only. discoveryDerivedProvenanceGolden.test.ts G6–G9 hold every
 * value these paths compute to a hash captured before §75.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryDerivedProvenanceHunks.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import trailsRouter from "../routes/trails.js";
import {
  trailTrending, recordTrailHealthSnapshot, _resetTrailSnapshotProvenanceLatch, trailSnapshotProvenanceAbsent,
} from "../services/trails/TrailService.js";
import {
  computeLocalMomentum, localMomentumProvenance, _resetLocalMomentumCacheForTest,
  MOMENTUM_BASELINE_WINDOW_MS, type MomentumRow,
} from "../lib/discoveryLocalMomentum.js";
import {
  DISCOVERY_PDE_FEATURE_VERSION, pdeFeatureProvenanceOf, pdeFeatureProvenanceFeatures, PDE_FEATURE_PROVENANCE_KEYS,
  derivedStoreProvenance,
} from "../lib/discoveryRankProvenance.js";
import { rankForViewer, type PdePlace } from "../lib/discoveryPde.js";
import { inertModifiers, type DiscoveryModifiers } from "../lib/discoveryModifiers.js";
import {
  scoreCandidate, rankCandidates, DEFAULT_WEIGHTS, LOCAL_MOMENTUM_MAX_CONTRIBUTION, PUBLISHER_BOOST,
  PLACE_ENGAGEMENT_BOOST, PLACE_ENGAGEMENT_BOOST_THRESHOLD, type RankCandidate, type ViewerContext,
} from "../lib/portavaRank.js";
import { featureKeyClass } from "../lib/discoveryRecommendationRecord.js";
import {
  computeTrailHealth, TRAIL_HEALTH_FEATURE_VERSION, TRAIL_HEALTH_MODEL_VERSION, TRAIL_HEALTH_METRICS,
} from "../lib/discoveryTrailHealth.js";
import { makeFakeTrailsDb, type Row, type FakeTrailsDbOptions } from "./helpers/fakeTrailsDb.js";

const USER = "11111111-1111-4111-8111-111111111111";
const T_A = "22222222-2222-4222-8222-2222222222a1";
const PLACES = ["33333333-3333-4333-8333-3333333333a1", "33333333-3333-4333-8333-3333333333b1"];
const NOW = Date.parse("2026-09-20T12:00:00Z");
const HOUR = 3_600_000;

// ── Q. H-P21-2 — the PDE feature vector ──────────────────────────────────────

const PLACES_PDE: PdePlace[] = Array.from({ length: 8 }, (_, i) => ({
  id: i % 2 === 0 ? `db/p${i}` : `node/${i}`, category: i % 2 ? "cafe" : "bar", distanceKm: i, savedCount: i * 3, tags: ["local"],
}));
const VIEWER = { userId: "viewer-1", city: "lisbon", followedIds: new Set<string>(), interestTags: new Set<string>() };

describe("Q — H-P21-2: every PDE-scored row names its feature version, rank clock, window and momentum input", () => {
  it("Q1. modifiers OFF: the three rank facts, one clock for the page, and NO momentum record (momentum was not an input)", async () => {
    const before = Date.now();
    const out = await rankForViewer(PLACES_PDE, VIEWER, { sc: null, served: false, modifiers: inertModifiers("flag_off"), nowMs: NOW });
    const after = Date.now();
    const provs = [...out.scoredById.values()].map((s) => pdeFeatureProvenanceOf(s));
    assert.equal(provs.length, PLACES_PDE.length);
    const p = provs[0]!;
    assert.ok(p, "the scored objects carry their rank's record");
    for (const q of provs) assert.equal(q, p, "one rank, one record: every row of the page shares it");
    assert.equal(p.featureVersion, DISCOVERY_PDE_FEATURE_VERSION);
    assert.ok(p.rankedAt >= before && p.rankedAt <= after, "the rank clock is the moment the ranker ran — not the injected governor clock, not the serve clock");
    assert.deepEqual(p.sourceWindow, { kind: "unbounded_start", startMs: null, endMs: p.rankedAt });
    assert.ok(!("momentum" in p), "no momentum record when momentum was not an input");
    const f = pdeFeatureProvenanceFeatures([...out.scoredById.values()][0]!);
    assert.deepEqual(Object.keys(f), ["featureVersion", "rankedAt", "sourceWindow"]);
  });

  it("Q2. modifiers ON: the momentum input's OWN record rides beside the vector — its window, versions and older clock", async () => {
    const readAt = NOW - 7 * 60_000;   // a cached reading, seven minutes old
    const momentumProvenance = derivedStoreProvenance(
      { kind: "bounded", startMs: readAt - MOMENTUM_BASELINE_WINDOW_MS, endMs: readAt }, readAt,
      { modelVersion: "discovery-place-velocity-v1", featureVersion: "discovery-weighted-activity-v2" },
    );
    const modifiers: DiscoveryModifiers = { ...inertModifiers("flag_off"), enabled: true, reason: "flag_on", localMomentum: { "node/1": 0.4 }, momentumScale: 1, explorationBudgetPct: 20, momentumProvenance };
    const out = await rankForViewer(PLACES_PDE, VIEWER, { sc: null, served: false, modifiers, nowMs: NOW });
    const s = [...out.scoredById.values()][0]!;
    assert.deepEqual(pdeFeatureProvenanceOf(s)!.momentum, momentumProvenance);
    const f = pdeFeatureProvenanceFeatures(s);
    assert.deepEqual(f["momentumProvenance"], {
      modelVersion: "discovery-place-velocity-v1", featureVersion: "discovery-weighted-activity-v2", computedAt: readAt,
      window: { kind: "bounded", startMs: readAt - MOMENTUM_BASELINE_WINDOW_MS, endMs: readAt },
    });
    assert.ok((f["rankedAt"] as number) > readAt, "the vector's clock and its input's clock are two facts, and both are kept");
  });

  it("Q3. modifiers ON but the momentum load threw: `momentumProvenance: null` — an input whose record is unknown, stated", async () => {
    const modifiers: DiscoveryModifiers = { ...inertModifiers("flag_off"), enabled: true, reason: "flag_on", momentumScale: 1, explorationBudgetPct: 20, momentumProvenance: null };
    const out = await rankForViewer(PLACES_PDE, VIEWER, { sc: null, served: false, modifiers, nowMs: NOW });
    assert.equal(pdeFeatureProvenanceFeatures([...out.scoredById.values()][0]!)["momentumProvenance"], null);
  });

  it("Q4. a candidate no PDE run scored carries no key at all (Compass, pulse and fixtures are untouched)", () => {
    const [s] = rankCandidates([{ id: "x", kind: "place" } as RankCandidate], { userId: "u" } as ViewerContext);
    assert.deepEqual(pdeFeatureProvenanceFeatures(s!), {});
    assert.deepEqual(pdeFeatureProvenanceFeatures({}), {});
  });

  it("Q5. every key is classified record_metadata for DV-39's screen, and none is a position", () => {
    for (const k of PDE_FEATURE_PROVENANCE_KEYS) assert.equal(featureKeyClass(k), "record_metadata", k);
  });

  it("Q6. DISCOVERY_PDE_FEATURE_VERSION names THIS feature set: a new key, a removed key or a weight change must bump it", () => {
    const now = NOW;
    const s = scoreCandidate(
      { id: "c", kind: "event", authorId: "a", tags: ["t"], category: "food", city: "Lisbon", neighborhood: "Alfama",
        distanceKm: 1, startsAt: new Date(now + HOUR).toISOString(), createdAt: new Date(now).toISOString(),
        authorTrustScore: 50, verified: true, hasCapacity: true, isOfficialPublisher: true, placeId: "p" } as RankCandidate,
      { userId: "u", followedIds: new Set(["a"]), mutualIds: new Set(["a"]), engagedAuthorIds: new Set(["a"]), interestTags: new Set(["t"]),
        categoryAffinities: { food: 1 }, city: "Lisbon", neighborhood: "Alfama", seenIds: new Set(["c"]),
        localMomentum: { c: 1 }, trailAffinity: { c: 1 }, placeAffinities: { p: PLACE_ENGAGEMENT_BOOST_THRESHOLD }, nowMs: now } as unknown as ViewerContext,
      undefined, true,
    );
    const definition = {
      keys: Object.keys(s.features).sort(),
      weights: Object.fromEntries(Object.entries(DEFAULT_WEIGHTS).sort(([a], [b]) => a.localeCompare(b))),
      caps: { LOCAL_MOMENTUM_MAX_CONTRIBUTION, PUBLISHER_BOOST, PLACE_ENGAGEMENT_BOOST, PLACE_ENGAGEMENT_BOOST_THRESHOLD },
    };
    const digest = createHash("sha256").update(JSON.stringify(definition)).digest("hex");
    // Captured at ed9ab3ca0 for "portava-rank-features-v1". If this fails, the
    // feature set moved: bump DISCOVERY_PDE_FEATURE_VERSION, then re-pin both.
    assert.equal(DISCOVERY_PDE_FEATURE_VERSION, "portava-rank-features-v1");
    assert.equal(digest, PDE_FEATURE_SET_V1, `feature set digest ${digest}`);
  });
});

/** sha256 of portavaRank's v1 feature definition (Q6), captured at ed9ab3ca0. */
const PDE_FEATURE_SET_V1 = "8b401a813fc298724f08f2e9c857dffea439f6dc2b79bbc6f745cb45c710d45e";

// ── R. H-P21-3 — Trail health ────────────────────────────────────────────────

const members = (n: number) => Array.from({ length: n }, (_, i) => ({
  source_id: PLACES[i % 2]!, contributor_id: `u-${i % 3}`, confidence: 0.4 + i / 10, content_state: "just_arrived",
  created_at: new Date(NOW - (i + 1) * 20 * 24 * HOUR).toISOString(),
}));

describe("R — H-P21-3: Trail health keeps its window, feature version and clock, in memory and stored", () => {
  beforeEach(() => _resetTrailSnapshotProvenanceLatch());
  after(() => _resetTrailSnapshotProvenanceLatch());

  it("R1. in memory: all four facts, for a measured Trail and for an empty one", () => {
    for (const n of [0, 5]) {
      const h = computeTrailHealth({ members: members(n), reportCount: 1, nowMs: NOW });
      assert.equal(h.modelVersion, TRAIL_HEALTH_MODEL_VERSION);
      assert.equal(h.featureVersion, TRAIL_HEALTH_FEATURE_VERSION);
      assert.equal(h.computedAt, NOW, "the clock every age in the metrics was measured from");
      assert.deepEqual(h.sourceWindow, { kind: "unbounded_start", startMs: null, endMs: NOW }, "members of ANY age count, so the corpus has no oldest event");
    }
  });

  it("R2. stored: feature_version and source_window are written, and captured_at is the COMPUTATION clock the health carries", async () => {
    const h = computeTrailHealth({ members: members(4), reportCount: 0, nowMs: NOW });
    const db = makeFakeTrailsDb({});
    assert.equal(await recordTrailHealthSnapshot(db, T_A, h), "written");
    const row = db.inserts.find((i) => i.table === "trail_health_snapshots")!.payload;
    assert.equal(row["model_version"], TRAIL_HEALTH_MODEL_VERSION);
    assert.equal(row["feature_version"], TRAIL_HEALTH_FEATURE_VERSION);
    assert.deepEqual(row["source_window"], { kind: "unbounded_start", start: null, end: new Date(NOW).toISOString() });
    assert.equal(row["captured_at"], new Date(NOW).toISOString(), "not the write clock");
    assert.deepEqual(Object.keys(row["metrics"] as object).sort(), [...TRAIL_HEALTH_METRICS].sort());
    assert.equal(trailSnapshotProvenanceAbsent(), false);
  });

  it("R3. WITHOUT 3436 (42703 on either column): the snapshot is still written with 2910's five columns, and the process latches", async () => {
    const h = computeTrailHealth({ members: members(4), reportCount: 0, nowMs: NOW });
    const db = makeFakeTrailsDb({}, { missingColumns: ["feature_version", "source_window"] });
    assert.equal(await recordTrailHealthSnapshot(db, T_A, h), "written", "a missing PROVENANCE column never costs the snapshot");
    const row = db.inserts.find((i) => i.table === "trail_health_snapshots")!.payload;
    assert.deepEqual(Object.keys(row).sort(), ["captured_at", "member_count", "metrics", "model_version", "trail_id"]);
    assert.equal(trailSnapshotProvenanceAbsent(), true);
    // A later snapshot (another Trail) goes straight to the legacy shape: one failed round trip per process, not per write.
    const db2 = makeFakeTrailsDb({}, { missingColumns: ["feature_version", "source_window"] });
    assert.equal(await recordTrailHealthSnapshot(db2, "22222222-2222-4222-8222-2222222222b2", h), "written");
    assert.equal(db2.inserts.length, 1);
  });

  it("R4. only a MISSING COLUMN is retried: a missing table is still `unavailable`, a timeout still `failed`, and neither latches", async () => {
    const h = computeTrailHealth({ members: members(4), reportCount: 0, nowMs: NOW });
    const missingTable = makeFakeTrailsDb({}, { insertFailure: { trail_health_snapshots: { code: "42P01", message: 'relation "public.trail_health_snapshots" does not exist' } } });
    assert.equal(await recordTrailHealthSnapshot(missingTable, T_A, h), "unavailable");
    assert.equal(missingTable.insertAttempts["trail_health_snapshots"], 1, "no retry for a missing table");
    const timeout = makeFakeTrailsDb({}, { insertFailure: { trail_health_snapshots: { code: "57014", message: "canceling statement due to statement timeout" } } });
    assert.equal(await recordTrailHealthSnapshot(timeout, T_A, h), "failed");
    assert.equal(timeout.insertAttempts["trail_health_snapshots"], 1, "no retry for an unknown answer");
    assert.equal(trailSnapshotProvenanceAbsent(), false);
  });
});

// ── S. H-P21-5 — Trail `trending` when only the per-item read fails ─────────

const iso = (at: number, msAgo: number) => new Date(at - msAgo).toISOString();
function trendingSeed(at: number, over: { members?: Row[] } = {}): Record<string, Row[]> {
  return {
    trails: [{ id: T_A, slug: "slug-a", title: "Trail A", description: null, destination: "bangkok", place_scope: null,
      parent_trail_id: null, lifecycle_status: "active", created_by: USER, created_at: iso(at, 86_400_000), updated_at: iso(at, 86_400_000) }],
    content_trails: over.members ?? PLACES.map((p, i) => ({ id: `m${i}`, trail_id: T_A, source_type: "place", source_id: p, relationship: "primary",
      signal: null, source: "user", confidence: 0.9, contributor_id: USER, content_state: "just_arrived", created_at: iso(at, HOUR * (i + 1)) })),
    rank_events: Array.from({ length: 9 }, (_, i) => ({ id: `e${i}`, item_id: PLACES[0], surface: "discovery", outcome: "save", served_at: iso(at, HOUR + i), outcome_at: iso(at, HOUR + i) })),
    profiles: [{ id: USER, account_status: "active", role: "user" }],
  };
}

const app = express();
app.use(express.json());
app.use(trailsRouter);
const server = http.createServer(app);
let base = "";
before(async () => {
  await new Promise<void>((resolve, reject) => { server.once("listening", () => resolve()); server.once("error", reject); server.listen(0, "127.0.0.1"); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => { server.close(); _clearTestClient(); });

function serve(seed: Record<string, Row[]>, opts: FakeTrailsDbOptions = {}) {
  _resetLocalMomentumCacheForTest();
  const d = makeFakeTrailsDb(seed, opts) as ReturnType<typeof makeFakeTrailsDb> & { auth: unknown };
  d.auth = {
    async getUser(token: string) {
      return token === USER ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: "invalid token" } };
    },
  };
  _setTestClient(d, true);
  return d;
}
async function getTrending(): Promise<{ status: number; body: { trending: boolean | null; items: unknown[]; readingProvenance: Record<string, unknown> | null } }> {
  const res = await fetch(`${base}/v1/discovery/trails/${T_A}/trending`, { headers: { authorization: `Bearer ${USER}` } });
  return { status: res.status, body: await res.json() as never };
}

describe("S — H-P21-5: a measured boolean is never served beside a null provenance", () => {
  it("S1. service: only the per-item read fails ⇒ the same measured momentum, and the fold's own record in place of null", async () => {
    _resetLocalMomentumCacheForTest();
    const both = await trailTrending(makeFakeTrailsDb(trendingSeed(NOW)), T_A, NOW);
    _resetLocalMomentumCacheForTest();
    const itemFails = await trailTrending(makeFakeTrailsDb(trendingSeed(NOW), { failRankEvents: "discovery" }), T_A, NOW);
    assert.ok((both.momentum ?? 0) > 0, "precondition: the Trail is trending");
    assert.equal(itemFails.momentum, both.momentum, "the boolean's input is unchanged");
    assert.equal(itemFails.momentumUnread, undefined, "the Trail read succeeded: measured, not unread");
    assert.deepEqual(itemFails.items, [], "the per-item order was not read, so no items — unchanged");
    assert.ok(itemFails.momentumProvenance, "was null before §75: a measured answer with no stated corpus");
    assert.deepEqual(itemFails.momentumProvenance, both.momentumProvenance, "one kernel, one clock: the same record the successful path serves");
  });

  it("S2. that record IS the fold's computation's: localMomentumProvenance(now) equals the kernel's record over any rows, the folded ones included", () => {
    const rows: MomentumRow[] = trendingSeed(NOW)["rank_events"]!.map((r) => ({ item_id: T_A, outcome: String(r["outcome"]), served_at: String(r["served_at"]), outcome_at: String(r["outcome_at"]) }));
    for (const input of [rows, [], rows.slice(0, 2)]) {
      assert.deepEqual(localMomentumProvenance(NOW), computeLocalMomentum(input, NOW).provenance);
    }
  });

  it("S3. route: only the per-item read fails ⇒ trending true, items [], and readingProvenance names the corpus", async () => {
    const at = Date.now();
    serve(trendingSeed(at));
    const ok = await getTrending();
    serve(trendingSeed(at), { failRankEvents: "discovery" });
    const r = await getTrending();
    assert.equal(r.status, 200);
    assert.equal(ok.body.trending, true, "precondition");
    assert.equal(r.body.trending, true, "the served boolean does not move");
    assert.deepEqual(r.body.items, []);
    assert.ok(r.body.readingProvenance, "a measured boolean with a stated window");
    assert.equal((r.body.readingProvenance as { window: { kind: string } }).window.kind, "bounded");
    const strip = (p: Record<string, unknown>) => ({ ...p, computedAt: 0, window: { ...(p["window"] as object), startMs: 0, endMs: 0 } });
    assert.deepEqual(strip(r.body.readingProvenance), strip(ok.body.readingProvenance!), "the same record shape and versions the successful path serves");
  });

  it("S4. unchanged: the Trail read fails ⇒ null (unknown); both fail ⇒ null with null provenance", async () => {
    const at = Date.now();
    serve(trendingSeed(at), { failRankEvents: "all_surfaces" });
    const trailFails = await getTrending();
    assert.equal(trailFails.body.trending, null);
    serve(trendingSeed(at), { erroring: ["rank_events"] });
    const bothFail = await getTrending();
    assert.equal(bothFail.body.trending, null);
    assert.equal(bothFail.body.readingProvenance, null, "no read succeeded, so there is no measurement to describe");
  });

  it("S5. unchanged, §61.17: an EMPTY Trail is a measured false with null provenance — and a failing item read cannot change that", async () => {
    for (const opts of [{}, { failRankEvents: "discovery" as const }, { failRankEvents: "all_surfaces" as const }, { erroring: ["rank_events"] }]) {
      serve(trendingSeed(Date.now(), { members: [] }), opts);
      const r = await getTrending();
      assert.equal(r.body.trending, false);
      assert.equal(r.body.readingProvenance, null);
    }
  });

  it("S6. unchanged, §64.13: when every member is withheld from the viewer the answer is the empty Trail's — false, null — whatever read fails", async () => {
    // A post member whose post cannot be found: `servableMembers` withholds it (§64), so nothing is servable.
    const withheld: Row[] = [{ id: "m-post", trail_id: T_A, source_type: "post", source_id: "44444444-4444-4444-8444-444444444401", relationship: "primary",
      signal: null, source: "user", confidence: 0.9, contributor_id: USER, content_state: "just_arrived", created_at: iso(Date.now(), HOUR) }];
    for (const opts of [{}, { failRankEvents: "discovery" as const }, { failRankEvents: "all_surfaces" as const }, { erroring: ["rank_events"] }]) {
      serve({ ...trendingSeed(Date.now(), { members: withheld }), posts: [] }, opts);
      const r = await getTrending();
      assert.equal(r.status, 200);
      assert.equal(r.body.trending, false, "not null: null would tell a stranger the Trail has members they cannot see");
      assert.equal(r.body.readingProvenance, null);
    }
  });
});
