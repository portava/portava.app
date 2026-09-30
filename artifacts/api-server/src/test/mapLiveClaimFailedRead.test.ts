/**
 * census-discovery §115 (DV-83 round 18, lane W11-X2; the round-17 verifier's B11): "a live state nobody read is said"
 * also when the read FAILED rather than threw.
 *
 * `readLiveClaims` never throws over a failed read: an unreadable snapshot table, or an unreadable promoted-scope
 * allowlist, answers `failedLiveClaimRead()` — an empty array marked in a WeakSet (`liveClaimReadFailed`, §94). The
 * gateway's read wrapper mapped it through `toLiveClaimEnvelope` with a plain `.map`, dropping the mark, so
 * `enrichWithLiveClaims` saw "no claim" and the place sheet said "No live activity has been observed here". The wrapper
 * now throws on the mark, and SW4's throw arm marks the object `liveUnread` ("Live activity couldn't be checked for
 * this place", livePlaceModel.liveUnread LU1). The verifier's LF probes, adapted to the served object:
 *
 *   LF0  CONTROL: the snapshot table read, no claim for the place → no liveUnread
 *   LF0b CONTROL: a promoted claim for the place → enriched (the chain reaches the snapshot read)
 *   LF1  the intel_state_snapshots read FAILS → liveUnread
 *   LF2  the promoted-scope allowlist read FAILS → liveUnread
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import mapProjectionRouter, { _clearProtectedZoneCache, _clearFlowZoneCache } from "../routes/mapProjection.js";
import { startRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { mapQuickSignal } from "../lib/quickSignal.js";
import { CONFIDENCE_BAND_FLOOR } from "../lib/intelContracts.js";

const VIEWER = "aaaa1111-0000-0000-0000-0000000000c8";
const TOKEN = "r18-lf-token";
const P1 = "dddddddd-0000-0000-0000-0000000000f1";
const RAW = { lat: 16.054412, lng: 108.202233 };
const DISTRICT = "bbox=108.15,16.00,108.25,16.10&zoom=13";
const LIVE_LABELS_ON = [
  { flag: "map_projection_enabled", enabled: true },
  { flag: "intel_live_label_crowd", enabled: true },
  { flag: "intel_claim_projection_crowd", enabled: true },
  { flag: "intel_capture_quick_signal", enabled: true },
  { flag: "intel_limited_live", enabled: true },
];
const place = { id: P1, name: "Han Market", primary_category: "night_market", city: "Da Nang", neighborhood: "Hai Chau", country_code: "VN", latitude: RAW.lat, longitude: RAW.lng, status: "active", merged_into_place_id: null };
const DOWN = { error: { message: "canceling statement due to statement timeout", code: "57014" } };
function world(over: FakeState = {}): FakeState {
  return { feature_flags: LIVE_LABELS_ON, blocks: [], protected_zones: [], places: [place], intel_live_promoted_scopes: [{ scope_key: "zone-hai-chau|crowd.level" }], intel_state_snapshots: [], ...over };
}

let app: ProjectionApp | null = null;
beforeEach(() => { _clearProtectedZoneCache(); _clearFlowZoneCache(); _clearPromotedScopeCache(); _resetRateLimit(); });
afterEach(async () => { if (app) await app.close(); app = null; });

/** The fields of a NOW gateway object these cases read. */
interface PlaceObject { kind: string; liveUnread?: true; activity?: string }

async function place1(state: FakeState) {
  app = await startRouterApp(mapProjectionRouter, state, { token: TOKEN, userId: VIEWER });
  const r = await app.projection(`${DISTRICT}&kinds=place`);
  const objects = ((r.body as { objects?: PlaceObject[] }).objects ?? []);
  const obj = objects.find((o) => o.kind === "place") ?? null;
  return { obj, seen: JSON.stringify({ status: r.status, liveEnrichment: (r.body as { liveEnrichment?: unknown }).liveEnrichment, liveUnread: obj?.liveUnread ?? null, activity: obj?.activity ?? null }) };
}

describe("census-discovery §115 (B11): a live state whose read FAILED (not threw) is marked unread on the NOW map", () => {
  it("LF0 CONTROL: snapshots read, no claim for the place → no liveUnread (the body is unchanged)", async () => {
    const r = await place1(world());
    assert.ok(r.obj, r.seen);
    assert.equal(r.obj.liveUnread, undefined, r.seen);
    assert.equal("liveUnread" in r.obj, false, r.seen);
  });
  it("LF0b CONTROL: a promoted live claim → enriched, so LF1/LF2 reach the read they fail", async () => {
    const level = mapQuickSignal("arrival", "busy")!;
    const now = Date.now();
    const snap = { id: "snap-l", claim_type: level.claimType, value: level.value, subject_id: P1, zone_id: "zone-hai-chau", confidence: CONFIDENCE_BAND_FLOOR.live + 0.05, source_count: 30, observed_at: new Date(now - 120_000).toISOString(), expires_at: new Date(now + 1_800_000).toISOString(), privacy_eligible: true };
    const r = await place1(world({ intel_live_promoted_scopes: [{ scope_key: `zone-hai-chau|${level.claimType}` }], intel_state_snapshots: [snap] }));
    assert.equal(r.obj?.activity, "busy", r.seen);
    assert.equal(r.obj?.liveUnread, undefined, r.seen);
  });
  it("LF1 the intel_state_snapshots read FAILS → the object carries liveUnread", async () => {
    const r = await place1(world({ intel_state_snapshots: DOWN }));
    assert.ok(r.obj, r.seen);
    assert.equal(r.obj.liveUnread, true, `a failed live read served as no claim: ${r.seen}`);
    assert.equal(r.obj.activity, undefined, r.seen);
  });
  it("LF2 the promoted-scope allowlist read FAILS → the object carries liveUnread", async () => {
    const r = await place1(world({ intel_live_promoted_scopes: DOWN }));
    assert.ok(r.obj, r.seen);
    assert.equal(r.obj.liveUnread, true, `a failed live read served as no claim: ${r.seen}`);
  });
});
