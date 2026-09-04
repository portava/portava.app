/**
 * mapTelemetry — the ingest route's privacy backstop (Map spec §35, §23, §24).
 *
 * The client scrubber is the first line of defence and it is thorough. These
 * tests cover the SECOND line, which exists precisely because the first one
 * runs on a device we do not control: an old build, a modified build, or a
 * replayed request can all present a payload the scrubber never saw.
 *
 * A telemetry store is the worst place for raw location to accumulate — it does
 * so silently, forever, and nobody notices until it is a breach. So the server
 * re-checks rather than trusts, and these tests pin that it actually does.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DISALLOWED_KEY_FRAGMENTS,
  MAP_EVENT_NAMES,
  containsDisallowedKey,
  stripActorKeys,
} from "../routes/mapTelemetry.js";

describe("the §35 event set", () => {
  test("carries §35s sixteen events, plus only deliberate additions", () => {
    // §35 names sixteen. `meet_here_refused` is a SEVENTEENTH, added
    // deliberately (migration 2222): §35 has no event for something the product
    // refused to do, so a §23 policy block was indistinguishable from a feature
    // nobody used. Keeping the spec list separate means it stays a faithful
    // quote and any further addition is a deliberate edit here.
    const SPEC_35 = [
      "alternative_requested",
      "compass_option_selected",
      "compass_requested",
      "contribution_submitted",
      "crew_locate_started",
      "live_state_viewed",
      "map_opened",
      "meet_here_created",
      "place_opened",
      "plan_joined",
      "recommendation_accepted",
      "recommendation_declined",
      "route_started",
      "trip_stop_added",
      "why_shown_opened",
      "zone_selected",
    ];
    const BEYOND_SPEC = ["meet_here_refused"];

    for (const name of SPEC_35) {
      assert.ok(
        (MAP_EVENT_NAMES as readonly string[]).includes(name),
        `§35 event missing from the server allowlist: ${name}`,
      );
    }
    assert.deepEqual(
      [...MAP_EVENT_NAMES].sort(),
      [...SPEC_35, ...BEYOND_SPEC].sort(),
      "the server event allowlist drifted — an event the client can emit but the server drops is a silent data loss",
    );
    assert.equal(MAP_EVENT_NAMES.length, SPEC_35.length + BEYOND_SPEC.length);
  });

  test("has no duplicates", () => {
    assert.equal(new Set(MAP_EVENT_NAMES).size, MAP_EVENT_NAMES.length);
  });
});

describe("containsDisallowedKey — position", () => {
  test("catches a raw coordinate pair at the top level", () => {
    assert.equal(containsDisallowedKey({ lat: 16.05, lng: 108.2 }), true);
    assert.equal(containsDisallowedKey({ latitude: 1, longitude: 2 }), true);
  });

  test("catches a coordinate NESTED inside an innocent-looking object", () => {
    assert.equal(
      containsDisallowedKey({ ref: { kind: "place", coordinates: [1, 2] } }),
      true,
    );
    assert.equal(
      containsDisallowedKey({ a: { b: { c: { lat: 1 } } } }),
      true,
    );
  });

  test("catches a coordinate hidden inside an ARRAY element", () => {
    // The obvious bypass: bury it one array deep and hope the walk only
    // recurses through objects.
    assert.equal(containsDisallowedKey({ options: [{ ok: 1 }, { lng: 2 }] }), true);
    assert.equal(containsDisallowedKey({ deep: [[{ geometry: {} }]] }), true);
  });

  test("catches geometry, geohash, bbox and street-level address keys", () => {
    for (const key of ["geometry", "geohash", "bbox", "street", "postcode", "address", "accuracy", "altitude"]) {
      assert.equal(containsDisallowedKey({ [key]: "x" }), true, `${key} must be rejected`);
    }
  });

  test("matching is case-insensitive", () => {
    assert.equal(containsDisallowedKey({ LAT: 1 }), true);
    assert.equal(containsDisallowedKey({ GeoHash: "x" }), true);
    assert.equal(containsDisallowedKey({ Display_Name: "x" }), true);
  });
});

describe("containsDisallowedKey — identity", () => {
  test("catches third-party identifiers", () => {
    for (const key of [
      "user_id", "contributor", "author", "owner", "profile_id", "creator",
      "host_id", "invitee_id", "actor", "account_id", "handle", "email",
      "phone", "avatar", "display_name", "username", "device_id", "push_token",
    ]) {
      assert.equal(containsDisallowedKey({ [key]: "x" }), true, `${key} must be rejected`);
    }
  });

  test("every declared fragment is actually enforced", () => {
    // Guards against a fragment being added to the list but the matcher
    // drifting so it no longer applies.
    for (const frag of DISALLOWED_KEY_FRAGMENTS) {
      assert.equal(
        containsDisallowedKey({ [`x_${frag}_y`]: 1 }),
        true,
        `declared fragment "${frag}" is not enforced`,
      );
    }
  });
});

describe("containsDisallowedKey — what it must NOT reject", () => {
  test("a well-formed scrubbed payload passes", () => {
    assert.equal(
      containsDisallowedKey({
        ref: {
          kind: "hidden_gem",
          privacyClass: "approximate",
          confidence: "live",
          freshness: "recent",
          cell: "w7s3x",
          cellPrecision: 5,
        },
        source: "carousel",
        rank: 3,
      }),
      false,
    );
  });

  test("primitives and empty objects pass", () => {
    assert.equal(containsDisallowedKey({}), false);
    assert.equal(containsDisallowedKey(null), false);
    assert.equal(containsDisallowedKey("a string"), false);
    assert.equal(containsDisallowedKey(42), false);
    assert.equal(containsDisallowedKey([]), false);
  });
});

describe("containsDisallowedKey — fails closed", () => {
  test("a payload nested beyond the inspection depth is REFUSED, not accepted", () => {
    // If the walk cannot verify the whole structure, the safe answer is
    // "assume it is dirty". Accepting the unverifiable is how coordinates end
    // up in a store nobody audits.
    let deep: Record<string, unknown> = { safe: 1 };
    for (let i = 0; i < 12; i += 1) deep = { nested: deep };
    assert.equal(containsDisallowedKey(deep), true);
  });

  test("a shallow payload is not falsely refused by the depth guard", () => {
    assert.equal(containsDisallowedKey({ a: { b: { c: { d: 1 } } } }), false);
  });
});

describe("stripActorKeys — the actor is stamped, never accepted", () => {
  test("removes every spelling of a client-supplied actor", () => {
    const out = stripActorKeys({
      viewer_id: "spoofed",
      viewerId: "spoofed",
      user_id: "spoofed",
      userId: "spoofed",
      actor: "spoofed",
      source: "rail",
    });
    assert.deepEqual(out, { source: "rail" });
  });

  test("leaves an ordinary payload untouched", () => {
    const payload = { source: "rail", rank: 2, ref: { kind: "place" } };
    assert.deepEqual(stripActorKeys(payload), payload);
  });

  test("returns a NEW object — the caller's payload is not mutated", () => {
    const payload = { viewer_id: "x", keep: 1 };
    const out = stripActorKeys(payload);
    assert.notEqual(out, payload);
    assert.equal((payload as any).viewer_id, "x", "input must not be mutated");
  });

  test("an actor key that survived stripping would still be caught downstream", () => {
    // Belt and braces: stripActorKeys handles the top level, and the identity
    // fragments in containsDisallowedKey catch anything nested.
    assert.equal(containsDisallowedKey({ ref: { user_id: "x" } }), true);
  });
});
