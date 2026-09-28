/**
 * T29 — invisible mode suppresses Nearby / Bump / public availability WHILE
 * ALLOWING PRIVATE MAP USE.
 *
 * The row has two halves and the second is the one a build gets wrong: a switch
 * that turns everything off satisfies the first clause and breaks the feature.
 * So both halves are asserted here, and the second is asserted as a TYPE as well
 * (`permitsPrivateMapUse` returns the literal `true`, so suppressing the private
 * map cannot compile).
 *
 * T22 is also protected here: AVAILABLE / ONLINE / NEARBY / SHARING LOCATION are
 * four separate permissions and must never collapse into one, so invisible mode
 * must NOT be derived from `show_online_status`.
 *
 * Run: node --import tsx/esm --test src/test/invisibleMode.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  INVISIBLE_PERMITTED_SURFACES,
  INVISIBLE_SUPPRESSED_SURFACES,
  VISIBLE,
  invisibleModeTelemetry,
  isPrivateSurface,
  permitsPrivateMapUse,
  resolveInvisibleMode,
  suppressesSurface,
} from "../lib/invisibleMode.js";

const DB_ERROR = { message: "connection terminated unexpectedly", code: "57P01" };

describe("resolving invisible mode from stored location consent", () => {
  it("a person with ordinary preferences is visible", () => {
    const state = resolveInvisibleMode({
      prefs: { location_mode: "city_only", sharing_paused: false, discovery_visibility: "everyone" },
      prefsError: null,
    });
    assert.equal(state.invisible, false);
    assert.deepEqual(state.reasons, []);
    assert.equal(state.degraded, false);
  });

  it("location_mode off, sharing paused and discovery 'nobody' each engage it", () => {
    for (const prefs of [
      { location_mode: "off" },
      { sharing_paused: true },
      { discovery_visibility: "nobody" },
      { discovery_visibility: "no_location" },
    ]) {
      const state = resolveInvisibleMode({ prefs, prefsError: null });
      assert.equal(state.invisible, true, JSON.stringify(prefs));
      assert.ok(state.reasons.length > 0);
      assert.equal(state.degraded, false, "a stored choice is not a degraded read");
    }
  });

  it("every applicable reason is reported, not just the first", () => {
    const state = resolveInvisibleMode({
      prefs: { location_mode: "off", sharing_paused: true, discovery_visibility: "nobody" },
      prefsError: null,
    });
    assert.deepEqual([...state.reasons].sort(), [
      "discovery_visibility_nobody",
      "location_mode_off",
      "sharing_paused",
    ]);
  });

  it("AN UNREADABLE PREFERENCES ROW ENGAGES INVISIBILITY — absent consent fails closed", () => {
    const state = resolveInvisibleMode({ prefs: null, prefsError: DB_ERROR });
    assert.equal(state.invisible, true);
    assert.deepEqual([...state.reasons], ["prefs_unreadable"]);
    assert.equal(state.degraded, true, "the caller must be able to avoid asserting a choice nobody made");
  });

  it("an error wins even when the row that came back looks permissive", () => {
    // supabase-js RESOLVES a failure, so a caller can hold BOTH a stale-looking
    // row and an error. The error decides.
    const state = resolveInvisibleMode({
      prefs: { location_mode: "nearby", sharing_paused: false, discovery_visibility: "everyone" },
      prefsError: DB_ERROR,
    });
    assert.equal(state.invisible, true);
  });

  it("an ABSENT row is the product default (visible), which is not the same as an unreadable one", () => {
    assert.equal(resolveInvisibleMode({ prefs: null, prefsError: null }).invisible, false);
    assert.equal(resolveInvisibleMode({ prefs: undefined, prefsError: null }).invisible, false);
  });

  it("invisible mode is NOT derived from show_online_status (T22: ONLINE is a separate permission)", () => {
    // The input type has no field for it, and a row carrying one changes nothing.
    const state = resolveInvisibleMode({
      prefs: { location_mode: "city_only", show_online_status: false } as never,
      prefsError: null,
    });
    assert.equal(
      state.invisible,
      false,
      "deriving NEARBY from ONLINE would collapse two of §4.1's four permissions into one",
    );
  });
});

describe("the first half: outbound surfaces are suppressed", () => {
  const invisible = resolveInvisibleMode({ prefs: { sharing_paused: true }, prefsError: null });

  it("nearby, bump and public availability are all suppressed", () => {
    for (const surface of INVISIBLE_SUPPRESSED_SURFACES) {
      assert.equal(suppressesSurface(invisible, surface), true, surface);
      assert.equal(suppressesSurface(VISIBLE, surface), false, surface);
    }
  });

  it("a surface this module has not been taught about is treated as outbound", () => {
    assert.equal(suppressesSurface(invisible, "some_future_people_feed"), true);
    assert.equal(suppressesSurface(VISIBLE, "some_future_people_feed"), false);
  });

  it("inherited object keys do not answer — the surface tables are Sets", () => {
    assert.equal(suppressesSurface(invisible, "constructor"), true, "unknown → outbound → suppressed");
    assert.equal(isPrivateSurface("constructor"), false);
    assert.equal(isPrivateSurface("toString"), false);
    assert.equal(isPrivateSurface("__proto__"), false);
  });
});

describe("the second half: private map use survives", () => {
  const invisible = resolveInvisibleMode({ prefs: { location_mode: "off" }, prefsError: null });

  it("the private surfaces are NOT suppressed while invisible", () => {
    for (const surface of INVISIBLE_PERMITTED_SURFACES) {
      assert.equal(
        suppressesSurface(invisible, surface),
        false,
        `${surface} must keep working — a build that switches everything off satisfies half the row and breaks a feature`,
      );
    }
  });

  it("permitsPrivateMapUse is true for every state, including the degraded one", () => {
    const degraded = resolveInvisibleMode({ prefs: null, prefsError: DB_ERROR });
    assert.equal(permitsPrivateMapUse(invisible), true);
    assert.equal(permitsPrivateMapUse(degraded), true);
    assert.equal(permitsPrivateMapUse(VISIBLE), true);
  });

  it("the suppressed and permitted sets are disjoint", () => {
    const suppressed = new Set<string>(INVISIBLE_SUPPRESSED_SURFACES);
    for (const s of INVISIBLE_PERMITTED_SURFACES) {
      assert.equal(suppressed.has(s), false, `${s} cannot be both`);
    }
  });
});

describe("telemetry carries no position", () => {
  it("the summary is booleans and reason names only", () => {
    const state = resolveInvisibleMode({ prefs: { sharing_paused: true }, prefsError: null });
    const t = invisibleModeTelemetry(state);
    assert.deepEqual(Object.keys(t).sort(), ["degraded", "invisible", "reasons"]);
    const serialised = JSON.stringify(t);
    assert.equal(/lat|lng|coord|\d+\.\d{3,}/.test(serialised), false, serialised);
  });
});
