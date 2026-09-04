/**
 * §4 Table-6 value validators — the full Phase-1 registry, and the honest line
 * between "has a validator" and "is capturable on the quick_signal surface".
 *
 * WHAT THIS FILE PINS
 * ===================
 *   1. Every §4 registry claim type has a VALUE_VALIDATORS entry, and each
 *      accepts exactly its Table-5/6 value space and refuses everything else.
 *   2. VALUE_VALIDATORS is a strict SUPERSET of PHASE1_CAPTURE_CLAIM_TYPES: a
 *      claim can be validated without being storable on the quick_signal
 *      surface (the decoupling this unit introduced).
 *   3. The surface list stays honest to §29 Included and to #361's
 *      surface-isolation invariant: experience.next_move (trail-only) and the
 *      not-yet-producible families are NOT on the quick_signal surface, even
 *      though they validate.
 *   4. Every claim type storable on the surface has a validator AND a TTL — so
 *      nothing capturable is unvalidated or un-expiring.
 *
 * Pure — no client, no server, no clock.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CLAIM_TYPES,
  CROWD_MIX_CATEGORIES,
  INVENTORY_STATUSES,
  MUSIC_GENRES,
  RESERVATION_STATES,
  TRANSIT_CONDITIONS,
} from "../lib/intelContracts.js";
import {
  PHASE1_CAPTURE_CLAIM_TYPES,
  VALUE_VALIDATORS,
  validateClaimValue,
  MUSIC_GENRE_OPTIONS,
} from "../lib/quickSignal.js";
import { validateTrailClaimValue } from "../lib/trailFollowup.js";

/** The nine families this unit added validators for (§4 Table 6). */
const ADDED = [
  "access.reservation",
  "access.dress",
  "price.cover",
  "crowd.mix",
  "music.current",
  "inventory.status",
  "service.wait",
  "transit.condition",
  "experience.next_move",
] as const;

describe("§4 Table-6 value validators", () => {
  it("every registered claim type has a validator", () => {
    for (const c of CLAIM_TYPES) {
      assert.equal(typeof VALUE_VALIDATORS[c.claimType], "function", `${c.claimType} has no validator`);
    }
  });

  it("added all nine remaining Phase-1 registry validators", () => {
    for (const c of ADDED) {
      assert.equal(typeof VALUE_VALIDATORS[c], "function", `${c} validator missing`);
    }
  });

  it("access.reservation accepts exactly RESERVATION_STATES", () => {
    for (const s of RESERVATION_STATES) {
      assert.ok(validateClaimValue("access.reservation", { reservation: s }), `should accept ${s}`);
    }
    assert.equal(validateClaimValue("access.reservation", { reservation: "maybe" }), false);
    assert.equal(validateClaimValue("access.reservation", {}), false);
    assert.equal(validateClaimValue("access.reservation", { reservation: 1 }), false);
  });

  it("access.dress requires a bounded policy, an enforced boolean, optional bounded qualifiers", () => {
    assert.ok(validateClaimValue("access.dress", { policy: "smart casual", enforced: true }));
    assert.ok(validateClaimValue("access.dress", { policy: "formal", enforced: false, qualifiers: ["no sportswear"] }));
    assert.equal(validateClaimValue("access.dress", { policy: "", enforced: true }), false, "empty policy");
    assert.equal(validateClaimValue("access.dress", { policy: "x", enforced: "yes" }), false, "enforced must be boolean");
    assert.equal(validateClaimValue("access.dress", { policy: "x", enforced: true, qualifiers: [1] }), false, "qualifier must be string");
    assert.equal(validateClaimValue("access.dress", { policy: "a".repeat(61), enforced: true }), false, "policy too long");
  });

  it("price.cover requires amount≥0, an ISO-4217-shaped currency, and an access type", () => {
    assert.ok(validateClaimValue("price.cover", { amount: 20, currency: "USD", accessType: "general" }));
    assert.ok(validateClaimValue("price.cover", { amount: 0, currency: "THB", accessType: "vip" }));
    assert.equal(validateClaimValue("price.cover", { amount: -1, currency: "USD", accessType: "general" }), false);
    assert.equal(validateClaimValue("price.cover", { amount: 20, currency: "usd", accessType: "general" }), false, "currency case");
    assert.equal(validateClaimValue("price.cover", { amount: 20, currency: "US", accessType: "general" }), false, "currency length");
    assert.equal(validateClaimValue("price.cover", { amount: 20, currency: "USD", accessType: "" }), false, "access type required");
  });

  it("crowd.mix accepts exactly CROWD_MIX_CATEGORIES (dominant composition, no identity inference)", () => {
    for (const m of CROWD_MIX_CATEGORIES) {
      assert.ok(validateClaimValue("crowd.mix", { mix: m }), `should accept ${m}`);
    }
    assert.equal(validateClaimValue("crowd.mix", { mix: "tourists" }), false);
    // No per-person distribution field is required or accepted as the value shape.
    assert.equal(validateClaimValue("crowd.mix", { local: 0.5, traveler: 0.5 }), false);
  });

  it("music.current accepts the controlled genre set + optional confidence, never a track/artist", () => {
    for (const g of MUSIC_GENRES) {
      assert.ok(validateClaimValue("music.current", { genre: g }), `should accept ${g}`);
    }
    assert.ok(validateClaimValue("music.current", { genre: "house", confidence: 0.8 }));
    assert.equal(validateClaimValue("music.current", { genre: "dubstep" }), false, "off-vocabulary genre");
    assert.equal(validateClaimValue("music.current", { genre: "house", confidence: 1.5 }), false, "confidence out of range");
    // The value shape has NO track/artist/lyric field — the exported vocabulary
    // the composer offers is genres only (copyright-safe metadata, Table 6).
    assert.deepEqual([...MUSIC_GENRE_OPTIONS], [...MUSIC_GENRES]);
  });

  it("inventory.status requires an item and a controlled status", () => {
    for (const s of INVENTORY_STATUSES) {
      assert.ok(validateClaimValue("inventory.status", { item: "house lager", status: s }), `should accept ${s}`);
    }
    assert.equal(validateClaimValue("inventory.status", { item: "", status: "available" }), false);
    assert.equal(validateClaimValue("inventory.status", { item: "x", status: "gone" }), false);
  });

  it("service.wait requires a service type and the min/max minute contract", () => {
    assert.ok(validateClaimValue("service.wait", { serviceType: "table", minMinutes: 10, maxMinutes: 20 }));
    assert.ok(validateClaimValue("service.wait", { serviceType: "kitchen", minMinutes: 30, maxMinutes: null }));
    assert.equal(validateClaimValue("service.wait", { serviceType: "", minMinutes: 0, maxMinutes: null }), false);
    assert.equal(validateClaimValue("service.wait", { serviceType: "table", minMinutes: 20, maxMinutes: 10 }), false, "max<min");
    assert.equal(validateClaimValue("service.wait", { serviceType: "table", minMinutes: -1, maxMinutes: null }), false);
  });

  it("transit.condition requires a route/mode and a controlled condition", () => {
    for (const c of TRANSIT_CONDITIONS) {
      assert.ok(validateClaimValue("transit.condition", { routeOrMode: "Line 1", condition: c }), `should accept ${c}`);
    }
    assert.equal(validateClaimValue("transit.condition", { routeOrMode: "", condition: "normal" }), false);
    assert.equal(validateClaimValue("transit.condition", { routeOrMode: "Line 1", condition: "late" }), false);
  });

  it("experience.next_move delegates to the trail validator (ONE value space)", () => {
    const good = { destinationArea: "Shoreditch" };
    const bad = { destinationArea: "" };
    assert.equal(validateClaimValue("experience.next_move", good), validateTrailClaimValue("experience.next_move", good));
    assert.equal(validateClaimValue("experience.next_move", bad), validateTrailClaimValue("experience.next_move", bad));
    assert.ok(validateClaimValue("experience.next_move", good));
    assert.equal(validateClaimValue("experience.next_move", bad), false);
  });
});

describe("capture surface vs validation registry — the decoupling", () => {
  it("PHASE1_CAPTURE_CLAIM_TYPES is a strict subset of VALUE_VALIDATORS", () => {
    for (const c of PHASE1_CAPTURE_CLAIM_TYPES) {
      assert.equal(typeof VALUE_VALIDATORS[c], "function", `surface type ${c} has no validator`);
    }
    const validatorKeys = new Set(Object.keys(VALUE_VALIDATORS));
    assert.ok(
      PHASE1_CAPTURE_CLAIM_TYPES.length < validatorKeys.size,
      "the surface list must be strictly smaller than the validation registry",
    );
  });

  it("every surface-storable claim type also has a TTL (nothing capturable is un-expiring)", () => {
    for (const c of PHASE1_CAPTURE_CLAIM_TYPES) {
      assert.ok(CLAIM_TYPES.some((x) => x.claimType === c), `${c} is storable but has no TTL row`);
    }
  });

  it("§29 Included: music.current is capturable on the quick_signal surface", () => {
    assert.ok(PHASE1_CAPTURE_CLAIM_TYPES.includes("music.current"));
  });

  it("surface-isolation invariant: experience.next_move validates but is NOT on quick_signal", () => {
    assert.equal(typeof VALUE_VALIDATORS["experience.next_move"], "function");
    assert.equal(PHASE1_CAPTURE_CLAIM_TYPES.includes("experience.next_move"), false);
  });

  it("held-off families validate but are not capturable on quick_signal yet", () => {
    for (const c of ["access.reservation", "access.dress", "price.cover", "crowd.mix", "service.wait", "inventory.status", "transit.condition"]) {
      assert.equal(typeof VALUE_VALIDATORS[c], "function", `${c} should validate`);
      assert.equal(PHASE1_CAPTURE_CLAIM_TYPES.includes(c), false, `${c} must not be on the quick_signal surface yet`);
    }
  });

  it("the pre-existing surface types are all still present (no regression)", () => {
    for (const c of ["crowd.level", "crowd.trajectory", "queue.wait", "access.walk_in", "vibe.state", "event.status", "closure.state", "crowd.direction"]) {
      assert.ok(PHASE1_CAPTURE_CLAIM_TYPES.includes(c), `${c} dropped from the surface`);
    }
  });
});
