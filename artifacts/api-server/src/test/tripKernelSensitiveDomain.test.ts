/**
 * Trips spec §4.1 — "the command service validates … sensitive-domain
 * boundaries" (census-trips TR56). Before this, the boundary held by
 * construction: documents, health and payments have their own routes, so no
 * shared write path could cross into them. Now it is a CHECK: a trip command
 * whose payload names a travel-document number, a health fact or a payment
 * instrument — at any depth, a proposal's free-form payload_json included —
 * is refused by name before the kernel is called, and the refusal is counted.
 *
 * Run: node --import tsx/esm --test src/test/tripKernelSensitiveDomain.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { executeTripCommand, sensitiveDomainKey, SENSITIVE_DOMAIN_KEY, readTripCommandRejectedTotal, _resetTripCommandRejectedTotal } from "../lib/tripKernel.js";
import { TRIP_KERNEL_EXTENSION_CODES } from "../lib/tripReasonCodes.js";

const TRIP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_ID = "11111111-1111-1111-1111-111111111111";

function fakeKernel() {
  const calls: any[] = [];
  const sc = {
    rpc: async (fn: string, args: any) => {
      calls.push({ fn, args });
      return { data: { ok: true, duplicate: false, version: 2, event_id: "e1", sequence: 1, result: { id: "p1" }, contract_version: 2 }, error: null };
    },
  };
  return { sc, calls };
}
const cmd = (payload: Record<string, unknown>, type = "ADD_PLAN") => ({ commandId: "c1", tripId: TRIP_ID, actorUserId: USER_ID, idempotencyKey: "k1", type: type as any, payload });

describe("§4.1 the sensitive-domain boundary is a check", () => {
  beforeEach(() => _resetTripCommandRejectedTotal());

  it("the key vocabulary: document numbers, health facts and payment instruments match; trip fields, booking references and document ids do not", () => {
    for (const k of ["passport_number", "passportNo", "passport", "document_number", "national_id", "ssn", "health", "medical", "diagnosis", "allergies", "medication", "blood_type", "card_number", "cvv", "iban", "account_number"]) assert.ok(SENSITIVE_DOMAIN_KEY.test(k), k);
    for (const k of ["title", "starts_at", "booking_ref", "confirmation_ref", "document_id", "place_id", "lat", "note", "cost_minor", "healthy", "passport_stamp_count"]) assert.ok(!SENSITIVE_DOMAIN_KEY.test(k), k);
  });
  it("sensitiveDomainKey finds a key at any depth, in arrays, and names it; a clean payload is null", () => {
    assert.equal(sensitiveDomainKey({ title: "Dinner", starts_at: "2026-10-02T20:00:00Z" }), null);
    assert.equal(sensitiveDomainKey({ title: "Flight", passport_number: "X123" }), "passport_number");
    assert.equal(sensitiveDomainKey({ payload_json: { traveller: { medical: "asthma" } } }), "medical");
    assert.equal(sensitiveDomainKey({ items: [{ ok: 1 }, { card_number: "4111" }] }), "card_number");
    assert.equal(sensitiveDomainKey(null), null); assert.equal(sensitiveDomainKey("string"), null);
  });
  it("executeTripCommand refuses TRIP_COMMAND_SENSITIVE_DOMAIN by name before the kernel is called, and counts it; a clean command reaches the kernel", async () => {
    const { sc, calls } = fakeKernel();
    const r = await executeTripCommand(sc as any, cmd({ title: "Flight", payload_json: { passport_number: "X123" } }, "CREATE_PROPOSAL"));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "TRIP_COMMAND_SENSITIVE_DOMAIN");
    assert.match(r.detail ?? "", /passport_number/);
    assert.equal(calls.length, 0, "the kernel never saw it");
    assert.equal(readTripCommandRejectedTotal()["TRIP_COMMAND_SENSITIVE_DOMAIN"], 1);
    const ok = await executeTripCommand(sc as any, cmd({ title: "Dinner", day_date: "2026-10-02" }));
    assert.equal(ok.ok, true); assert.equal(calls.length, 1);
  });
  it("the reason is in Appendix B's kernel extension vocabulary, so tripReasonCodes' guard sees it", () => {
    assert.ok((TRIP_KERNEL_EXTENSION_CODES as readonly string[]).includes("TRIP_COMMAND_SENSITIVE_DOMAIN"));
  });
});
