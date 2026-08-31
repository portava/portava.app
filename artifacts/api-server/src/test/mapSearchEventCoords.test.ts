/**
 * map/search must honor show_exact_location (audit six-system MAP·H1).
 *
 * loadNearbyEvents used to select raw location_lat/lng and never consult
 * show_exact_location, so a host who hid the exact venue still had it echoed on
 * the discovery map to any non-participant. This pins the redaction.
 *
 * Run: node --import tsx/esm --test src/test/mapSearchEventCoords.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadNearbyEvents } from "../routes/mapSearch.js";

const VIEWER = "viewer-0000-0000-0000-000000000001";
const HOST   = "host-0000-0000-0000-000000000002";

const EVENTS = [
  { id: "e-visible", host_id: HOST,   title: "Open party",   location_name: "Rooftop",
    location_lat: 10.30, location_lng: 123.90, show_exact_location: true,  visibility: "public", state: "open" },
  { id: "e-hidden",  host_id: HOST,   title: "Private addr", location_name: "Downtown",
    location_lat: 10.31, location_lng: 123.91, show_exact_location: false, visibility: "public", state: "open" },
  { id: "e-mine",    host_id: VIEWER, title: "My hidden ev", location_name: "My place",
    location_lat: 10.32, location_lng: 123.92, show_exact_location: false, visibility: "public", state: "open" },
];

// Table-aware fake: events list returns the fixtures; every eligibility read
// resolves so checkEventEligibility returns {ok:true}; the trust-gates flag is off.
function fakeSc() {
  const b = (table: string): any => {
    const chain: any = {
      _t: table,
      select() { return chain; }, eq() { return chain; }, neq() { return chain; },
      in() { return chain; }, not() { return chain; }, is() { return chain; },
      gte() { return chain; }, lte() { return chain; }, gt() { return chain; }, lt() { return chain; },
      or() { return chain; }, order() { return chain; }, limit() { return chain; }, range() { return chain; },
      maybeSingle() {
        if (table === "feature_flags") return Promise.resolve({ data: { enabled: false }, error: null });
        return Promise.resolve({ data: null, error: null }); // no roles, no ban, no block
      },
      then(onF: any, onR: any) {
        const data = table === "events" ? EVENTS.map((e) => ({ ...e })) : [];
        return Promise.resolve({ data, error: null }).then(onF, onR);
      },
    };
    return chain;
  };
  return { from: (t: string) => b(t) };
}

describe("loadNearbyEvents — show_exact_location redaction", () => {
  it("nulls coordinates of an other-host hidden-location event, keeps visible + own", async () => {
    const out = await loadNearbyEvents(fakeSc() as any, VIEWER, 10.31, 123.91, 25, new Set());
    const by = Object.fromEntries(out.map((e: any) => [e.id, e]));

    // Positive controls: a shown-location event and the viewer's OWN hidden event keep coords.
    assert.equal(by["e-visible"].location_lat, 10.30, "shown-location event keeps coords");
    assert.equal(by["e-mine"].location_lat, 10.32, "viewer's own hidden event keeps coords (they are the host)");

    // The redaction: another host's hidden-location event must have no coordinates.
    assert.equal(by["e-hidden"].location_lat, null, "hidden-location event coords must be redacted");
    assert.equal(by["e-hidden"].location_lng, null, "hidden-location event coords must be redacted");
  });
});
