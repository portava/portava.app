/**
 * kAnonymity (Phase 0 item 6, math half) — the suppression threshold, tested
 * without a database. Pins that the module never invents k and fail-closes on
 * every invalid input.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { meetsKAnonymity, kAnonymize } from "../lib/kAnonymity.js";

describe("kAnonymity — meetsKAnonymity", () => {
  it("shows when distinct subjects meet or exceed k", () => {
    assert.equal(meetsKAnonymity(5, 5), true);
    assert.equal(meetsKAnonymity(6, 5), true);
  });
  it("suppresses below k", () => {
    assert.equal(meetsKAnonymity(4, 5), false);
    assert.equal(meetsKAnonymity(0, 1), false);
  });
  it("k = 1 boundary", () => {
    assert.equal(meetsKAnonymity(1, 1), true);
    assert.equal(meetsKAnonymity(0, 1), false);
  });
  it("fail-closed on a non-positive k (no valid threshold)", () => {
    assert.equal(meetsKAnonymity(5, 0), false);
    assert.equal(meetsKAnonymity(5, -3), false);
  });
  it("fail-closed on non-finite k or count", () => {
    assert.equal(meetsKAnonymity(5, NaN), false);
    assert.equal(meetsKAnonymity(5, Infinity), false);
    assert.equal(meetsKAnonymity(NaN, 5), false);
    assert.equal(meetsKAnonymity(-1, 5), false);
  });
});

describe("kAnonymity — kAnonymize", () => {
  it("returns the value when it meets k", () => {
    assert.equal(kAnonymize("busy", 8, 5), "busy");
  });
  it("returns the fallback (null default) when below k", () => {
    assert.equal(kAnonymize("busy", 3, 5), null);
  });
  it("honours a custom fallback", () => {
    assert.equal(kAnonymize("busy", 3, 5, "hidden"), "hidden");
  });
});
