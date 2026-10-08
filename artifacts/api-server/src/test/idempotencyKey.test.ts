/**
 * The `Idempotency-Key` header reader — `09` §7 part 1, PAY-046.
 *
 *   IK1  a well-formed key is returned exactly as sent
 *   IK2  an absent or empty header is `idempotency_key_required`
 *   IK3  two keys (a repeated header, or a joined one) are refused, not guessed at
 *   IK4  shape: length bounds, charset, first character
 *   IK5  the key is never trimmed or repaired
 *   IK6  bindIdempotencyKey: the pair (scope, key) names the operation and the actor's payment party
 *   IK7  bindIdempotencyKey: a binding that is not an operation slug and a party id yields no pair
 *
 * Run: node --import tsx/esm --test src/test/idempotencyKey.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  bindIdempotencyKey,
  readIdempotencyKey,
} from "../lib/idempotencyKey.js";

describe("readIdempotencyKey (09 §7, PAY-046)", () => {
  it("IK1. a well-formed, event-derived key is returned exactly as sent", () => {
    for (const key of [
      "booking:5f0c2a2e-8a56-4c7e-9a43-0d6d1c7b9e11:tip:1",
      "evt_1PabcDEF2ghiJKL3",
      "payout-request.2026-10_0007",
      "a".repeat(IDEMPOTENCY_KEY_MIN_LENGTH),
      "a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH),
    ]) {
      assert.deepEqual(readIdempotencyKey(key), { ok: true, key });
    }
    assert.equal(IDEMPOTENCY_KEY_HEADER, "Idempotency-Key");
  });

  it("IK2. absent, null and empty are `idempotency_key_required` — a money request without a key is not served", () => {
    for (const v of [undefined, null, ""]) {
      const r = readIdempotencyKey(v);
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.reason, "idempotency_key_required");
        assert.match(r.message, /Idempotency-Key/);
      }
    }
  });

  it("IK3. two keys are refused: a repeated header (array) and Node's joined form (comma, space)", () => {
    const repeated = readIdempotencyKey(["booking:1:tip:1", "booking:1:tip:2"]);
    assert.equal(repeated.ok, false);
    if (!repeated.ok) assert.equal(repeated.reason, "idempotency_key_malformed");
    const joined = readIdempotencyKey("booking:1:tip:1, booking:1:tip:2");
    assert.equal(joined.ok, false);
    if (!joined.ok) assert.equal(joined.reason, "idempotency_key_malformed");
  });

  it("IK4. shape: too short, too long, a leading separator, and characters outside the set are malformed", () => {
    for (const v of [
      "a".repeat(IDEMPOTENCY_KEY_MIN_LENGTH - 1),
      "a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1),
      ":booking-1-tip-1",
      "-booking-1-tip-1",
      "booking 1 tip 1",
      "booking/1/tip/1",
      "booking:1:tip:é",
      "booking:1:tip:1\n",
      12345678,
      { key: "booking:1:tip:1" },
    ]) {
      const r = readIdempotencyKey(v);
      assert.equal(r.ok, false, `accepted ${JSON.stringify(v)}`);
      if (!r.ok) assert.equal(r.reason, "idempotency_key_malformed");
    }
  });

  it("IK5. a key with surrounding whitespace is refused, not trimmed: two spellings would be two keys", () => {
    assert.equal(readIdempotencyKey(" booking:1:tip:1").ok, false);
    assert.equal(readIdempotencyKey("booking:1:tip:1 ").ok, false);
  });

  const PARTY_A = "11111111-1111-4111-8111-111111111111";
  const PARTY_B = "22222222-2222-4222-8222-222222222222";

  it("IK6. the same key from two actors is two (scope, key) pairs; from one actor it is one — and the key itself is untouched", () => {
    const a = bindIdempotencyKey("client-chosen-0001", { operation: "tip", actorPartyId: PARTY_A });
    const b = bindIdempotencyKey("client-chosen-0001", { operation: "tip", actorPartyId: PARTY_B });
    assert.deepEqual(a, { ok: true, scope: `http:tip:${PARTY_A}`, idempotencyKey: "client-chosen-0001" });
    assert.deepEqual(b, { ok: true, scope: `http:tip:${PARTY_B}`, idempotencyKey: "client-chosen-0001" });
    assert.deepEqual(bindIdempotencyKey("client-chosen-0001", { operation: "tip", actorPartyId: PARTY_A }), a);
    // The header's own refusals pass through unchanged.
    const none = bindIdempotencyKey(undefined, { operation: "tip", actorPartyId: PARTY_A });
    assert.equal(none.ok === false && none.reason, "idempotency_key_required");
    const bad = bindIdempotencyKey("two keys, joined", { operation: "tip", actorPartyId: PARTY_A });
    assert.equal(bad.ok === false && bad.reason, "idempotency_key_malformed");
    // The longest operation still fits the ledger's 120-character scope.
    const long = bindIdempotencyKey("client-chosen-0001", { operation: "a".repeat(60), actorPartyId: PARTY_A });
    assert.equal(long.ok && long.scope.length <= 120, true);
  });

  it("IK7. no binding, no pair: there is no un-namespaced form to fall back to", () => {
    for (const binding of [
      undefined, null, {}, { operation: "tip" }, { actorPartyId: PARTY_A },
      { operation: "T", actorPartyId: PARTY_A }, { operation: "tip:all", actorPartyId: PARTY_A },
      { operation: "a".repeat(61), actorPartyId: PARTY_A }, { operation: "tip", actorPartyId: "user-42" },
      { operation: "tip", actorPartyId: PARTY_A.replace(/-/g, "") }, { operation: 7, actorPartyId: PARTY_A },
    ]) {
      const r = bindIdempotencyKey("client-chosen-0001", binding as any);
      assert.equal(r.ok, false, JSON.stringify(binding));
      if (!r.ok) assert.equal(r.reason, "idempotency_binding_invalid", JSON.stringify(binding));
      assert.equal("idempotencyKey" in r, false);
    }
  });
});
