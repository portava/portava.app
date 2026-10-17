/**
 * discoveryOutputKinds — census-discovery §85 (lane W10-R3), DC-01: the three
 * `01` §4 output kinds PDE did not rank, behind `discovery_output_kinds_enabled`
 * (3483, seeded FALSE).
 *
 *   K1  flag off: nothing is read or ranked for any of the three
 *   K2  Trails are RANKED by PDE, not listed newest-first: a Trail matching
 *       the viewer's stated interest and followed by others outranks a newer one
 *   K3  Shared Moments: only moments the viewer is an ACCEPTED member of, a
 *       blocked or inactive owner's moment never, and the Shared Moments
 *       capability flag still governs
 *   K4  emerging discoveries: the latest run's emerging/rediscovered places,
 *       under the route's eligibility, ranked, each carrying its trend state
 *   K5  the ten kinds are named, and none of the three writes a row
 *
 * CONTROLLED DATA.
 *
 * Runtime: node:test + node:assert/strict.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { invalidateDiscoveryModifiersFlagCache } from "../lib/discoveryModifiers.js";
import {
  rankTrailsForViewer, rankSharedMomentsForViewer, rankEmergingForViewer, DISCOVERY_OUTPUT_KINDS,
} from "../lib/discoveryCandidates/outputKinds.js";
import { makeFakeCandidateDb, flagRow, type Row } from "./helpers/fakeCandidateDb.js";
import { NOW, P, VIEWER, AUTHOR_BLOCKED, AUTHOR_FOLLOWED, AUTHOR_INACTIVE, iso, viewer, world } from "./helpers/candidateWorld.js";

beforeEach(() => invalidateDiscoveryModifiersFlagCache());

const T_OLD = "55555555-5555-4555-8555-555555555501";
const T_NEW = "55555555-5555-4555-8555-555555555502";
const trailRow = (id: string, createdMsAgo: number): Row => ({
  id, slug: `slug-${id.slice(-2)}`, title: `Trail ${id.slice(-2)}`, description: null, destination: "miami", destination_key: "miami", place_scope: null, // §91: 3441's stored key, which listTrails compares since §77
  parent_trail_id: null, review_state: "approved", lifecycle_status: "active", created_by: null, created_at: iso(createdMsAgo), updated_at: iso(createdMsAgo),
});

function trailWorld(): Record<string, Row[]> {
  return {
    feature_flags: [flagRow("discovery_output_kinds_enabled", true)],
    trails: [trailRow(T_OLD, 90 * 86_400_000), trailRow(T_NEW, 86_400_000)],
    content_trails: [{ trail_id: T_OLD, source_type: "place", source_id: P.TRAIL_MEMBER, relationship: "signal", signal: "rooftop", created_at: iso(1) }],
    trail_follows: Array.from({ length: 30 }, (_, i) => ({ trail_id: T_OLD, user_id: `f-${i}` })),
    rank_events: [], ranking_config: [],
  };
}

const moment = (id: string, owner: string, over: Row = {}): Row => ({ id, owner_id: owner, status: "active", title: `moment ${id}`, place_id: null, created_at: iso(3_600_000), ...over });

function momentWorld(): Record<string, Row[]> {
  const w = world();
  w["feature_flags"] = ["shared_moments_enabled", "external_places_enabled", "live_places_enabled", "place_days_enabled", "discovery_output_kinds_enabled"].map((f) => flagRow(f, true));
  w["shared_moment_memberships"] = [
    { user_id: VIEWER, status: "accepted", role: "member", updated_at: iso(1), shared_moments: moment("m-ok", AUTHOR_FOLLOWED) },
    { user_id: VIEWER, status: "accepted", role: "member", updated_at: iso(2), shared_moments: moment("m-blocked", AUTHOR_BLOCKED) },
    { user_id: VIEWER, status: "accepted", role: "member", updated_at: iso(3), shared_moments: moment("m-inactive", AUTHOR_INACTIVE) },
    { user_id: VIEWER, status: "invited", role: "member", updated_at: iso(4), shared_moments: moment("m-invited", AUTHOR_FOLLOWED) },
  ];
  w["media_attachments"] = [];
  return w;
}

describe("DC-01 — Trails, Shared Moments and emerging discoveries, ranked by PDE", () => {
  it("K1. flag off: nothing is read or ranked", async () => {
    const db = makeFakeCandidateDb({ ...trailWorld(), feature_flags: [] });
    const t = await rankTrailsForViewer(db, viewer(), { nowMs: NOW });
    const m = await rankSharedMomentsForViewer(db, viewer(), { nowMs: NOW });
    const e = await rankEmergingForViewer(db, viewer(), { nowMs: NOW });
    for (const r of [t, m, e]) assert.equal(r.status, "flag_off");
    assert.deepEqual(db.reads.map((r) => r.table), ["feature_flags"], "one flag read, cached for the rest");
  });

  it("K2. Trails are ranked, not listed: an older Trail that matches the viewer and has followers outranks a newer one", async () => {
    const v = viewer({ interestTags: new Set(["rooftop"]) });
    const r = await rankTrailsForViewer(makeFakeCandidateDb(trailWorld()), v, { nowMs: NOW, destination: "miami" });
    assert.equal(r.status, "ranked"); assert.equal(r.rankedBy, "pde");
    assert.deepEqual(r.items.map((t) => t.id), [T_OLD, T_NEW], "listTrails alone returns them newest-first");
  });

  it("K3. Shared Moments: accepted memberships only; a blocked or inactive owner's moment never", async () => {
    const db = makeFakeCandidateDb(momentWorld());
    const r = await rankSharedMomentsForViewer(db, viewer(), { nowMs: NOW });
    assert.equal(r.status, "ranked");
    assert.deepEqual(r.items.map((m) => m.id), ["m-ok"]);
    const noCapability = momentWorld(); noCapability["feature_flags"] = noCapability["feature_flags"]!.filter((f) => f["flag"] !== "shared_moments_enabled");
    const off = await rankSharedMomentsForViewer(makeFakeCandidateDb(noCapability), viewer(), { nowMs: NOW });
    assert.equal(off.status, "empty", "the Shared Moments capability flag still governs");
    assert.deepEqual(off.items, []);
  });

  it("K3. Shared Moments refuse unreadable owner standing instead of treating an inactive owner as active", async () => {
    const db = makeFakeCandidateDb(momentWorld(), { erroring: ["profiles"] });
    const result = await rankSharedMomentsForViewer(db, viewer(), { nowMs: NOW });
    assert.deepEqual(result.items, []);
    assert.equal(result.status, "unavailable");
    assert.equal(result.rankedBy, "none");
    assert.equal(result.unavailable, "profiles.standing");
    assert.deepEqual(db.writes, []);
  });

  it("K4. emerging discoveries: the latest run's claims, under the route's eligibility, with their trend state", async () => {
    const w = world(); w["feature_flags"] = [flagRow("discovery_output_kinds_enabled", true)];
    w["place_momentum"]!.push({ place_id: `db/${P.BLOCKED}`, trend_state: "rediscovered", recent_rate: 99, computed_at: w["place_momentum"]![0]!["computed_at"], recent_unique_travelers: 20, window_unique_travelers: 20 });  // ≥ k: refused by ELIGIBILITY, not by the disclosure floor
    const r = await rankEmergingForViewer(makeFakeCandidateDb(w), viewer(), { nowMs: NOW });
    assert.equal(r.status, "ranked");
    assert.deepEqual(r.items.map((x) => [x.place.id, x.trendState]), [[`db/${P.EMERGING}`, "emerging"]], "the blocked author's rediscovered place is refused");
  });

  it("K5. the ten kinds are named, and ranking a kind writes nothing", async () => {
    assert.equal(DISCOVERY_OUTPUT_KINDS.length, 10);
    const db = makeFakeCandidateDb(trailWorld());
    await rankTrailsForViewer(db, viewer(), { nowMs: NOW });
    const m = makeFakeCandidateDb(momentWorld());
    await rankSharedMomentsForViewer(m, viewer(), { nowMs: NOW });
    assert.deepEqual([...db.writes, ...m.writes], []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2026-10-17 — the independent privacy gate on 3988 (PASS-WITH-CONDITIONS):
// the emerging-discoveries kind serves each place's TREND STATE from the newest
// place_momentum run, through the same read as the candidate retrievals. It is
// held to the same two rules: the trend API's freshness bound, and no run while
// any active protected zone exists; an unreadable zone policy is named.
// Appended at the foot so no line above that a census cites moves.
// ═════════════════════════════════════════════════════════════════════════════
import { TREND_SNAPSHOT_MAX_AGE_MS } from "../lib/discoveryTrendExplanation.js";

describe("2026-10-17 privacy gate on 3988 — emerging discoveries' run", () => {
  const on = (): Record<string, Row[]> => { const w = world(); w["feature_flags"] = [flagRow("discovery_output_kinds_enabled", true)]; return w; };

  it("K6. a stale run serves no trend state: the kind is empty, not ranked", async () => {
    const w = on();
    const latest = w["place_momentum"]![0]!["computed_at"];
    const stale = new Date(NOW - TREND_SNAPSHOT_MAX_AGE_MS - 1).toISOString();
    w["place_momentum"] = w["place_momentum"]!.map((r) => (r["computed_at"] === latest ? { ...r, computed_at: stale } : r));
    const r = await rankEmergingForViewer(makeFakeCandidateDb(w), viewer(), { nowMs: NOW });
    assert.equal(r.status, "empty");
    assert.deepEqual(r.items, []);
  });

  it("K7. while any active protected zone exists the kind is empty; an unreadable zone policy is unavailable and names protected_zones", async () => {
    const w = on(); w["protected_zones"] = [{ id: "zone-1", active: true }];
    const z = await rankEmergingForViewer(makeFakeCandidateDb(w), viewer(), { nowMs: NOW });
    assert.equal(z.status, "empty");
    assert.deepEqual(z.items, []);
    const u = await rankEmergingForViewer(makeFakeCandidateDb(on(), { erroring: ["protected_zones"] }), viewer(), { nowMs: NOW });
    assert.equal(u.status, "unavailable");
    assert.equal(u.unavailable, "protected_zones");
    const control = await rankEmergingForViewer(makeFakeCandidateDb(on()), viewer(), { nowMs: NOW });
    assert.equal(control.status, "ranked", "control: no zone, current run");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2026-10-17 — found while closing the gate above: the emerging-discoveries kind
// SERVES each place's trend state (`trendState`, GET
// /v1/discovery/recommendations/emerging_discoveries), and a served trend state
// is a DISCLOSURE. The trend API discloses one only over ≥ k travellers in BOTH
// windows (mayDiscloseTrend; D-OWNER1004-2's k = 15) and never for a place under
// a `suppressed` trend review, an unread review withholding (§93, H-W10T-1).
// This kind is now held to the same two rules, by the same functions.
// ═════════════════════════════════════════════════════════════════════════════
import { mayDiscloseTrend, TREND_DISCLOSURE_MIN_TRAVELERS } from "../lib/discoveryTrendExplanation.js";

describe("2026-10-17 — emerging discoveries serve a trend state only under the trend API's disclosure rules", () => {
  const k = TREND_DISCLOSURE_MIN_TRAVELERS;
  const on = (): Record<string, Row[]> => { const w = world(); w["feature_flags"] = [flagRow("discovery_output_kinds_enabled", true)]; return w; };
  const withCounts = (recent: number | null, window: number | null): Record<string, Row[]> => {
    const w = on();
    w["place_momentum"] = w["place_momentum"]!.map((r) => (r["place_id"] === `db/${P.EMERGING}` ? { ...r, recent_unique_travelers: recent, window_unique_travelers: window } : r));
    return w;
  };

  it("K8. ≥ k travellers in BOTH windows, exactly as mayDiscloseTrend: below the floor in either window, or a row without counts, is not served", async () => {
    const cases: Array<[number | null, number | null]> = [[k, k], [k - 1, k], [k, k - 1], [null, k], [k, null], [null, null]];
    let disclosed = 0;
    for (const [recent, window] of cases) {
      const api = mayDiscloseTrend({ place_id: `db/${P.EMERGING}`, trend_state: "emerging", recent_unique_travelers: recent, window_unique_travelers: window });
      const r = await rankEmergingForViewer(makeFakeCandidateDb(withCounts(recent, window)), viewer(), { nowMs: NOW });
      assert.equal(r.items.some((x) => x.place.id === `db/${P.EMERGING}`), api, `${recent}/${window}: the kind and the trend API disagree`);
      assert.equal(r.status, api ? "ranked" : "empty", `${recent}/${window}`);
      if (api) disclosed++;
    }
    assert.equal(disclosed, 1, "both sides of the floor were exercised");
  });

  it("K9. a place under a `suppressed` trend review is not served as emerging; an unreadable review withholds it; a review of another place does not", async () => {
    const suppressed = withCounts(k, k);
    suppressed["trend_integrity_reviews"] = [{ subject_kind: "place", subject_id: `db/${P.EMERGING}`, verdict: "suppressed", created_at: iso(1_000) }];
    const s = await rankEmergingForViewer(makeFakeCandidateDb(suppressed), viewer(), { nowMs: NOW });
    assert.deepEqual(s.items, []);
    const unread = await rankEmergingForViewer(makeFakeCandidateDb(withCounts(k, k), { erroring: ["trend_integrity_reviews"] }), viewer(), { nowMs: NOW });
    assert.deepEqual(unread.items, []);
    const other = withCounts(k, k);
    other["trend_integrity_reviews"] = [{ subject_kind: "place", subject_id: `db/${P.TRENDING}`, verdict: "suppressed", created_at: iso(1_000) }];
    const o = await rankEmergingForViewer(makeFakeCandidateDb(other), viewer(), { nowMs: NOW });
    assert.deepEqual(o.items.map((x) => [x.place.id, x.trendState]), [[`db/${P.EMERGING}`, "emerging"]], "control");
  });

  it("K10. the kind READS both windows' counts, so a store without them (pre-3410) cannot disclose — unavailable, never served unfloored; the candidate retrievals do not depend on them", async () => {
    const sc = makeFakeCandidateDb(on());
    await rankEmergingForViewer(sc, viewer(), { nowMs: NOW });
    const body = sc.reads.find((r) => r.table === "place_momentum" && r.ops.includes("in(trend_state)"));
    assert.ok(body?.ops.some((op) => op.startsWith("select(") && op.includes("recent_unique_travelers") && op.includes("window_unique_travelers")), "the claim read names both counts");
    const preCounts = { missingColumns: { place_momentum: ["recent_unique_travelers", "window_unique_travelers"] } };
    const r = await rankEmergingForViewer(makeFakeCandidateDb(on(), preCounts), viewer(), { nowMs: NOW });
    assert.equal(r.status, "unavailable");
    assert.equal(r.unavailable, "place_momentum");
    const { retrieveEmergingDiscoveries } = await import("../lib/discoveryCandidates/retrievals.js");
    const g = await retrieveEmergingDiscoveries({ sc: makeFakeCandidateDb(world(), preCounts), userId: VIEWER, cityPrefix: "miami", followedIds: new Set(), viewedPlaceIds: [], nowMs: NOW, memo: new Map() });
    assert.equal(g.status, "ok", "a candidate retrieval never asks for the counts");
    assert.deepEqual(g.ids, [`db/${P.EMERGING}`]);
  });
});
