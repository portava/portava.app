/**
 * Trips spec §18.3 — presence is "the newest valid observation with
 * expiry/confidence; never simple last-write-wins across stale devices"
 * (census-trips TR351). POST /me/location-state through the app.
 *
 *   a fix that says when it was observed is stored at that instant;
 *   a fix observed BEFORE the stored one is not written over it, and the
 *   client is told (observation: stale_ignored, TRIP_PRESENCE_STALE);
 *   the rest of that request (permission, place) still applies;
 *   a fix with no observedAt is the legacy shape: the server's receipt time;
 *   an observedAt in the future beyond clock skew is not believed.
 *
 * Run: node --import tsx/esm --test src/test/tripPresenceNewestObservation.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { observedAtOf } from "../routes/location.js";
import { TRIP_REASON_CODES } from "../lib/tripReasonCodes.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
type Row = Record<string, any>;

function makeClient(initial: Row | null) {
  const state: { row: Row | null; writes: Row[] } = { row: initial, writes: [] };
  return {
    state,
    auth: { getUser: async (token: string) => token === "tok" ? { data: { user: { id: USER_ID } }, error: null } : { data: { user: null }, error: { message: "invalid" } } },
    from(table: string) {
      const chain: any = {
        select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: async () => ({ data: table === "user_location_state" ? state.row : null, error: null }),
        single: async () => ({ data: table === "user_location_state" ? state.row : null, error: null }),
        upsert: (patch: Row) => { if (table === "user_location_state") { state.writes.push(patch); state.row = { ...(state.row ?? {}), ...patch }; } return { then: (f: any) => Promise.resolve({ data: null, error: null }).then(f) }; },
        insert: () => ({ then: (f: any) => Promise.resolve({ data: null, error: null }).then(f) }),
        then: (f: any, r: any) => Promise.resolve({ data: [], error: null }).then(f, r),
      };
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
    storage: { createBucket: async () => ({ error: null }), from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
  };
}

let server: Server; let port = 0;
async function put(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/me/location-state`, { method: "POST", headers: { Authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const STORED = "2026-09-11T12:00:00.000Z";

describe("TR351 — newest valid observation, never last-write-wins", () => {
  before(() => new Promise<void>((resolve) => { server = createServer(app); server.listen(0, "127.0.0.1", () => { port = (server.address() as any).port; resolve(); }); }));
  after(() => new Promise<void>((resolve) => { _setTestClient(null as any, false); _setTestServiceClient(null as any); server.close(() => resolve()); }));

  it("a fix observed after the stored one is written at its own instant", async () => {
    const c = makeClient({ user_id: USER_ID, lat: 1, lng: 1, last_known_at: STORED });
    _setTestClient(c as any, true);
    const later = "2026-09-11T12:30:00.000Z";
    const r = await put({ source: "gps", coords: { lat: 41.15, lng: -8.61, accuracyMeters: 10, observedAt: later } });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.observation, "written");
    assert.equal(c.state.writes[0]!.last_known_at, later); assert.equal(c.state.writes[0]!.lat, 41.15);
  });
  it("a fix observed BEFORE the stored one is not written over it: stale_ignored, TRIP_PRESENCE_STALE, both instants named", async () => {
    const c = makeClient({ user_id: USER_ID, lat: 1, lng: 1, last_known_at: STORED });
    _setTestClient(c as any, true);
    const earlier = "2026-09-11T11:00:00.000Z";
    const r = await put({ source: "gps", coords: { lat: 41.15, lng: -8.61, accuracyMeters: 10, observedAt: earlier }, place: { city: "Porto" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.observation, "stale_ignored"); assert.equal(r.body.reasonCode, "TRIP_PRESENCE_STALE");
    assert.equal(r.body.observedAt, earlier); assert.equal(r.body.storedLastKnownAt, STORED);
    const w = c.state.writes[0]!;
    assert.equal("lat" in w, false, "the stale coordinate was not written"); assert.equal("last_known_at" in w, false);
    assert.equal(w.city, "Porto", "the rest of the patch still applied");
    assert.equal(c.state.row!.lat, 1, "the stored fix stands");
  });
  it("no stored fix yet: any observed fix is written; no observedAt: the legacy receipt time", async () => {
    const c = makeClient(null);
    _setTestClient(c as any, true);
    const r1 = await put({ source: "gps", coords: { lat: 41.15, lng: -8.61, observedAt: "2026-09-11T11:00:00.000Z" } });
    assert.equal(r1.body.observation, "written"); assert.equal(c.state.writes[0]!.last_known_at, "2026-09-11T11:00:00.000Z");
    const before = Date.now();
    const r2 = await put({ source: "gps", coords: { lat: 41.16, lng: -8.62 } });
    assert.equal(r2.body.observation, "written");
    assert.ok(Date.parse(c.state.writes[1]!.last_known_at) >= before, "legacy shape: server receipt time");
  });
  it("observedAtOf: ISO within skew is kept, the far future and garbage are not", () => {
    const now = "2026-09-13T12:00:00.000Z";
    assert.equal(observedAtOf("2026-09-13T11:59:00Z", now), "2026-09-13T11:59:00.000Z");
    assert.equal(observedAtOf("2026-09-13T12:04:00Z", now), "2026-09-13T12:04:00.000Z", "inside the five-minute skew");
    assert.equal(observedAtOf("2026-09-13T12:06:00Z", now), null, "beyond the skew: not believed");
    assert.equal(observedAtOf("yesterday", now), null); assert.equal(observedAtOf(12, now), null);
  });
  it("TRIP_PRESENCE_STALE is Appendix B's", () => {
    assert.ok((TRIP_REASON_CODES as readonly string[]).includes("TRIP_PRESENCE_STALE"));
  });
});
