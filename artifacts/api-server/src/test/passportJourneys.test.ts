/**
 * Passport Journeys projection (§14, TABLE 26).
 *
 * Verifies:
 *   • trips project into a year → country → city → Trip grouping;
 *   • memories and stamps attach to their Trip;
 *   • a single Featured Journey is derived (richest trip), never stored;
 *   • trip visibility is honoured per viewer (private hidden from non-friends,
 *     buddies visible to a full-profile viewer, owner sees all);
 *   • exact dates are coarsened when show_exact_dates is false for non-owners.
 *
 * Run: node --import tsx/esm --test src/test/passportJourneys.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildJourneys, buildFeaturedJourney } from "../services/passport/PassportJourneyService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const OWNER = "owner-1";
const T_VN = "trip-vn";
const T_TH = "trip-th";
const T_PRIV = "trip-priv";

function db() {
  return makePassportDb({
    trip_members: [
      { trip_id: T_VN, user_id: OWNER, role: "owner" },
      { trip_id: T_TH, user_id: OWNER, role: "member" },
      { trip_id: T_PRIV, user_id: OWNER, role: "owner" },
    ],
    trips: [
      { id: T_VN, owner_id: OWNER, title: "30 Days in Vietnam", destination_city: "Da Nang", destination_country: "Vietnam", start_date: "2025-03-01", end_date: "2025-03-30", status: "completed", visibility: "public", show_on_profile: true, show_exact_dates: true },
      { id: T_TH, owner_id: "someone", title: "Bangkok Weekend", destination_city: "Bangkok", destination_country: "Thailand", start_date: "2024-11-10", end_date: "2024-11-12", status: "completed", visibility: "public", show_on_profile: true, show_exact_dates: false },
      { id: T_PRIV, owner_id: OWNER, title: "Secret Trip", destination_city: "Hoi An", destination_country: "Vietnam", start_date: "2025-01-01", end_date: "2025-01-05", status: "completed", visibility: "private", show_on_profile: true, show_exact_dates: true },
    ],
    passport_memories: [
      { id: "m1", user_id: OWNER, status: "active", title: "Beach day", city: "Da Nang", country: "Vietnam", trip_id: T_VN, visibility: "public", earned_at: "2025-03-05" },
      { id: "m2", user_id: OWNER, status: "active", title: "Old town", city: "Da Nang", country: "Vietnam", trip_id: T_VN, visibility: "public", earned_at: "2025-03-06" },
    ],
    user_stamps: [
      { user_id: OWNER, source_type: "trips", source_id: T_VN, city: "Da Nang", country: "Vietnam", is_revoked: false, earned_at: "2025-03-30", stamp_definitions: { name: "Vietnam" } },
    ],
  });
}

describe("buildJourneys", () => {
  it("groups the owner's trips by year → country → city and attaches memories/stamps", async () => {
    const r = await buildJourneys(db(), OWNER, { isSelf: true, canSeeTrips: true, canSeeRestricted: true });
    assert.equal(r.totalJourneys, 3);
    // Years present: 2025 (VN + priv) and 2024 (TH), newest first.
    assert.equal(r.years[0].year, 2025);
    const vnYear = r.years.find((y) => y.year === 2025)!;
    const vietnam = vnYear.countries.find((c) => c.country === "Vietnam")!;
    const daNang = vietnam.cities.find((c) => c.city === "Da Nang")!;
    const vn = daNang.journeys.find((j) => j.tripId === T_VN)!;
    assert.equal(vn.memoryCount, 2);
    assert.equal(vn.stampCount, 1);
    assert.equal(vn.durationLabel, "30 days");
  });

  it("derives a single Featured Journey (the richest trip)", async () => {
    const featured = await buildFeaturedJourney(db(), OWNER, { isSelf: true, canSeeTrips: true, canSeeRestricted: true });
    assert.ok(featured);
    assert.equal(featured!.tripId, T_VN); // most memories + stamps + longest
    assert.equal(featured!.featured, true);

    const r = await buildJourneys(db(), OWNER, { isSelf: true, canSeeTrips: true, canSeeRestricted: true });
    assert.ok(r.featured);
    assert.equal(r.featured!.tripId, T_VN);
    // The same trip is flagged featured inside the grouped list.
    const flagged = r.years.flatMap((y) => y.countries).flatMap((c) => c.cities).flatMap((c) => c.journeys).filter((j) => j.featured);
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].tripId, T_VN);
  });

  it("hides a private trip from a non-friend public viewer, keeps public ones", async () => {
    const r = await buildJourneys(db(), OWNER, { isSelf: false, canSeeTrips: true, canSeeRestricted: false });
    const ids = r.years.flatMap((y) => y.countries).flatMap((c) => c.cities).flatMap((c) => c.journeys).map((j) => j.tripId);
    assert.ok(ids.includes(T_VN));
    assert.ok(ids.includes(T_TH));
    assert.ok(!ids.includes(T_PRIV), "private trip must not appear to a public viewer");
  });

  it("coarsens exact dates for non-owners when show_exact_dates is false", async () => {
    const r = await buildJourneys(db(), OWNER, { isSelf: false, canSeeTrips: true, canSeeRestricted: false });
    const th = r.years.flatMap((y) => y.countries).flatMap((c) => c.cities).flatMap((c) => c.journeys).find((j) => j.tripId === T_TH)!;
    assert.equal(th.startDate, null, "exact start date hidden");
    assert.equal(th.endDate, null, "exact end date hidden");
    assert.equal(th.durationLabel, null);
  });

  it("returns empty for a non-owner who cannot see trips", async () => {
    const r = await buildJourneys(db(), OWNER, { isSelf: false, canSeeTrips: false, canSeeRestricted: false });
    assert.equal(r.totalJourneys, 0);
    assert.equal(r.featured, null);
  });
});
