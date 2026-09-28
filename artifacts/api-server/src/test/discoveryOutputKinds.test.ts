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
  id, slug: `slug-${id.slice(-2)}`, title: `Trail ${id.slice(-2)}`, description: null, destination: "miami", place_scope: null,
  parent_trail_id: null, lifecycle_status: "active", created_by: null, created_at: iso(createdMsAgo), updated_at: iso(createdMsAgo),
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

  it("K4. emerging discoveries: the latest run's claims, under the route's eligibility, with their trend state", async () => {
    const w = world(); w["feature_flags"] = [flagRow("discovery_output_kinds_enabled", true)];
    w["place_momentum"]!.push({ place_id: `db/${P.BLOCKED}`, trend_state: "rediscovered", recent_rate: 99, computed_at: w["place_momentum"]![0]!["computed_at"] });
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
