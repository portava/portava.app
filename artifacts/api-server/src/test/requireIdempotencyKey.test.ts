/**
 * `requireIdempotencyKey` (lib/http.ts) — the half that writes the refusal.
 * `09` §7 part 1, PAY-046.
 *
 *   RK1  a present, well-formed header returns the key WITH its scope and writes nothing
 *   RK2  an absent header writes 400 invalid_payload, reason idempotency_key_required
 *   RK3  a malformed header writes 400 invalid_payload, reason idempotency_key_malformed
 *   RK4  two users sending the SAME key get different scopes; one user retrying gets the same pair
 *   RK5  a route that does not say who is asking gets no key at all (500), never an un-namespaced one
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

const PARTY_A = "11111111-1111-4111-8111-111111111111";
const PARTY_B = "22222222-2222-4222-8222-222222222222";
const BINDING = { operation: "tip", actorPartyId: PARTY_A };

describe("requireIdempotencyKey (09 §7, PAY-046)", () => {
  it("RK1. a well-formed key is returned with the scope that says whose it is, and no response is written", () => {
    const res = fakeRes();
    const key = requireIdempotencyKey({ headers: { "idempotency-key": "booking:b1:tip:1" } } as any, res, BINDING);
    assert.deepEqual(key, { scope: `http:tip:${PARTY_A}`, idempotencyKey: "booking:b1:tip:1" });
    assert.equal(res.statusCode, 0);
    assert.equal(res.body, undefined);
  });

  it("RK4. two users, one key: different scopes — so user B is never told 'conflict' for user A's request; a retry is the same pair", () => {
    const req = { headers: { "idempotency-key": "client-chosen-0001" } } as any;
    const a = requireIdempotencyKey(req, fakeRes(), { operation: "tip", actorPartyId: PARTY_A });
    const b = requireIdempotencyKey(req, fakeRes(), { operation: "tip", actorPartyId: PARTY_B });
    assert.ok(a && b);
    assert.equal(a!.idempotencyKey, b!.idempotencyKey);
    assert.notEqual(a!.scope, b!.scope);
    assert.deepEqual(requireIdempotencyKey(req, fakeRes(), { operation: "tip", actorPartyId: PARTY_A }), a, "the same user retrying");
    // The same user on another operation is another event too.
    assert.notEqual(requireIdempotencyKey(req, fakeRes(), { operation: "payout_request", actorPartyId: PARTY_A })!.scope, a!.scope);
    // The scope is one the ledger accepts: a lower-case slug within its 120 characters.
    assert.match(a!.scope, /^[a-z0-9][a-z0-9:._/-]{0,119}$/);
    assert.equal(requireIdempotencyKey(req, fakeRes(), { operation: "tip", actorPartyId: PARTY_A.toUpperCase() })!.scope, a!.scope);
  });

  it("RK5. a route that does not say who is asking gets NO key — 500, not a key without its namespace", () => {
    const req = { headers: { "idempotency-key": "client-chosen-0001" } } as any;
    for (const binding of [
      undefined, {}, { operation: "tip" }, { actorPartyId: PARTY_A }, { operation: "", actorPartyId: PARTY_A },
      { operation: "Tip For Sam", actorPartyId: PARTY_A }, { operation: "tip", actorPartyId: "not-a-uuid" },
      { operation: "tip", actorPartyId: "" }, { operation: "tip", actorPartyId: null },
    ]) {
      const res = fakeRes();
      const key = requireIdempotencyKey(req, res, binding as any);
      assert.equal(key, null, JSON.stringify(binding));
      assert.equal(res.statusCode, 500, JSON.stringify(binding));
      assert.equal(res.body.error, "db_error");
    }
  });

  it("RK2. no header: null, and a 400 the client can tell from any other invalid payload", () => {
    const res = fakeRes();
    const key = requireIdempotencyKey({ headers: {} } as any, res, BINDING);
    assert.equal(key, null);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "invalid_payload");
    assert.equal(res.body.reason, "idempotency_key_required");
  });

  it("RK3. a malformed header: null, 400, reason idempotency_key_malformed", () => {
    const res = fakeRes();
    const key = requireIdempotencyKey({ headers: { "idempotency-key": "two keys, joined" } } as any, res, BINDING);
    assert.equal(key, null);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "invalid_payload");
    assert.equal(res.body.reason, "idempotency_key_malformed");
  });
});
