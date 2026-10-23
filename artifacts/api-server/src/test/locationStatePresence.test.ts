/**
 * POST /me/location-state — a save writes the keys it carries, and only those.
 *
 * THE DEFECT
 * ==========
 * `sanitizeText` answers `null` for anything that is not a string — including a
 * key the body never sent — and the handler wrote a column whenever the value was
 * `!== undefined`. So EVERY save wrote `manual_city = null` and blanked the stored
 * place: the GPS refresh that runs when a route starts, or when "nearest" sorts,
 * silently erased the city the traveller had picked by hand. In the other
 * direction, coordinates were written only `if (lat != null)`, so the client's
 * `coords: null` — sent when the traveller DENIES location — never cleared the
 * stored fix: the server kept a position the person had just withheld.
 *
 * WHAT IS PINNED
 * ==============
 *   1. A written GPS fix replaces the manual city even when the body does not say so (shipped clients send no
 *      manualCity key on a GPS save; a surviving manual_city is restored first on every relaunch), but a stale
 *      replayed fix and a save without a fix do not.
 *   2. `coords: null` clears lat/lng/accuracy; the manual city and the place stand.
 *   3. `manualCity: null` (the client's clearManualCity) still clears it.
 *   4. A place that IS sent is written whole: a key missing from it is null, so a
 *      stale district cannot survive a move to a new city.
 *   5. `place: null` clears the place.
 *
 * Run: node --import tsx/esm --test src/test/locationStatePresence.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const USER_ID = "22222222-2222-4222-8222-222222222222";
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
  };
}

const STORED: Row = {
  user_id: USER_ID,
  lat: 15.88, lng: 108.33, accuracy_meters: 12, last_known_at: "2026-10-20T08:00:00.000Z",
  city: "Hoi An", district: "Old Town", country: "Vietnam", country_code: "VN", formatted_location: "Old Town, Hoi An",
  manual_city: "Hoi An", manual_country: "Vietnam", manual_selected_at: "2026-10-19T08:00:00.000Z",
};

let server: Server; let port = 0;
async function save(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/me/location-state`, { method: "POST", headers: { Authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("POST /me/location-state — presence-based update", () => {
  before(() => new Promise<void>((resolve) => { server = createServer(app); server.listen(0, "127.0.0.1", () => { port = (server.address() as any).port; resolve(); }); }));
  after(() => new Promise<void>((resolve) => { _setTestClient(null as any, false); _setTestServiceClient(null as any); server.close(() => resolve()); }));

  it("1. a GPS save from a shipped client (no manualCity key) replaces the manual city, as the client's own state does", async () => {
    for (const source of ["gps_fresh", "gps_cached"]) {
      const c = makeClient({ ...STORED });
      _setTestClient(c as any, true);
      const r = await save({ source, permissionStatus: "granted", coords: { lat: 16.05, lng: 108.2, accuracyMeters: 9 }, place: { city: "Da Nang", country: "Vietnam" } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const w = c.state.writes[0]!;
      assert.equal(w.manual_city, null, `${source}: a written GPS fix must clear the manual city: ${JSON.stringify(w)}`);
      assert.equal(w.manual_country, null);
      assert.equal("manual_selected_at" in w, false);
      assert.equal(w.lat, 16.05);
      assert.equal(w.city, "Da Nang");
    }
  });

  it("1b. a GPS save whose fix is NOT written (a stale replay, or no valid coords) leaves the manual city standing", async () => {
    const c = makeClient({ ...STORED, last_known_at: "2026-10-22T08:00:00.000Z" });
    _setTestClient(c as any, true);
    const stale = await save({ source: "gps_cached", coords: { lat: 16.05, lng: 108.2, accuracyMeters: 9, observedAt: "2026-10-21T08:00:00.000Z" } });
    assert.equal(stale.status, 200, JSON.stringify(stale.body));
    assert.equal("manual_city" in c.state.writes[0]!, false, `a replayed older fix must not clear it: ${JSON.stringify(c.state.writes[0])}`);
    assert.equal("lat" in c.state.writes[0]!, false, "and the replayed fix itself was not written (not vacuous)");
    const c2 = makeClient({ ...STORED });
    _setTestClient(c2 as any, true);
    const noFix = await save({ source: "gps_fresh", permissionStatus: "granted", coords: { lat: "x", lng: 108.2 } });
    assert.equal(noFix.status, 200, JSON.stringify(noFix.body));
    assert.equal("manual_city" in c2.state.writes[0]!, false, "a GPS save that carries no valid fix replaces nothing");
  });

  it("2. coords: null (location denied) clears the stored fix and nothing else", async () => {
    const c = makeClient({ ...STORED });
    _setTestClient(c as any, true);
    const r = await save({ permissionStatus: "denied", source: "none", coords: null });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const w = c.state.writes[0]!;
    assert.equal(w.lat, null, `coords: null must clear lat: ${JSON.stringify(w)}`);
    assert.equal(w.lng, null);
    assert.equal(w.accuracy_meters, null);
    assert.equal(w.permission_status, "denied");
    for (const k of ["manual_city", "manual_country", "city", "district", "country", "country_code", "formatted_location"]) {
      assert.equal(k in w, false, `${k} was not in the body and must not be written`);
    }
    assert.equal(c.state.row!.manual_city, "Hoi An");
    assert.equal(c.state.row!.city, "Hoi An");
    assert.equal(r.body.observation, "no_fix");
  });

  it("3. manualCity: null — the client's clearManualCity — still clears it", async () => {
    const c = makeClient({ ...STORED });
    _setTestClient(c as any, true);
    const r = await save({ manualCity: null, manualCountry: null });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const w = c.state.writes[0]!;
    assert.equal(w.manual_city, null);
    assert.equal(w.manual_country, null);
    assert.equal("manual_selected_at" in w, false);
    assert.equal("city" in w, false, "no place was sent");
    assert.equal("lat" in w, false, "no coords key was sent, so the fix is untouched");
  });

  it("4. a manual pick writes the place whole — a key missing from it is null, not the old value", async () => {
    const c = makeClient({ ...STORED });
    _setTestClient(c as any, true);
    const r = await save({ source: "manual_city", manualCity: "Bangkok", manualCountry: "Thailand", place: { city: "Bangkok", country: "Thailand", countryCode: "TH" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const w = c.state.writes[0]!;
    assert.equal(w.manual_city, "Bangkok");
    assert.equal(w.manual_country, "Thailand");
    assert.ok(typeof w.manual_selected_at === "string");
    assert.equal(w.city, "Bangkok");
    assert.equal(w.district, null, "Hoi An's district must not survive the move to Bangkok");
    assert.equal(w.formatted_location, null);
  });

  it("5. place: null clears the stored place", async () => {
    const c = makeClient({ ...STORED });
    _setTestClient(c as any, true);
    const r = await save({ place: null });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const w = c.state.writes[0]!;
    for (const k of ["city", "district", "country", "country_code", "formatted_location"]) assert.equal(w[k], null, k);
    assert.equal("manual_city" in w, false);
  });
});
