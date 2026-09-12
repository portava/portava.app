/**
 * census-trips TR110 / TR160 — an EXPIRED live-share grant must not release
 * exact coordinates.
 *
 * WHAT THIS PINS, AND WHY IT IS NOT A BUG REPORT AGAINST PRODUCTION.
 * `TripCrewLocationService` filters expired sessions in SQL
 * (`.gt("expires_at", now)`, TripCrewLocationService.ts:250) and gates on
 * `allowed_member_ids.includes(viewerId)`, so today no expired grant reaches
 * `buildCrewCard`. Verified by reading the only caller. This file is therefore
 * about the GUARD, not about a live leak.
 *
 * THE GAP IT CLOSES. `lib/tripCrewLocation.ts` calls itself a "Privacy Guard"
 * and states a PRIVACY CONTRACT whose first clause is that exact lat/lng are
 * released only under "an active live-share grant". It accepts `now` and spends
 * it on position freshness, but never compares it to `liveShare.expiresAt`; the
 * comment at :182 asserts "the GRANT has not expired" as a premise rather than
 * checking it. The premise is currently true because of a WHERE clause in a
 * different file. That is the shape §32.7 of census-trips warns about — reading
 * the sentence about the object instead of the object — and it means a second
 * caller, or an edit to that WHERE clause, releases coordinates with nothing in
 * this module objecting.
 *
 * The grant's expiry is data the function already receives. Checking it costs
 * one comparison and makes the header true by construction.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/tripCrewLocationExpiredGrant.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildCrewCard, type RawMemberLocation } from "../lib/tripCrewLocation.js";

const NOW = Date.parse("2026-09-11T12:00:00.000Z");
const FRESH = new Date(NOW - 60_000).toISOString();          // 1 min old → "live"
const CEBU = { city: "Cebu City", district: "IT Park", country: "PH" };

/** A member sharing precise location, with the grant's expiry as the variable. */
function sharer(expiresAt: string): RawMemberLocation {
  return {
    userId: "u1", name: "Alice", handle: "alice", avatarUrl: null,
    prefs: { defaultVisibility: "nearby", ghostModeEnabled: false, shareArrivalStatus: true, shareSafeReturnStatus: false },
    locationState: { ...CEBU, updatedAt: FRESH, lat: 10.3157, lng: 123.8854 },
    checkInStatus: null,
    hasSafeReturnActive: false,
    hotelBlurEnabled: false,
    liveShare: { id: "s1", visibilityLevel: "nearby", expiresAt },
  };
}

describe("TR110/TR160 — the live-share grant's own expiry is enforced by the guard", () => {
  it("POSITIVE CONTROL: an unexpired grant still releases exact coordinates", () => {
    // Without this, a bug that withholds coordinates unconditionally would make
    // the real assertion below pass for the wrong reason.
    const card = buildCrewCard(sharer(new Date(NOW + 900_000).toISOString()), NOW);
    assert.equal(card.liveShareActive, true);
    assert.deepEqual(card.exactCoords, { lat: 10.3157, lng: 123.8854 });
    assert.equal(card.statusLabel, "live_sharing_active");
  });

  it("an EXPIRED grant releases no coordinates, and does not report itself active", () => {
    const card = buildCrewCard(sharer(new Date(NOW - 1_000).toISOString()), NOW);
    assert.equal(card.exactCoords ?? null, null,
      "an expired grant must not release exact coordinates");
    assert.equal(card.liveShareActive, false,
      "an expired grant is not an active live share");
    assert.notEqual(card.statusLabel, "live_sharing_active");
  });

  it("expiry is evaluated against the passed `now`, not the wall clock", () => {
    // The same grant is live at one instant and expired at a later one. This is
    // what makes the check real rather than a constant: a test that only ever
    // passed Date.now() could not tell the two apart.
    const expiresAt = new Date(NOW + 300_000).toISOString();
    assert.deepEqual(buildCrewCard(sharer(expiresAt), NOW).exactCoords, { lat: 10.3157, lng: 123.8854 });
    assert.equal(buildCrewCard(sharer(expiresAt), NOW + 600_000).exactCoords ?? null, null);
  });

  it("a grant expiring exactly now is expired — the boundary is not open", () => {
    const card = buildCrewCard(sharer(new Date(NOW).toISOString()), NOW);
    assert.equal(card.exactCoords ?? null, null);
    assert.equal(card.liveShareActive, false);
  });

  it("an unparseable expiry is treated as expired, not as permission", () => {
    // Fail closed. A malformed timestamp is an unknown grant state, and the
    // safe reading of an unknown grant is that there isn't one.
    const card = buildCrewCard(sharer("not-a-timestamp"), NOW);
    assert.equal(card.exactCoords ?? null, null);
    assert.equal(card.liveShareActive, false);
  });

  it("an expired grant does not resurrect the member's passive default either", () => {
    // Once the grant is gone the member falls back to their stored visibility,
    // which here is 'nearby' — a label, never coordinates.
    const card = buildCrewCard(sharer(new Date(NOW - 1).toISOString()), NOW);
    assert.equal(card.exactCoords ?? null, null);
    assert.equal(card.statusLabel, "nearby");
  });

  it("ghost mode still wins over a perfectly valid grant", () => {
    const raw = sharer(new Date(NOW + 900_000).toISOString());
    raw.prefs!.ghostModeEnabled = true;
    const card = buildCrewCard(raw, NOW);
    assert.equal(card.statusLabel, "location_hidden");
    assert.equal(card.exactCoords ?? null, null);
  });
});
