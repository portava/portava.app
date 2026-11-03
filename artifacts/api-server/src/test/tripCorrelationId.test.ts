/**
 * census-trips hotfix (2026-10-24): the kernel's correlation id is a uuid (2420 casts it `::uuid`), so a label sent as
 * one broke closeout answers, /regroup and meeting arrival/close the moment trip_kernel_enabled went ON in production.
 *
 *   - tripCorrelationId(label) is RFC 4122 v5 (SHA-1) under a fixed namespace: deterministic, version 5, variant 10.
 *   - asTripCorrelationId accepts a uuid and nothing else.
 *   - executeTripCommand refuses a non-uuid correlation id BEFORE the RPC (the RPC is never called).
 *   - TripCommand.correlationId is the branded type, so a label is a compile error at every call site; the pin below
 *     fails if someone widens it back to `string`.
 *
 * Run: node --import tsx/esm --test src/test/tripCorrelationId.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { asTripCorrelationId, executeTripCommand, isTripCorrelationId, PORTAVA_TRIP_CORRELATION_NAMESPACE, tripCorrelationId } from "../domain/trips/commands/tripKernel.js";

describe("trip correlation ids are uuids", () => {
  it("tripCorrelationId is RFC 4122 version 5 of the label under the fixed namespace (a known vector)", () => {
    // python3 -c "import uuid; print(uuid.uuid5(uuid.UUID('6f1d2c9e-8a4b-5c3d-9e7f-1a2b3c4d5e6f'), 'closeout:trip-1'))"
    assert.equal(PORTAVA_TRIP_CORRELATION_NAMESPACE, "6f1d2c9e-8a4b-5c3d-9e7f-1a2b3c4d5e6f");
    assert.equal(tripCorrelationId("closeout:trip-1"), "9c5896aa-8319-5b09-a168-2ad5cd6edadf");
    const id = tripCorrelationId("regroup:anything");
    assert.equal(isTripCorrelationId(id), true);
    assert.equal(id[14], "5", "version 5");
    assert.ok("89ab".includes(id[19]!), "variant 10");
  });

  it("is deterministic per label (retries correlate) and distinct across labels", () => {
    assert.equal(tripCorrelationId("checkpoint:x"), tripCorrelationId("checkpoint:x"));
    assert.notEqual(tripCorrelationId("checkpoint:x"), tripCorrelationId("checkpoint:y"));
  });

  it("asTripCorrelationId accepts a uuid and refuses a label, an empty string and a non-string", () => {
    assert.equal(asTripCorrelationId("0f8fad5b-d9cb-469f-a165-70867728950e"), "0f8fad5b-d9cb-469f-a165-70867728950e");
    for (const bad of ["closeout:trip-1", "", "0f8fad5b-d9cb-469f-a165-70867728950", 42, null, undefined, {}]) assert.equal(asTripCorrelationId(bad), null, String(bad));
  });

  it("executeTripCommand refuses a label as TRIP_COMMAND_MALFORMED and never calls the RPC", async () => {
    let called = 0;
    const sc = { rpc: async () => { called += 1; return { data: { ok: true }, error: null }; } };
    const r = await executeTripCommand(sc, { commandId: "c", tripId: "t", actorUserId: "u", idempotencyKey: "k", type: "ADD_RISK", payload: {}, correlationId: "closeout:trip-1" as any });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "TRIP_COMMAND_MALFORMED");
    assert.equal(called, 0, "a label reached trip_kernel_execute");
  });

  it("TripCommand.correlationId is the branded TripCorrelationId (a label is a compile error at every caller)", () => {
    const src = readFileSync(new URL("../domain/trips/commands/tripKernel.ts", import.meta.url), "utf8");
    assert.match(src, /\n  correlationId\?: TripCorrelationId \| null;/);
    assert.match(src, /export type TripCorrelationId = string & \{ readonly __tripCorrelationId: unique symbol \};/);
  });
});
