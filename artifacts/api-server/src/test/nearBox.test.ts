/**
 * census-discovery §116 (DV-83 round 19, lane W11-X2; sweep SW13): lib/nearBox — the query box around a point and a
 * radius is never narrower than the circle it prefilters, wraps at the antimeridian, and opens over a pole.
 *
 *   NB1  every point ON the circle (0.9999 r, 720 bearings) at 64 centres — the equator, mid latitudes, 78–89.9°, both
 *        sides of ±180° — lies inside the box, for radii 1–500 km
 *   NB2  the shapes: one range away from the line; two ranges across it (either side); every longitude over a pole
 *   NB3  the box is not wider than it needs to be: at mid latitudes, a point 1% past the radius due north, and due east,
 *        is outside it
 *   NB4  applyNearBox: one range → gte/lte on the latitude then the longitude (the query GET /events always sent);
 *        two ranges → one `.or()` of two `and()`; every longitude → the latitude band only
 *   NB5  nearBoxTerms: one `and()` per range over a coordinate pair; the band alone over a pole
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nearBox, applyNearBox, nearBoxTerms } from "../lib/nearBox.js";

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
/** The sphere the distance filters measure on (withinEventsNear, the haversines in hiddenGemState and mapTravelers): a literal, not the module's constant, so the box is held to it. */
const FILTER_EARTH_KM = 6371;
/** The point `km` from (lat, lng) along `bearing` on that sphere, its longitude normalised to [-180, 180). */
function destination(lat: number, lng: number, km: number, bearing: number): { lat: number; lng: number } {
  const d = km / FILTER_EARTH_KM; const p1 = rad(lat); const l1 = rad(lng); const b = rad(bearing);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: deg(p2), lng: ((deg(l2) + 540) % 360) - 180 };
}
function inBox(box: ReturnType<typeof nearBox>, p: { lat: number; lng: number }): boolean {
  if (p.lat < box.south || p.lat > box.north) return false;
  return box.lngRanges === null || box.lngRanges.some(([w, e]) => p.lng >= w && p.lng <= e);
}

describe("census-discovery §116 (SW13): lib/nearBox", () => {
  it("NB1 every point on the circle lies inside the box — the equator, mid latitudes, near the poles, across ±180°", () => {
    const lats = [0, 16.05, -33.9, 38.72, 60, 78, 78.5, 80, 85, 89, 89.9, -80, -89.5];
    const lngs = [0, -9.14, 108.2, 179.98, -179.98, 179.5, -179.5];
    let checked = 0;
    for (const lat of lats) for (const lng of lngs) for (const r of [1, 25, 50, 100, 500]) {
      const box = nearBox(lat, lng, r);
      for (let b = 0; b < 360; b += 0.5) {
        const p = destination(lat, lng, r * 0.9999, b);
        assert.ok(inBox(box, p), `centre ${lat},${lng} r=${r} bearing ${b}: ${JSON.stringify(p)} outside ${JSON.stringify(box)}`);
        checked += 1;
      }
    }
    assert.ok(checked > 60_000);
  });
  it("NB2 the shapes: one range; two across the line (either side); every longitude over a pole", () => {
    assert.equal(nearBox(38.72, -9.14, 50).lngRanges?.length, 1);
    const east = nearBox(-16.82, 179.98, 50).lngRanges!;
    assert.equal(east.length, 2); assert.equal(east[0]![1], 180); assert.equal(east[1]![0], -180);
    assert.ok(east[1]![1] > -180 && east[1]![1] < -179);
    const west = nearBox(-16.82, -179.98, 50).lngRanges!;
    assert.equal(west.length, 2); assert.equal(west[0]![1], 180); assert.equal(west[1]![0], -180);
    assert.ok(west[0]![0] < 180 && west[0]![0] > 179);
    assert.equal(nearBox(89.8, 15, 50).lngRanges, null, "a circle that holds the pole covers every longitude");
    assert.equal(nearBox(-89.8, 15, 50).lngRanges, null);
    assert.notEqual(nearBox(89, 15, 50).lngRanges, null, "one that does not, does not");
  });
  it("NB3 the box is not wider than it needs to be: 1% past the radius due north and due east is outside it", () => {
    for (const [lat, lng] of [[38.72, -9.14], [16.05, 108.2], [-33.9, 151.2]] as const) {
      const box = nearBox(lat, lng, 50);
      assert.equal(inBox(box, destination(lat, lng, 50.5, 0)), false, `north of ${lat},${lng}`);
      assert.equal(inBox(box, destination(lat, lng, 50.5, 90)), false, `east of ${lat},${lng}`);
    }
  });
  it("NB4 applyNearBox: one range as gte/lte (lat then lng); two as one .or(); a pole as the band alone", () => {
    const calls: string[] = [];
    const q: any = { gte: (c: string, v: number) => { calls.push(`gte ${c}`); void v; return q; }, lte: (c: string, v: number) => { calls.push(`lte ${c}`); void v; return q; }, or: (f: string) => { calls.push(`or ${f}`); return q; } };
    applyNearBox(q, nearBox(38.72, -9.14, 50), "location_lat", "location_lng");
    assert.deepEqual(calls, ["gte location_lat", "lte location_lat", "gte location_lng", "lte location_lng"]);
    calls.length = 0;
    applyNearBox(q, nearBox(-16.82, 179.98, 50), "location_lat", "location_lng");
    assert.equal(calls.length, 3);
    assert.match(calls[2]!, /^or and\(location_lng\.gte\.179\.[0-9]+,location_lng\.lte\.180\),and\(location_lng\.gte\.-180,location_lng\.lte\.-179\.[0-9]+\)$/);
    calls.length = 0;
    applyNearBox(q, nearBox(89.8, 15, 50), "location_lat", "location_lng");
    assert.deepEqual(calls, ["gte location_lat", "lte location_lat"]);
  });
  it("NB5 nearBoxTerms: one and() per range over a coordinate pair; the band alone over a pole", () => {
    assert.equal(nearBoxTerms(nearBox(38.72, -9.14, 50), "latitude", "longitude").length, 1);
    const across = nearBoxTerms(nearBox(-16.82, 179.98, 50), "latitude", "longitude");
    assert.equal(across.length, 2);
    for (const t of across) assert.match(t, /^and\(latitude\.gte\.-?[0-9.]+,latitude\.lte\.-?[0-9.]+,longitude\.gte\.-?[0-9.]+,longitude\.lte\.-?[0-9.]+\)$/);
    assert.deepEqual(nearBoxTerms(nearBox(89.8, 15, 50), "latitude", "longitude").map((t) => t.includes("longitude")), [false]);
  });
});
