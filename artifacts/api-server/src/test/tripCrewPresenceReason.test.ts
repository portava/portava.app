/**
 * Appendix B TRIP_PRESENCE_* on the wire (census-trips TR446). §6.1
 * canSeePresence decided TRIP_PRESENCE_GHOST / TRIP_PRESENCE_HIDDEN and the
 * crew card rendered a label; now the card carries the reason code beside the
 * label, and null when presence is shown.
 *
 * Run: node --import tsx/esm --test src/test/tripCrewPresenceReason.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildCrewCard, type RawMemberLocation } from "../lib/tripCrewLocation.js";
import { TRIP_REASON_CODES } from "../lib/tripReasonCodes.js";

const NOW = Date.parse("2026-09-11T12:00:00.000Z");
const FRESH = new Date(NOW - 60_000).toISOString();
const CEBU = { city: "Cebu City", district: "IT Park", country: "PH" };

function member(over: Partial<RawMemberLocation> = {}): RawMemberLocation {
  return {
    userId: "u1", name: "Alice", handle: "alice", avatarUrl: null,
    prefs: { defaultVisibility: "nearby", ghostModeEnabled: false, shareArrivalStatus: true, shareSafeReturnStatus: false },
    locationState: { ...CEBU, updatedAt: FRESH, lat: 10.3157, lng: 123.8854 },
    checkInStatus: null, hasSafeReturnActive: false, hotelBlurEnabled: false,
    liveShare: null,
    ...over,
  };
}

describe("TR446 — the presence refusal's reason code reaches the card", () => {
  it("ghost mode: label location_hidden AND reason TRIP_PRESENCE_GHOST", () => {
    const card = buildCrewCard(member({ prefs: { defaultVisibility: "nearby", ghostModeEnabled: true, shareArrivalStatus: true, shareSafeReturnStatus: false } }), NOW);
    assert.equal(card.statusLabel, "location_hidden"); assert.equal(card.ghostMode, true);
    assert.equal(card.presenceReason, "TRIP_PRESENCE_GHOST");
    assert.equal(card.exactCoords, null);
  });
  it("hidden by default (no prefs row, no grant): label not_shared AND reason TRIP_PRESENCE_HIDDEN", () => {
    const card = buildCrewCard(member({ prefs: null as any }), NOW);
    assert.equal(card.statusLabel, "not_shared");
    assert.equal(card.presenceReason, "TRIP_PRESENCE_HIDDEN");
  });
  it("an active live-share grant: presence shown, reason null", () => {
    const card = buildCrewCard(member({ liveShare: { id: "s1", visibilityLevel: "nearby", expiresAt: new Date(NOW + 900_000).toISOString() } }), NOW);
    assert.equal(card.statusLabel, "live_sharing_active");
    assert.equal(card.presenceReason, null);
  });
  it("both codes are Appendix B's", () => {
    for (const c of ["TRIP_PRESENCE_GHOST", "TRIP_PRESENCE_HIDDEN"]) assert.ok((TRIP_REASON_CODES as readonly string[]).includes(c), c);
  });
});
