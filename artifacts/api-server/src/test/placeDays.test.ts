import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  isEligiblePlaceDayPost,
  isValidLocalDate,
  localDateFor,
  resolvePlaceTimezone,
  shiftLocalDate,
  utcRangeForLocalDate,
  validIanaTimezone,
} from "../lib/places/placeDays.js";

describe("Place Days local-time foundation", () => {
  it("uses a resolved IANA timezone at a UTC midnight boundary", () => {
    const timezone = resolvePlaceTimezone({ city: "Cebu City", latitude: 10.3157, longitude: 123.8854 });
    assert.equal(timezone, "Asia/Manila");
    assert.equal(localDateFor(new Date("2026-08-02T17:30:00.000Z"), timezone), "2026-08-03");
  });

  it("falls back honestly to UTC for a place with no defensible timezone", () => {
    assert.equal(resolvePlaceTimezone({ city: null, latitude: null, longitude: null }), "UTC");
    assert.equal(validIanaTimezone("not/a-timezone"), null);
  });

  it("validates real calendar dates and uses calendar arithmetic across DST", () => {
    assert.equal(isValidLocalDate("2026-02-29"), false);
    assert.equal(isValidLocalDate("2028-02-29"), true);
    assert.equal(isValidLocalDate("2026-99-99"), false);
    assert.equal(shiftLocalDate("2026-03-09", -1), "2026-03-08");
    const range = utcRangeForLocalDate("2026-03-08", "America/Los_Angeles");
    assert.equal(range.start, "2026-03-08T08:00:00.000Z");
    assert.equal(range.end, "2026-03-09T07:00:00.000Z");
  });

  it("only materializes from published public active source activity", () => {
    assert.equal(isEligiblePlaceDayPost({ visibility: "public", status: "active", post_status: "published" }), true);
    assert.equal(isEligiblePlaceDayPost({ visibility: "private", status: "active", post_status: "published" }), false);
    assert.equal(isEligiblePlaceDayPost({ visibility: "public", status: "deleted", post_status: "published" }), false);
    assert.equal(isEligiblePlaceDayPost({ visibility: "public", status: "active", post_status: "pending_review" }), false);
    assert.equal(isEligiblePlaceDayPost({ visibility: "public", status: "active", post_status: "published", publish_at: "2099-01-01T00:00:00Z" }), false);
  });
});