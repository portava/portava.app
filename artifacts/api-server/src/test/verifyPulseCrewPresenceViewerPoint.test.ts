/**
 * §16 crew presence — the Pulse's "friend nearby" signal must be able to FIRE.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `readCrewPresenceForPulse` measured distance from `viewerPoint`, which it took
 * from `map.members.find((m) => m.userId === viewerId)`. `getCrewMap` filters
 * the viewer OUT of `allUserIds` by design — it is a map of other people — and
 * every read after that is `.in("user_id", allUserIds)`. So that `find` was
 * structurally always null, `viewerPoint` was always null, the loop `continue`d
 * on every member, and the source reported `status: "ok", observations: 0` on
 * EVERY trip, for every traveller, permanently. Nothing looked wrong: an absent
 * signal is indistinguishable from "no crewmate is near you".
 *
 * ── WHAT IS ASSERTED, AND WHY IT BITES ──────────────────────────────────────
 * Case 1 is the whole point: a crewmate 300 m away with exact coordinates
 * produces AN OBSERVATION. Against the old code it cannot, whatever the fixture
 * says, because the viewer has no point to measure from. SHOWN RED before the
 * fix: `observations 0 !== 1`.
 *
 * The rest pin the properties that make the fix honest rather than merely
 * non-zero: the viewer's own row is read (not the crew map), a viewer who has
 * genuinely shared no position still yields zero — now for a TRUE reason, and
 * reported in `detail` — and an unreadable table REFUSES rather than reporting
 * "you have no position", which is the same lie in a different costume.
 *
 * Run: node --import tsx/esm --test src/test/verifyPulseCrewPresenceViewerPoint.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readCrewPresenceForPulse } from "../domain/trips/projections/TripPulseCrewPresence.js";

const TRIP = "11111111-0000-4000-8000-000000000001";
const VIEWER = "22222222-0000-4000-8000-000000000002";
const MATE = "33333333-0000-4000-8000-000000000003";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const FRESH = new Date(NOW - 60_000).toISOString();
const SOON = new Date(NOW + 30 * 60_000).toISOString();

/** ~300 m north of the viewer: inside any sane "nearby" band. */
const VIEWER_POINT = { lat: 38.7223, lng: -9.1393 };
const MATE_POINT = { lat: 38.7250, lng: -9.1393 };

interface Opts { errorTable?: string; viewerHasPoint?: boolean; }

function makeClient(o: Opts = {}) {
  const viewerHasPoint = o.viewerHasPoint !== false;
  const reads: string[] = [];

  function from(table: string) {
    reads.push(table);
    const filters: Record<string, any> = {};
    const err = () => (o.errorTable === table ? { message: `injected ${table}`, code: "XX000" } : null);

    const rowsFor = (): any[] => {
      switch (table) {
        case "feature_flags":
          return [{ flag: "trip_crew_map_enabled", enabled: true }];
        case "trips":
          return [{ id: TRIP, owner_id: VIEWER }];
        case "trip_members":
          return [
            { trip_id: TRIP, user_id: VIEWER, role: "owner", status: "accepted" },
            { trip_id: TRIP, user_id: MATE, role: "member", status: "accepted" },
          ];
        case "user_location_state": {
          // The viewer's OWN row is fetched by a viewer-scoped read; the crew
          // read asks for the mate. Both are served from one table here.
          const all = [
            ...(viewerHasPoint ? [{ user_id: VIEWER, lat: VIEWER_POINT.lat, lng: VIEWER_POINT.lng, city: "Lisbon", district: null, country: "PT", updated_at: FRESH, last_known_at: FRESH, source: "gps", accuracy_meters: 10 }] : []),
            { user_id: MATE, lat: MATE_POINT.lat, lng: MATE_POINT.lng, city: "Lisbon", district: null, country: "PT", updated_at: FRESH, last_known_at: FRESH, source: "gps", accuracy_meters: 10 },
          ];
          return all;
        }
        case "trip_crew_location_preferences":
          // The mate has opted in to crew sharing. Without this row the policy
          // resolves default_visibility to "hidden" and the card is withheld —
          // correctly. The fixture must clear the REAL preconditions, not be
          // arranged so the assertion passes regardless of them.
          return [
            { trip_id: TRIP, user_id: MATE, default_visibility: "exact", ghost_mode_enabled: false, share_arrival_status: true, share_safe_return_status: true },
          ];
        case "trip_crew_location_sessions":
          return [
            { id: "s-viewer", trip_id: TRIP, user_id: VIEWER, status: "active", visibility_level: "exact", expires_at: SOON, allowed_member_ids: null, subgroup_id: null },
            // The grant is FROM the mate TO the viewer: getCrewMap drops any session
            // whose allowed_member_ids does not include the viewer, and a null list
            // reads as "nobody". That is the real rule, so the fixture obeys it.
            { id: "s-mate", trip_id: TRIP, user_id: MATE, status: "active", visibility_level: "exact", expires_at: SOON, allowed_member_ids: [VIEWER], subgroup_id: null },
          ];
        default:
          return [];
      }
    };

    const apply = (rows: any[]) =>
      rows.filter((r) =>
        Object.entries(filters).every(([k, v]) =>
          Array.isArray(v) ? v.map(String).includes(String(r[k])) : r[k] === v,
        ),
      );

    const proxy: any = new Proxy(
      {
        select() { return proxy; },
        eq(c: string, v: any) { filters[c] = v; return proxy; },
        in(c: string, v: any[]) { filters[c] = v; return proxy; },
        gt() { return proxy; },
        is() { return proxy; },
        limit() { return proxy; },
        order() { return proxy; },
        maybeSingle() {
          const e = err();
          return Promise.resolve(e ? { data: null, error: e } : { data: apply(rowsFor())[0] ?? null, error: null });
        },
        then(res: any, rej?: any) {
          const e = err();
          return Promise.resolve(e ? { data: null, error: e } : { data: apply(rowsFor()), error: null }).then(res, rej);
        },
      },
      { get: (t: any, p: string) => (p in t ? t[p] : () => proxy) },
    );
    return proxy;
  }
  return { from, _reads: reads };
}

describe("the Pulse's friend-nearby signal can fire at all", () => {
  it("a crewmate 300 m away PRODUCES an observation (red before the fix: 0)", async () => {
    const sc = makeClient();
    const r = await readCrewPresenceForPulse(sc as any, TRIP, VIEWER, NOW);
    assert.equal(
      r.source.observations, 1,
      `the whole §16 signal was permanently inert; got ${JSON.stringify(r.source)}`,
    );
    assert.ok(r.viewerPoint, "the viewer's own position must be resolved");
    const obs = r.observations.get(MATE);
    assert.ok(obs && obs.length === 1, "the crewmate must be the observed party");
    assert.equal(obs![0].value.userId, MATE);
    assert.ok(obs![0].value.distanceBand, "a band must be assigned");
  });

  it("reads the viewer's OWN rows rather than expecting them in the crew map", async () => {
    const sc = makeClient();
    await readCrewPresenceForPulse(sc as any, TRIP, VIEWER, NOW);
    // getCrewMap excludes the viewer, so a self-entry can only come from a
    // viewer-scoped read. Both tables it uses must have been consulted.
    assert.ok(sc._reads.includes("user_location_state"));
    assert.ok(sc._reads.includes("trip_crew_location_sessions"));
  });

  it("a viewer who has shared NO position yields zero — for a true reason, and says so", async () => {
    const sc = makeClient({ viewerHasPoint: false });
    const r = await readCrewPresenceForPulse(sc as any, TRIP, VIEWER, NOW);
    assert.equal(r.source.observations, 0);
    assert.equal(r.viewerPoint, null);
    assert.match(String(r.source.detail ?? ""), /viewer has no position/i);
  });

  it("an unreadable own-position table REFUSES instead of reporting 'you have no position'", async () => {
    const sc = makeClient({ errorTable: "user_location_state" });
    const r = await readCrewPresenceForPulse(sc as any, TRIP, VIEWER, NOW);
    assert.equal(r.source.status, "unread", JSON.stringify(r.source));
    assert.equal(r.source.observations, 0);
  });
});
