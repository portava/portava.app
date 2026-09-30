/**
 * census-discovery §116 (DV-83 round 19, lane W11-X2; the round-18 verifier's B15): a Live-label gate whose read FAILED
 * is a failed live read at every reader, not only at the route's own once-per-request reading.
 *
 * The NOW gateway reads the Live-label gates three-state once per request (`liveLabelGatesUnread`, §115 SW7). Each
 * subject's claims then come from `readLiveClaims`, which re-read the same gates through `liveLabelsServable` — two-state,
 * false on a failed read — and answered an UNMARKED `[]`. When the route's read succeeded and a subject's re-read failed,
 * the object carried no `liveUnread`, and the place sheet said "No live activity has been observed here" over a gate
 * nobody read. `readLiveClaims` now reads the gates three-state itself (`liveLabelGatesRead`: the same reads, in the same
 * order, as `liveLabelsServable`) and answers `failedLiveClaimRead()` — the same `[]`, marked — when one could not be
 * read. A gate read and closed is the Live feature being off, and stays an unmarked `[]`. `liveLabelsServable` itself,
 * which Compass and its other callers read, is unchanged.
 *
 *   LT0   CONTROL: every read succeeds, a promoted claim → enriched (busy); the gate is read by the route AND per subject
 *   LT0b  CONTROL: the gate read fails every time → "Live activity couldn't be checked for this place"
 *   LT1   the route's gate read succeeds, the per-subject gate read FAILS → the same, never "No live activity observed"
 *   LT2   readLiveClaims, each of the five gates unreadable → `[]`, marked failed
 *   LT2c  CONTROL: readLiveClaims, each gate read and closed → `[]`, NOT marked (the feature is off)
 *   LT3   liveLabelGatesRead is "open" exactly when liveLabelsServable is true, over every gate on, off or unreadable
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import mapProjectionRouter, { _clearProtectedZoneCache, _clearFlowZoneCache } from "../routes/mapProjection.js";
import { makeFakeMapDb, mountRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";
import { _clearPromotedScopeCache, readLiveClaims, liveClaimReadFailed, liveLabelsServable, liveLabelGatesRead } from "../lib/liveClaimRead.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { mapQuickSignal } from "../lib/quickSignal.js";
import { CONFIDENCE_BAND_FLOOR } from "../lib/intelContracts.js";
import { buildLivePlaceView, missingReason } from "../../../../travel-buddy-standalone/src/features/map/place/livePlaceModel.ts";

const VIEWER = "aaaa1111-0000-0000-0000-0000000000d8";
const TOKEN = "r19-lt-token";
const P1 = "dddddddd-0000-0000-0000-0000000000f8";
const RAW = { lat: 16.054412, lng: 108.202233 };
const DISTRICT = "bbox=108.15,16.00,108.25,16.10&zoom=13";
const GATES = ["intel_live_label_crowd", "intel_claim_projection_crowd", "intel_capture_quick_signal", "disable_intel_live_labels", "intel_limited_live"] as const;
const OPEN: Record<(typeof GATES)[number], boolean> = { intel_live_label_crowd: true, intel_claim_projection_crowd: true, intel_capture_quick_signal: true, disable_intel_live_labels: false, intel_limited_live: true };
const LIVE_LABELS_ON = [{ flag: "map_projection_enabled", enabled: true }, ...GATES.filter((g) => OPEN[g]).map((flag) => ({ flag, enabled: true }))];
const place = { id: P1, name: "Han Market", primary_category: "night_market", city: "Da Nang", neighborhood: "Hai Chau", country_code: "VN", latitude: RAW.lat, longitude: RAW.lng, status: "active", merged_into_place_id: null };
const level = mapQuickSignal("arrival", "busy")!;
const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };

function world(flags: Array<{ flag: string; enabled: boolean }> = LIVE_LABELS_ON): FakeState {
  const now = Date.now();
  const snap = { id: "snap-l", claim_type: level.claimType, value: level.value, subject_id: P1, zone_id: "zone-hai-chau", confidence: CONFIDENCE_BAND_FLOOR.live + 0.05, source_count: 30, observed_at: new Date(now - 120_000).toISOString(), expires_at: new Date(now + 1_800_000).toISOString(), privacy_eligible: true };
  return { feature_flags: flags, blocks: [], protected_zones: [], places: [place], intel_live_promoted_scopes: [{ scope_key: `zone-hai-chau|${level.claimType}` }], intel_state_snapshots: [snap] };
}

/** Fail reads of `flag` from call number `failFrom` on (1-based); null = never. */
function failingFlag(client: any, flag: string, failFrom: number | null): { calls: () => number } {
  let calls = 0;
  const from = client.from;
  client.from = (t: string) => {
    const q = from(t);
    if (t !== "feature_flags") return q;
    const eq = q.eq;
    q.eq = (col: string, val: unknown) => {
      if (col === "flag" && val === flag) {
        calls += 1;
        if (failFrom !== null && calls >= failFrom) {
          const fail: any = { select: () => fail, eq: () => fail, limit: () => fail, maybeSingle: () => Promise.resolve({ data: null, error: TIMEOUT }), single: () => fail.maybeSingle(), then: (r: any, j: any) => fail.maybeSingle().then(r, j) };
          return fail;
        }
      }
      return eq(col, val);
    };
    return q;
  };
  return { calls: () => calls };
}

let app: ProjectionApp | null = null;
beforeEach(() => { _clearProtectedZoneCache(); _clearFlowZoneCache(); _clearPromotedScopeCache(); _resetRateLimit(); });
afterEach(async () => { if (app) await app.close(); app = null; });

async function sheet(failFrom: number | null) {
  const client: any = makeFakeMapDb(world(), { token: TOKEN, userId: VIEWER });
  const counter = failingFlag(client, "intel_live_label_crowd", failFrom);
  app = await mountRouterApp(mapProjectionRouter, client, { token: TOKEN, userId: VIEWER });
  const r = await app.projection(`${DISTRICT}&kinds=place`);
  const obj = (r.body.objects ?? []).find((o: any) => o.kind === "place");
  const vm = obj ? buildLivePlaceView(obj, null, { now: Date.now() }) : null;
  const said = vm ? missingReason(vm, "live_state") : null;
  return { obj, said, calls: counter.calls(), seen: JSON.stringify({ status: r.status, flagReads: counter.calls(), liveEnrichment: r.body.liveEnrichment, liveUnread: obj?.liveUnread ?? null, activity: obj?.activity ?? null, said }) };
}

describe("census-discovery §116 (B15): the Live-label gate re-read per subject is three-state", () => {
  it("LT0 CONTROL: every read succeeds → enriched (busy); the gate is read by the route and per subject", async () => {
    const r = await sheet(null);
    assert.equal(r.obj?.activity, "busy", r.seen);
    assert.ok(r.calls >= 2, `the flag is read by the route AND per subject: ${r.seen}`);
  });
  it("LT0b CONTROL: the gate read fails every time → the object is liveUnread", async () => {
    const r = await sheet(1);
    assert.equal(r.said, "Live activity couldn't be checked for this place", r.seen);
  });
  it("LT1 the route's gate read succeeds, the per-subject gate read FAILS → never 'No live activity observed'", async () => {
    const r = await sheet(2);
    assert.ok(r.obj, r.seen);
    assert.equal(r.said, "Live activity couldn't be checked for this place", `a gate nobody read said as no live activity: ${r.seen}`);
  });

  for (const gate of GATES) {
    it(`LT2 readLiveClaims, ${gate} unreadable → [] marked failed`, async () => {
      const client: any = makeFakeMapDb(world(), { token: TOKEN, userId: VIEWER });
      failingFlag(client, gate, 1);
      const claims = await readLiveClaims(client, P1);
      assert.deepEqual(claims, []);
      assert.equal(liveClaimReadFailed(claims), true, `an unread ${gate} answered as no claim`);
    });
    it(`LT2c CONTROL: readLiveClaims, ${gate} read and closed → [] not marked`, async () => {
      const flags = [{ flag: "map_projection_enabled", enabled: true }, ...GATES.map((g) => ({ flag: g, enabled: g === gate ? !OPEN[g] : OPEN[g] }))];
      const client: any = makeFakeMapDb(world(flags), { token: TOKEN, userId: VIEWER });
      const claims = await readLiveClaims(client, P1);
      assert.deepEqual(claims, []);
      assert.equal(liveClaimReadFailed(claims), false, `a closed ${gate} marked as a failed read`);
    });
  }
  it("LT2o CONTROL: readLiveClaims, every gate open → the promoted claim, not marked", async () => {
    const client: any = makeFakeMapDb(world(), { token: TOKEN, userId: VIEWER });
    const claims = await readLiveClaims(client, P1);
    assert.equal(claims.length, 1);
    assert.equal(liveClaimReadFailed(claims), false);
  });

  it("LT3 liveLabelGatesRead is 'open' exactly when liveLabelsServable is true, over every gate on, off or unreadable", async () => {
    const states = ["open", "closed", "unread"] as const;
    let combos = 0;
    const walk = async (i: number, pick: Array<(typeof states)[number]>): Promise<void> => {
      if (i === GATES.length) {
        const make = () => {
          const flags = [{ flag: "map_projection_enabled", enabled: true }, ...GATES.map((g, k) => ({ flag: g, enabled: pick[k] === "open" ? OPEN[g] : !OPEN[g] }))];
          const client: any = makeFakeMapDb(world(flags), { token: TOKEN, userId: VIEWER });
          GATES.forEach((g, k) => { if (pick[k] === "unread") failingFlag(client, g, 1); });
          return client;
        };
        const two = await liveLabelsServable(make());
        const three = await liveLabelGatesRead(make());
        assert.equal(three === "open", two, `${pick.join(",")}: three-state ${three}, two-state ${two}`);
        const first = pick.findIndex((p) => p !== "open");
        assert.equal(three, first === -1 ? "open" : pick[first], `${pick.join(",")}: the first gate that is not open decides, as liveLabelsServable's order does`);
        combos += 1;
        return;
      }
      for (const s of states) await walk(i + 1, [...pick, s]);
    };
    await walk(0, []);
    assert.equal(combos, 3 ** GATES.length);
  });
});
