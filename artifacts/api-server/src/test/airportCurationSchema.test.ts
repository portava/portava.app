import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readCurationHistory } from "../services/airport/airportCuration.js";
import { readOutcomeEvidence, recalibrateAirport } from "../services/airport/layoverCalibration.js";
import { airportCalibrationSchemaReadiness, airportCurationSchemaReadiness } from "../services/airport/airportCurationSchema.js";
import { SCHEMA_PROBE_SENTINEL_ID } from "../lib/capability/schemaRequirement.js";

// This double models only read-only readiness requests, never feature data or SQL validity.
function readinessClient(error: unknown, throws = false) {
  const calls: Array<{ table: string; column?: string; value?: unknown }> = [];
  const db = { from(table: string) {
    if (throws) throw new Error("readiness transport unavailable");
    const call: (typeof calls)[number] = { table }; calls.push(call);
    return { select() { return this; }, eq(column: string, value: unknown) { call.column = column; call.value = value; return this; }, async maybeSingle() { return { data: null, error }; } };
  } } as unknown as Parameters<typeof readCurationHistory>[0];
  return { db, calls };
}
describe("airport workflow schema readiness", () => {
  for (const [code, expected] of [["42P01", "storage_unavailable"], ["XX000", "read_failed"]]) {
    it(`refuses feature queries on ${code} without asserting an empty curation history`, async () => {
      const { db, calls } = readinessClient({ code, message: "readiness failed" });
      const result = await readCurationHistory(db, "airport-id");
      assert.equal(result.ok, false);
      if (result.ok) assert.fail("expected refusal");
      assert.equal(result.reason, expected);
      assert.ok(calls.length > 0);
      assert.ok(calls.every((c) => c.value === SCHEMA_PROBE_SENTINEL_ID), "no feature query or writer runs before readiness");
    });
  }
  it("a thrown readiness probe refuses rather than reaching workflow writes", async () => {
    const { db } = readinessClient(null, true);
    const result = await recalibrateAirport(db, { id: "airport-id", iataCode: "ZZT", timezone: "UTC" }, Date.now());
    assert.equal(result.ok, false);
    if (result.ok) assert.fail("expected refusal");
    assert.equal(result.reason, "read_failed");
  });
  it("optional outcome evidence remains named unavailable before any outcome query", async () => {
    const { db, calls } = readinessClient({ code: "42P01", message: "missing outcomes" });
    const result = await readOutcomeEvidence(db, "airport-id", "UTC", { startMs: 0, endMs: Date.now() });
    assert.deepEqual(result, { ok: false, reason: "outcomes_storage_unavailable" });
    assert.ok(calls.every((c) => c.value === SCHEMA_PROBE_SENTINEL_ID));
  });
  it("curation and calibration have separate readiness cache identities and never read feature flags", async () => {
    const { db, calls } = readinessClient(null);
    assert.equal((await airportCurationSchemaReadiness(db)).state, "ready");
    assert.equal((await airportCalibrationSchemaReadiness(db)).state, "ready");
    assert.ok(calls.some((c) => c.table === "airport_curated_facts"));
    assert.ok(calls.some((c) => c.table === "airport_time_band_calibrations"));
    assert.ok(calls.every((c) => c.table !== "feature_flags"));
  });
});
