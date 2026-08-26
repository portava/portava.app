/**
 * intelGroupKey (V1 independent-group signal) — proves the key that feeds the
 * privacy gate has exactly the properties the leak-prevention depends on: a crew
 * collapses to ONE shared key, a solo observer gets its OWN per-actor key, an
 * unknown identity gets NO key, keys are stable within a subject but unlinkable
 * across subjects, and it fails closed without the server secret.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { deriveGroupKey } from "../lib/intelGroupKey.js";

const SUBJECT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SUBJECT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const HEX64 = /^[0-9a-f]{64}$/;

describe("intelGroupKey.deriveGroupKey", () => {
  const prev = process.env.SESSION_SECRET;
  before(() => { process.env.SESSION_SECRET = "test-session-secret-please-ignore-0123456789"; });
  after(() => { if (prev === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prev; });

  it("unknown identity (non-crew 'with others' / pre-signal) → null, never a group", () => {
    assert.equal(deriveGroupKey(SUBJECT_A, null), null);
  });

  it("a crew token is SHARED across members — 15 people from one crew collapse to one key", () => {
    const keys = new Set(
      Array.from({ length: 15 }, (_, i) =>
        deriveGroupKey(SUBJECT_A, { kind: "crew", crewId: "trip-1" }),
      ),
    );
    assert.equal(keys.size, 1, "one crew → one group_key regardless of how many members report");
    assert.match([...keys][0]!, HEX64);
  });

  it("solo keys are PER-ACTOR — distinct actors are distinct groups, one actor is one group", () => {
    const a1 = deriveGroupKey(SUBJECT_A, { kind: "solo", actorId: "actor-1" });
    const a1again = deriveGroupKey(SUBJECT_A, { kind: "solo", actorId: "actor-1" });
    const a2 = deriveGroupKey(SUBJECT_A, { kind: "solo", actorId: "actor-2" });
    assert.equal(a1, a1again, "same actor at same subject → stable key");
    assert.notEqual(a1, a2, "different solo actors → different groups");
  });

  it("a crew and a solo actor never collide", () => {
    const crew = deriveGroupKey(SUBJECT_A, { kind: "crew", crewId: "actor-1" });
    const solo = deriveGroupKey(SUBJECT_A, { kind: "solo", actorId: "actor-1" });
    assert.notEqual(crew, solo, "crew: and solo: prefixes keep them distinct even with equal ids");
  });

  it("is INVARIANT to uuid case — a crew cannot split by sending case-variants of its id", () => {
    const crewId = "AbCdEf01-2345-6789-abcd-EF0123456789";
    const lower = deriveGroupKey(SUBJECT_A, { kind: "crew", crewId: crewId.toLowerCase() });
    const upper = deriveGroupKey(SUBJECT_A, { kind: "crew", crewId: crewId.toUpperCase() });
    const mixed = deriveGroupKey(SUBJECT_A, { kind: "crew", crewId });
    assert.equal(lower, upper, "case-variant tripIds collapse to one group_key");
    assert.equal(lower, mixed);
    // subjectId case is likewise canonicalised.
    assert.equal(
      deriveGroupKey(SUBJECT_A.toUpperCase(), { kind: "solo", actorId: "ACTOR-1" }),
      deriveGroupKey(SUBJECT_A, { kind: "solo", actorId: "actor-1" }),
    );
  });

  it("the same crew at two venues is UNLINKABLE (subject-scoped)", () => {
    const atA = deriveGroupKey(SUBJECT_A, { kind: "crew", crewId: "trip-1" });
    const atB = deriveGroupKey(SUBJECT_B, { kind: "crew", crewId: "trip-1" });
    assert.notEqual(atA, atB, "subject folded into the HMAC → no cross-venue correlation");
  });

  it("fails closed without the server secret (no guessable fallback)", () => {
    const saved = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    try {
      assert.throws(() => deriveGroupKey(SUBJECT_A, { kind: "solo", actorId: "actor-1" }), /SESSION_SECRET/);
      // A null identity short-circuits before the secret is needed.
      assert.equal(deriveGroupKey(SUBJECT_A, null), null);
    } finally {
      process.env.SESSION_SECRET = saved;
    }
  });
});
