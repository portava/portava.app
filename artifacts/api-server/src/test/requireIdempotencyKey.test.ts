/**
 * `requireIdempotencyKey` (lib/http.ts) — the half that writes the refusal.
 * `09` §7 part 1, PAY-046.
 *
 *   RK1  a present, well-formed header returns the key and writes nothing
 *   RK2  an absent header writes 400 invalid_payload, reason idempotency_key_required
 *   RK3  a malformed header writes 400 invalid_payload, reason idempotency_key_malformed
 *
 * Run: node --import tsx/esm --test src/test/requireIdempotencyKey.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { requireIdempotencyKey } from "../lib/http.js";

function fakeRes() {
  const res: any = { statusCode: 0, body: undefined as any };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

describe("requireIdempotencyKey (09 §7, PAY-046)", () => {
  it("RK1. a well-formed key is returned and no response is written", () => {
    const res = fakeRes();
    const key = requireIdempotencyKey({ headers: { "idempotency-key": "booking:b1:tip:1" } } as any, res);
    assert.equal(key, "booking:b1:tip:1");
    assert.equal(res.statusCode, 0);
    assert.equal(res.body, undefined);
  });

  it("RK2. no header: null, and a 400 the client can tell from any other invalid payload", () => {
    const res = fakeRes();
    const key = requireIdempotencyKey({ headers: {} } as any, res);
    assert.equal(key, null);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "invalid_payload");
    assert.equal(res.body.reason, "idempotency_key_required");
  });

  it("RK3. a malformed header: null, 400, reason idempotency_key_malformed", () => {
    const res = fakeRes();
    const key = requireIdempotencyKey({ headers: { "idempotency-key": "two keys, joined" } } as any, res);
    assert.equal(key, null);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "invalid_payload");
    assert.equal(res.body.reason, "idempotency_key_malformed");
  });
});
