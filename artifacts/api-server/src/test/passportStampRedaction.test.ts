/**
 * PassportPrivacyGuard.guardStamp — the per-stamp REDACTION rules.
 *
 * `filterStamps`'s visibility filter had a test; the redaction branches inside
 * `guardStamp` had none, and two of them were unreachable until migration 2309:
 * `passport_stamps_stamp_type_check` rejected both 'safe_return' and
 * 'hidden_gem', so no row could ever carry a stamp_type that triggers them.
 * They read as live privacy gates and were dead code.
 *
 * These are location-disclosure rules, so each is written the way the lane
 * requires: prove the GATE is what removes the field, with a positive control
 * showing the same fixture keeps the field when only the gated condition
 * changes. A `null` proves nothing unless the non-null case is demonstrated on
 * the same row.
 *
 * Every fixture sets `visibility` explicitly. A StampRow without it fails
 * `isVisible` and is dropped whole — every assertion below would then pass
 * against an empty array.
 *
 * MUTATION PROOFS (each performed, each RED): delete any one of the three
 * redaction branches in guardStamp (safe_return neighbourhood suppression,
 * hotel blur, sensitive-type place_id strip).
 *
 * Run: node --import tsx/esm --test src/test/passportStampRedaction.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  guardStamp,
  filterStamps,
  isVisible,
  isVisibleV2,
  type StampRow,
} from "../services/passport/PassportPrivacyGuard.js";

function row(over: Partial<StampRow> = {}): StampRow {
  return {
    id: "s-1",
    stamp_type: "city",
    country: "Vietnam",
    city: "Da Nang",
    neighborhood: "An Thuong",
    place_id: "place-abc",
    plan_id: null,
    trip_id: null,
    source_type: "gps_pipeline",
    verification_level: "gps",
    visibility: "public",
    earned_at: "2026-03-01T00:00:00Z",
    created_at: "2026-03-01T00:00:00Z",
    ...over,
  } as StampRow;
}

describe("guardStamp — Safe Return redaction", () => {
  it("strips neighbourhood and place_id from a safe_return stamp for a public caller", () => {
    const s = row({ stamp_type: "safe_return", source_type: "safe_return_confirm" });
    const out = guardStamp(s, "public")!;
    assert.ok(out, "a public-visibility safe_return stamp is still returned, just redacted");
    assert.equal(out.neighborhood, null, "a Safe Return neighbourhood says where someone slept");
    assert.equal(out.place_id, null);

    // POSITIVE CONTROL — the SAME row, owner context: both fields survive, so
    // the nulls above are the redaction branch and not an empty fixture.
    const own = guardStamp(s, "owner")!;
    assert.equal(own.neighborhood, "An Thuong", "control failed: the fixture never carried a neighbourhood");
    assert.equal(own.place_id, "place-abc", "control failed: the fixture never carried a place_id");
  });

  it("the redaction is keyed on stamp_type, not on the caller alone", () => {
    // Same public caller, same everything — only stamp_type differs.
    const ordinary = guardStamp(row({ stamp_type: "city" }), "public")!;
    assert.equal(ordinary.neighborhood, "An Thuong", "an ordinary city stamp keeps its neighbourhood");
    const safe = guardStamp(row({ stamp_type: "safe_return" }), "public")!;
    assert.equal(safe.neighborhood, null);
  });
});

describe("guardStamp — sensitive place_id strip", () => {
  it("removes place_id from a hidden_gem stamp for a public caller but keeps the city", () => {
    const s = row({ stamp_type: "hidden_gem" });
    const out = guardStamp(s, "public")!;
    assert.equal(out.place_id, null, "the exact gem is not public");
    assert.equal(out.city, "Da Nang", "the coarse city still is");
    assert.equal(out.neighborhood, "An Thuong", "only place_id is stripped for a hidden_gem");

    // POSITIVE CONTROL on the same row.
    assert.equal(guardStamp(s, "owner")!.place_id, "place-abc", "control failed: fixture had no place_id");
  });

  it("keeps place_id for a circle caller — the strip is scoped to 'public'", () => {
    const s = row({ stamp_type: "hidden_gem" });
    assert.equal(guardStamp(s, "circle")!.place_id, "place-abc");
    assert.equal(guardStamp(s, "public")!.place_id, null);
  });
});

describe("guardStamp — hotel blur", () => {
  it("blurs a hotel-sourced stamp when the owner's preference is on — for the owner too", () => {
    const s = row({ source_type: "hotel" });
    const blurred = guardStamp(s, "owner", { hotelBlurEnabled: true })!;
    assert.equal(blurred.neighborhood, null);
    assert.equal(blurred.place_id, null);

    // POSITIVE CONTROL: the same row with the preference OFF keeps both.
    const clear = guardStamp(s, "owner", { hotelBlurEnabled: false })!;
    assert.equal(clear.neighborhood, "An Thuong", "control failed: the preference is not what blurred it");
    assert.equal(clear.place_id, "place-abc");
  });

  it("only blurs the accommodation-shaped source types", () => {
    for (const sourceType of ["hotel", "private_stay", "home", "accommodation"]) {
      assert.equal(guardStamp(row({ source_type: sourceType }), "owner", { hotelBlurEnabled: true })!.neighborhood, null, sourceType);
    }
    assert.equal(
      guardStamp(row({ source_type: "gps_pipeline" }), "owner", { hotelBlurEnabled: true })!.neighborhood,
      "An Thuong",
      "an ordinary GPS stamp is not accommodation and is not blurred",
    );
  });
});

describe("visibility tiers", () => {
  it("v1 tiers: owner sees all; public sees only public; circle/trip_crew see their own tier", () => {
    assert.equal(isVisible("private", "owner"), true);
    assert.equal(isVisible("private", "public"), false);
    assert.equal(isVisible("circle_only", "circle"), true);
    assert.equal(isVisible("circle_only", "trip_crew"), false);
    assert.equal(isVisible("trip_crew", "trip_crew"), true);
    assert.equal(isVisible("trip_crew", "circle"), false);
  });

  it("v2 tiers: friends_only is visible to circle AND trip_crew", () => {
    assert.equal(isVisibleV2("friends_only", "circle"), true);
    assert.equal(isVisibleV2("friends_only", "trip_crew"), true);
    assert.equal(isVisibleV2("friends_only", "public"), false);
    assert.equal(isVisibleV2("private", "circle"), false);
  });

  it("filterStamps drops a hidden stamp entirely rather than redacting it", () => {
    const rows = [row({ id: "pub", visibility: "public" }), row({ id: "priv", visibility: "private" })];
    assert.deepEqual(filterStamps(rows, "public").map((s) => s.id), ["pub"]);
    // POSITIVE CONTROL: both are present for the owner.
    assert.deepEqual(filterStamps(rows, "owner").map((s) => s.id), ["pub", "priv"]);
  });
});
