/**
 * Trips spec §10.1/§10.2 — presence freshness classes, source, confidence;
 * the stale-render guard on the crew card; `stale_presence_render_attempt_total`.
 * census-trips TR159, TR161, TR162, TR164, TR165, TR342, TR399.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { classifyPresence, presenceConfidence, PRESENCE_FRESHNESS_CLASSES, PRESENCE_LIVE_MS, PRESENCE_RECENT_MS } from "../lib/tripPresenceFreshness.js";
import { buildCrewCard, type RawMemberLocation } from "../lib/tripCrewLocation.js";
import { readTripMetric, _resetTripMetrics } from "../lib/tripMetrics.js";

const NOW = Date.parse("2026-09-13T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("§10.2 the four classes, judged on the position's own clock", () => {
  it("LIVE within 15 min, RECENT within 60, LAST_KNOWN beyond, OFFLINE with no observation — and only the first two are drawable as current", () => {
    const at = (ms: number) => classifyPresence({ lastKnownAt: ago(ms), updatedAt: ago(0), expiresAt: null, source: "gps", accuracyMeters: 12 }, NOW);
    assert.equal(at(60_000).freshnessClass, "LIVE");
    assert.equal(at(PRESENCE_LIVE_MS).freshnessClass, "LIVE");
    assert.equal(at(PRESENCE_LIVE_MS + 1).freshnessClass, "RECENT");
    assert.equal(at(PRESENCE_RECENT_MS).freshnessClass, "RECENT");
    assert.equal(at(PRESENCE_RECENT_MS + 1).freshnessClass, "LAST_KNOWN");
    assert.equal(at(PRESENCE_RECENT_MS + 1).drawableAsCurrent, false);
    assert.equal(at(60_000).drawableAsCurrent, true);
    const none = classifyPresence({ lastKnownAt: null, updatedAt: null, expiresAt: null, source: null, accuracyMeters: null }, NOW);
    assert.equal(none.freshnessClass, "OFFLINE"); assert.equal(none.observedAt, null); assert.equal(none.ageSeconds, null);
    assert.deepEqual([...PRESENCE_FRESHNESS_CLASSES], ["LIVE", "RECENT", "LAST_KNOWN", "OFFLINE"]);
  });
  it("uses last_known_at when present and says so; a row touched this morning does not make a week-old position LIVE", () => {
    const f = classifyPresence({ lastKnownAt: ago(7 * 86_400_000), updatedAt: ago(60_000), expiresAt: null, source: "gps", accuracyMeters: 10 }, NOW);
    assert.equal(f.freshnessClass, "LAST_KNOWN"); assert.equal(f.observedAtSource, "last_known_at");
    const legacy = classifyPresence({ lastKnownAt: null, updatedAt: ago(60_000), expiresAt: null, source: null, accuracyMeters: null }, NOW);
    assert.equal(legacy.freshnessClass, "LIVE"); assert.equal(legacy.observedAtSource, "updated_at");
  });
  it("an expired observation is OFFLINE whatever its age", () => {
    const f = classifyPresence({ lastKnownAt: ago(1000), updatedAt: null, expiresAt: ago(1), source: "gps", accuracyMeters: 5 }, NOW);
    assert.equal(f.freshnessClass, "OFFLINE"); assert.equal(f.drawableAsCurrent, false);
  });
  it("confidence is the device's accuracy, banded, INSUFFICIENT when unknown — and carried separately from freshness", () => {
    assert.equal(presenceConfidence(10), "HIGH"); assert.equal(presenceConfidence(50), "HIGH");
    assert.equal(presenceConfidence(51), "MEDIUM"); assert.equal(presenceConfidence(200), "MEDIUM");
    assert.equal(presenceConfidence(201), "LOW"); assert.equal(presenceConfidence(null), "INSUFFICIENT"); assert.equal(presenceConfidence(-1), "INSUFFICIENT");
    const f = classifyPresence({ lastKnownAt: ago(7 * 86_400_000), updatedAt: null, expiresAt: null, source: "gps", accuracyMeters: 5 }, NOW);
    assert.equal(f.confidence, "HIGH"); assert.equal(f.freshnessClass, "LAST_KNOWN", "a precise fix from a week ago is precise and stale");
  });
});

describe("the crew card carries §10.1's fields and never draws a stale position as current", () => {
  beforeEach(() => _resetTripMetrics());
  const CEBU = { city: "Cebu City", district: "IT Park", country: "PH" };
  const sharer = (o: Partial<NonNullable<RawMemberLocation["locationState"]>> = {}): RawMemberLocation => ({
    userId: "u1", name: "Alice", handle: "alice", avatarUrl: null,
    prefs: { defaultVisibility: "nearby", ghostModeEnabled: false, shareArrivalStatus: true, shareSafeReturnStatus: false },
    locationState: { ...CEBU, updatedAt: ago(60_000), lastKnownAt: ago(60_000), lat: 10.3157, lng: 123.8854, source: "gps", accuracyMeters: 8, ...o },
    checkInStatus: null, hasSafeReturnActive: false, hotelBlurEnabled: false,
    liveShare: { id: "s1", visibilityLevel: "nearby", expiresAt: ago(-900_000) },
  });
  it("source, confidence, observedAt and freshnessClass are on the card", () => {
    const card = buildCrewCard(sharer(), NOW);
    assert.equal(card.source, "gps"); assert.equal(card.confidence, "HIGH");
    assert.equal(card.freshnessClass, "LIVE"); assert.equal(card.observedAt, ago(60_000));
    assert.deepEqual(card.exactCoords, { lat: 10.3157, lng: 123.8854 });
  });
  it("under an active grant, a LAST_KNOWN position withholds exact coordinates, says LAST_KNOWN, and counts the attempt", () => {
    const card = buildCrewCard(sharer({ lastKnownAt: ago(2 * 3_600_000) }), NOW);
    assert.equal(card.liveShareActive, true, "the grant is still active — the person chose to share");
    assert.equal(card.exactCoords ?? null, null, "but a two-hour-old point is not drawn as where they are");
    assert.equal(card.freshnessClass, "LAST_KNOWN"); assert.equal(card.freshness, "stale");
    const m = readTripMetric("stale_presence_render_attempt_total");
    assert.deepEqual(m.map((s) => [s.labels.reason, s.count]), [["live_share_grant_over_last_known_position", 1]]);
  });
  it("judges the position on last_known_at, not the row's updated_at", () => {
    const card = buildCrewCard(sharer({ updatedAt: ago(60_000), lastKnownAt: ago(2 * 3_600_000) }), NOW);
    assert.equal(card.freshnessClass, "LAST_KNOWN");
    assert.equal(card.exactCoords ?? null, null);
  });
  it("no observation at all is OFFLINE with INSUFFICIENT confidence, and no metric — nothing was attempted", () => {
    const card = buildCrewCard(sharer({ updatedAt: null, lastKnownAt: null, lat: null, lng: null, source: null, accuracyMeters: null }), NOW);
    assert.equal(card.freshnessClass, "OFFLINE"); assert.equal(card.confidence, "INSUFFICIENT"); assert.equal(card.freshness, null);
    assert.deepEqual(readTripMetric("stale_presence_render_attempt_total"), []);
  });
});
