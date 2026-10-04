/**
 * The `Idempotency-Key` header reader — `09` §7 part 1, PAY-046.
 *
 *   IK1  a well-formed key is returned exactly as sent
 *   IK2  an absent or empty header is `idempotency_key_required`
 *   IK3  two keys (a repeated header, or a joined one) are refused, not guessed at
 *   IK4  shape: length bounds, charset, first character
 *   IK5  the key is never trimmed or repaired
 *
 * Run: node --import tsx/esm --test src/test/idempotencyKey.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
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
});
