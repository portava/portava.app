/**
 * census-discovery §78 (lane W10-R2) — the hook that puts the scoring designs
 * on the Discovery pipeline, and DRS's negative-feedback inputs.
 *
 *   H1  each flag, alone, assembles ONLY its own inputs and performs only its
 *       own reads
 *   H2  every flag on: the ranking call, built exactly as lib/discoveryPde.ts
 *       builds it, carries every design term, and the order moves
 *   H3  a loader that fails leaves its input absent and names itself degraded
 *   H4  the hook never mutates the caller's candidates; the caller's own
 *       diversity keys and exploration choice win
 *   H5  another surface's options: `{}` with the flag off, its own objective on
 *   N1  DRS, discovery surface, flag ON: a dismissed item's hidden input is
 *       real, so it is ineligible and last in both DRS modes
 *   N2  DRS on any other surface, or with the flag off: the same array, unread
 *   N3  the flag cache is per client object
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/discoveryRankDesigns.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadRankDesigns, applyRankDesigns, categoryDismissals, surfaceObjectiveOptions, type RankDesignPlace } from "../lib/discoveryRankDesigns.js";
import { invalidateRankDesignFlagCache, loadRankDesignFlags, RANK_DESIGN_FLAGS } from "../lib/discoveryRankFlags.js";
import { rankCandidates, type RankCandidate, type ViewerContext } from "../lib/portavaRank.js";
import { rankItems, withDiscoveryNegativeFeedback } from "../services/ranking/DiscoveryRankingService.js";
import { newWorld, worldClient, flag, type WorldState } from "./helpers/fakeDiscoveryWorld.js";
import {
  drsGoldenInputs, drsGoldenViewer, drsGoldenDismissals, GOLDEN_NOW_MS,
} from "./helpers/portavaRankGoldenScenarios.js";

const NOW = Date.UTC(2026, 8, 28, 12);
const H = 3_600_000;
const DAY = 86_400_000;
const V = "aaaa1111-0000-4000-8000-00000000000a";
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

const PLACES: RankDesignPlace[] = [
  { id: `db/${U1}`, category: "food", lat: 38.7223, lng: -9.1393, savedCount: 3 },
  { id: `db/${U2}`, category: "food", lat: 38.70, lng: -9.20, savedCount: 1 },
  { id: "node/1", category: "nightlife", lat: 38.71, lng: -9.14, savedCount: 40 },
  { id: "node/2", category: "culture", lat: 38.72, lng: -9.13, savedCount: 0 },
];

/** Candidates exactly as lib/discoveryPde.ts rankForViewer maps them. */
function pdeCandidates(): RankCandidate[] {
  return PLACES.map((p) => ({
    id: p.id, kind: p.id.startsWith("db/") ? "gem" as const : "place" as const, city: "lisbon",
    category: p.category ?? null, distanceKm: 1, verified: p.id.startsWith("db/") ? true : null,
    likeCount: p.savedCount ?? null, tags: [], placeId: p.id,
  }));
}

function world(flags: string[], extra: Record<string, any[]> = {}): WorldState {
  return newWorld({ tables: {
    feature_flags: [
      ...flags.map((f) => flag(f, true, f === "discovery_diversity_axes_enabled"
        ? { placePenalty: 0.35, geoPenalty: 0.15, trailPenalty: 0.25, historyPenalty: 0.15, historyMaxServes: 3, historyWindowDays: 7 } : null)),
    ],
    rank_events: [
      { user_id: V, surface: "discovery", outcome: "dismiss", item_id: `db/${U2}`, served_at: new Date(NOW - DAY).toISOString() },
      { user_id: V, surface: "discovery", outcome: "impression", item_id: "node/1", served_at: new Date(NOW - 2 * H).toISOString() },
      { user_id: V, surface: "discovery", outcome: "impression", item_id: "node/1", served_at: new Date(NOW - 30 * H).toISOString() },
    ],
    availability_windows: [
      { id: "w", user_id: V, type: "one_time", start_at: new Date(NOW - H).toISOString(), end_at: new Date(NOW + 2 * H).toISOString(),
        expires_at: null, intents: ["Nightlife"], source: "explicit", open_to_plans: true, visibility: "private" },
    ],
    trip_members: [{ trip_id: "trip", user_id: V, role: "owner" }],
    trips: [{ id: "trip", status: "active", start_date: new Date(NOW - DAY).toISOString().slice(0, 10), end_date: new Date(NOW + 3 * DAY).toISOString().slice(0, 10),
      destination_city: "Lisbon", destination_lat: 38.7223, destination_lng: -9.1393 }],
    content_trails: [
      { trail_id: "t1", source_type: "place", source_id: U1, relationship: "primary" },
      { trail_id: "t1", source_type: "place", source_id: U2, relationship: "primary" },
    ],
    trails: [{ id: "t1", lifecycle_status: "active" }],
    discovery_places: [{ id: U1, osm_id: null, submitted_by: null }, { id: U2, osm_id: null, submitted_by: null }],
    saved_places: [], trust_reviews: [], profiles: [], user_follows: [], trust_profiles: [],
    ...extra,
  } });
}

const input = () => ({ viewerId: V, city: "lisbon", places: PLACES, nowMs: NOW });

beforeEach(() => invalidateRankDesignFlagCache());

describe("H — the pipeline hook", () => {
  it("H1 each flag alone assembles only its own inputs and reads only its own tables", async () => {
    const expected: Record<string, { reads: string[]; viewer: string[]; options: string[]; candidateKeys: string[] }> = {
      discovery_surface_objectives_enabled: { reads: [], viewer: [], options: ["objective"], candidateKeys: [] },
      discovery_engagement_integrity_enabled: { reads: ["discovery_places", "saved_places"], viewer: [], options: [], candidateKeys: ["engagementIntegrity", "likeCount"] },
      discovery_feature_families_enabled: { reads: ["rank_events"], viewer: ["explorationValue", "negativeFeedback"], options: [], candidateKeys: [] },
      discovery_intent_term_enabled: { reads: ["availability_windows"], viewer: ["intent"], options: [], candidateKeys: [] },
      discovery_trip_match_enabled: { reads: ["trip_members", "trips"], viewer: ["tripMatch"], options: [], candidateKeys: [] },
      discovery_diversity_axes_enabled: { reads: ["content_trails", "rank_events", "trails"], viewer: [], options: ["diversity"], candidateKeys: ["servedCount", "trailIds"] },
    };
    assert.deepEqual(Object.keys(expected), [...RANK_DESIGN_FLAGS]);
    for (const f of RANK_DESIGN_FLAGS) {
      invalidateRankDesignFlagCache();
      const w = world([f]);
      const d = await loadRankDesigns(worldClient(w), input());
      const e = expected[f];
      assert.equal(d.active, true, f);
      assert.deepEqual([...new Set(w.reads.filter((t) => t !== "feature_flags"))].sort(), e.reads, `${f} reads`);
      assert.deepEqual(Object.keys(d.viewer).sort(), e.viewer, `${f} viewer`);
      assert.deepEqual(Object.keys(d.options).sort(), e.options, `${f} options`);
      assert.deepEqual([...new Set([...d.candidates.values()].flatMap((c) => Object.keys(c)))].sort(), e.candidateKeys, `${f} candidates`);
      assert.deepEqual(d.degraded, [], f);
    }
  });

  it("H2 every flag on: the pde-shaped call carries every term, and the order moves", async () => {
    const w = world([...RANK_DESIGN_FLAGS]);
    const d = await loadRankDesigns(worldClient(w), input());
    assert.deepEqual(d.viewer.negativeFeedback, { categoryDismissals: { food: 1 } });
    assert.deepEqual(d.viewer.intent?.modes.map((m) => m.mode), ["high_energy"], "the viewer's explicit Nightlife window");
    assert.ok((d.viewer.tripMatch?.[`db/${U1}`] ?? 0) > 0.99, "the place at the trip's destination point");
    assert.deepEqual(d.candidates.get(`db/${U1}`)?.trailIds, ["t1"]);
    assert.equal(d.candidates.get("node/1")?.servedCount, 2);
    const ctx: ViewerContext = { userId: V, city: "lisbon", nowMs: NOW };
    const cands = pdeCandidates();
    const plain = rankCandidates(cands.map((c) => ({ ...c })), ctx, { exploration: false });
    const a = applyRankDesigns(cands, ctx, { exploration: false }, d);
    const designed = rankCandidates(a.candidates, a.ctx, a.opts);
    const keys = new Set(designed.flatMap((s) => Object.keys(s.features)));
    for (const k of ["intentMatch", "tripMatch", "negativeFeedback", "explorationValue"]) assert.ok(keys.has(k), k);
    assert.notDeepEqual(designed.map((s) => s.candidate.id), plain.map((s) => s.candidate.id));
    assert.equal(designed.find((s) => s.candidate.id === "node/1")!.features.intentMatch > 0, true, "nightlife fits the window's High Energy");
  });

  it("H3 a failing loader leaves its input absent and names itself", async () => {
    const w = world([...RANK_DESIGN_FLAGS]);
    for (const t of ["saved_places", "trip_members", "content_trails"]) w.errorTables.add(t);
    const d = await loadRankDesigns(worldClient(w), input());
    assert.deepEqual([...d.degraded].sort(), ["diversity", "integrity", "tripMatch"]);
    assert.equal(d.viewer.tripMatch, undefined);
    assert.ok(![...d.candidates.values()].some((c) => "engagementIntegrity" in c), "integrity unmeasured everywhere");
    assert.ok(![...d.candidates.values()].some((c) => "trailIds" in c));
    assert.ok(d.options.diversity, "the magnitudes still apply; only the Trail keys are missing");
  });

  it("H4 the caller's candidates are never mutated; the caller's own choices win", async () => {
    const w = world([...RANK_DESIGN_FLAGS]);
    const d = await loadRankDesigns(worldClient(w), input());
    const cands = pdeCandidates();
    const snapshot = JSON.stringify(cands);
    const a = applyRankDesigns(cands, { userId: V }, { exploration: false, diversity: { placePenalty: 0 } }, d);
    assert.equal(JSON.stringify(cands), snapshot);
    assert.equal(a.opts.exploration, false);
    assert.equal((a.opts.diversity as { placePenalty: number }).placePenalty, 0);
    assert.equal((a.opts.diversity as { trailPenalty: number }).trailPenalty, 0.25);
    const off = applyRankDesigns(cands, { userId: V }, { diversity: false }, d);
    assert.equal(off.opts.diversity, false, "a caller that turned diversity off keeps it off");
    assert.deepEqual(categoryDismissals(PLACES, new Set([`db/${U2}`, "node/404"])), { food: 1 });
  });
});

describe("H5 — the other surfaces' spread-in options", () => {
  it("H5 flag off ⇒ {} (the caller's options key for key); on ⇒ that surface's objective, owner overrides applied", async () => {
    assert.deepEqual(await surfaceObjectiveOptions(worldClient(newWorld({ tables: { feature_flags: [] } })), "pulse"), {});
    invalidateRankDesignFlagCache();
    assert.deepEqual(await surfaceObjectiveOptions(null, "pulse"), {});
    const on = worldClient(newWorld({ tables: { feature_flags: [flag("discovery_surface_objectives_enabled", true, { surfaces: { pulse: { freshness: 2 } } })] } }));
    const o = await surfaceObjectiveOptions(on, "pulse");
    assert.equal(o.objective?.surface, "pulse");
    assert.equal(o.objective?.featureWeights.recency, 2, "the owner's override");
    assert.equal(o.objective?.featureWeights.socialProof, 1.25, "the code default for an unset family");
  });
});

describe("N — DRS's negative-feedback inputs on the discovery surface", () => {
  it("N1 flag on: a dismissed item is hidden, ineligible and last, in both DRS modes", async () => {
    for (const mode of [[], [flag("ACTIVITY_DISCOVERY_BOOST_ENABLED", true)]]) {
      invalidateRankDesignFlagCache();
      const w = newWorld({ tables: { feature_flags: [...mode, flag("discovery_feature_families_enabled", true)], rank_events: drsGoldenDismissals() } });
      const out = await rankItems(drsGoldenInputs(), "discovery", drsGoldenViewer(), worldClient(w), {}, { emitPerCandidateAnalytics: false, nowMs: GOLDEN_NOW_MS });
      const tail = out.slice(-2);
      assert.deepEqual(tail.map((o) => o.itemId).sort(), ["node/2001", "node/2005"]);
      for (const o of tail) { assert.equal(o.eligibilityPassed, false); assert.equal(o.eligibilityReason, "viewer_hidden_item"); }
      assert.ok(out.slice(0, -2).every((o) => o.eligibilityPassed));
    }
  });

  it("N2 other surfaces, and the flag off, get the same array back unread", async () => {
    const inputs = drsGoldenInputs();
    const on = newWorld({ tables: { feature_flags: [flag("discovery_feature_families_enabled", true)], rank_events: drsGoldenDismissals() } });
    for (const surface of ["compass", "pulse", "explore"] as const) {
      assert.equal(await withDiscoveryNegativeFeedback(inputs, surface, drsGoldenViewer(), worldClient(on)), inputs, surface);
    }
    assert.deepEqual(on.reads, [], "no flag or dismissal read off the discovery surface");
    invalidateRankDesignFlagCache();
    const off = newWorld({ tables: { feature_flags: [], rank_events: drsGoldenDismissals() } });
    assert.equal(await withDiscoveryNegativeFeedback(inputs, "discovery", drsGoldenViewer(), worldClient(off)), inputs);
    assert.ok(!off.reads.includes("rank_events"), "flag off: dismissals are not read");
    assert.equal(await withDiscoveryNegativeFeedback(inputs, "discovery", drsGoldenViewer(), null), inputs);
  });

  it("N3 the flag cache is per client object", async () => {
    const a = worldClient(newWorld({ tables: { feature_flags: [flag("discovery_intent_term_enabled", true)] } }));
    const b = worldClient(newWorld({ tables: { feature_flags: [] } }));
    assert.equal((await loadRankDesignFlags(a, NOW)).intent.enabled, true);
    assert.equal((await loadRankDesignFlags(b, NOW)).intent.enabled, false, "b is not answered from a's cache");
    const malformed = worldClient(newWorld({ tables: { feature_flags: [{ flag: "discovery_intent_term_enabled", enabled: null, metadata: null }] } }));
    assert.equal((await loadRankDesignFlags(malformed, NOW)).intent.enabled, false, "only a TRUE row is ON");
    const errW = newWorld({ tables: {} }); errW.errorTables.add("feature_flags");
    const f = await loadRankDesignFlags(worldClient(errW), NOW);
    assert.equal(Object.values(f).some((s) => s.enabled), false, "an unreadable flag table is all OFF (fail-closed)");
  });
});
