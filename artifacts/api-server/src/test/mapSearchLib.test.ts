/**
 * mapSearch pure layer — normalizers, ranking, query filter, pagination.
 * Run: node --import tsx/esm --test src/test/mapSearchLib.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTraveler, normalizeGem, normalizeEvent,
  rankResults, filterByQuery, paginate, decodeCursor, haversineKm,
} from "../lib/mapSearch.js";

describe("normalizers", () => {
  it("traveler → normalized result, coarse coords, people actions, no exact", () => {
    const r = normalizeTraveler({
      id: "u1", displayName: "Alex", avatarUrl: "a.jpg", verified: true, openToMeet: true,
      city: "Cebu", country: "PH", freshness: "live", precision: "city", lat: 10.3, lng: 123.9,
    });
    assert.equal(r.resultType, "traveler");
    assert.deepEqual(r.coordinates, { lat: 10.3, lng: 123.9 });
    assert.equal(r.permissions.canViewExact, false);
    assert.equal(r.permissions.canMessage, true);
    assert.ok(r.actions.includes("message") && r.actions.includes("block"));
    assert.ok(r.preview.badges.includes("verified"));
  });

  it("passes a null avatarUrl through unchanged (A2: upstream flag-gate null is not resurrected)", () => {
    // listMapTravelers already nulls avatarUrl when show_profile_picture_publicly
    // is false; normalizeTraveler must carry that null through to thumbnailUrl
    // rather than substituting a value — this is why fixing A1 auto-closes A2.
    const r = normalizeTraveler({
      id: "u2", displayName: "Blake", avatarUrl: null, verified: false, openToMeet: false,
      city: "Cebu", country: "PH", freshness: "recent", precision: "area", lat: 10.3, lng: 123.9,
    });
    assert.equal(r.preview.thumbnailUrl, null, "null avatar must remain null after normalization");
  });

  it("gem → carries coordsPrecision into permissions; distance into reason", () => {
    const exact = normalizeGem({ id: "g1", name: "Rooftop", category: "viewpoint", city: "Cebu", lat: 10.31, lng: 123.91, coordsPrecision: "exact", verification_level: "community" }, 1.2);
    assert.equal(exact.resultType, "gem");
    assert.equal(exact.permissions.canViewExact, true);
    assert.equal(exact.rankingReason, "1.2 km away");
    const protectedGem = normalizeGem({ id: "g2", name: "Secret", lat: null, lng: null, coordsPrecision: "hidden" }, null);
    assert.equal(protectedGem.coordinates, null, "protected gem exposes no coordinates");
  });

  it("event → venue coords + event actions", () => {
    const r = normalizeEvent({ id: "e1", title: "Meetup", location_name: "Plaza", location_lat: 10.3, location_lng: 123.9, starts_at: "2026-08-01T18:00:00Z", visibility: "public" });
    assert.equal(r.resultType, "event");
    assert.deepEqual(r.coordinates, { lat: 10.3, lng: 123.9 });
    assert.ok(r.actions.includes("join"));
  });
});

describe("rankResults", () => {
  it("sorts nearest-first and sinks coordinate-less results to the end", () => {
    const center = { lat: 0, lng: 0 };
    const far = normalizeEvent({ id: "far", title: "Far", location_lat: 10, location_lng: 10 });
    const near = normalizeEvent({ id: "near", title: "Near", location_lat: 0.1, location_lng: 0.1 });
    const none = normalizeGem({ id: "none", name: "NoCoords", lat: null, lng: null, coordsPrecision: "hidden" });
    const ranked = rankResults([far, none, near], center);
    assert.deepEqual(ranked.map((r) => r.id), ["near", "far", "none"]);
    assert.ok((ranked[0].distanceKm ?? 0) < (ranked[1].distanceKm ?? 0));
    assert.equal(ranked[2].distanceKm, null);
  });

  it("is deterministic for equal distances (stable by id)", () => {
    const c = { lat: 0, lng: 0 };
    const a = normalizeEvent({ id: "b", title: "B", location_lat: 1, location_lng: 0 });
    const b = normalizeEvent({ id: "a", title: "A", location_lat: 1, location_lng: 0 });
    const ranked = rankResults([a, b], c);
    assert.deepEqual(ranked.map((r) => r.id), ["a", "b"]);
  });
});

describe("filterByQuery", () => {
  it("matches title or subtitle, case-insensitive; empty query passes all", () => {
    const rs = [
      normalizeGem({ id: "g1", name: "Rooftop Bar", city: "Cebu", coordsPrecision: "exact", lat: 1, lng: 1 }),
      normalizeGem({ id: "g2", name: "Museum", city: "Tokyo", coordsPrecision: "exact", lat: 1, lng: 1 }),
    ];
    assert.equal(filterByQuery(rs, "rooftop").length, 1);
    assert.equal(filterByQuery(rs, "TOKYO").length, 1);
    assert.equal(filterByQuery(rs, "").length, 2);
  });
});

describe("paginate", () => {
  const make = (n: number) => Array.from({ length: n }, (_, i) => normalizeEvent({ id: `e${i}`, title: `E${i}`, location_lat: 0, location_lng: 0 }));
  it("returns a page + nextCursor, and null cursor on the last page", () => {
    const rs = make(25);
    const p1 = paginate(rs, null, 10);
    assert.equal(p1.page.length, 10);
    assert.equal(p1.nextCursor, "10");
    const p3 = paginate(rs, "20", 10);
    assert.equal(p3.page.length, 5);
    assert.equal(p3.nextCursor, null);
  });
  it("decodeCursor rejects junk → 0", () => {
    assert.equal(decodeCursor(null), 0);
    assert.equal(decodeCursor("-5"), 0);
    assert.equal(decodeCursor("abc"), 0);
    assert.equal(decodeCursor("30"), 30);
  });
});

describe("haversineKm", () => {
  it("is ~0 for identical points and positive otherwise", () => {
    assert.ok(haversineKm(10, 20, 10, 20) < 0.001);
    assert.ok(haversineKm(0, 0, 0, 1) > 100);
  });
});
