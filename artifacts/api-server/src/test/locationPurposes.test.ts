/**
 * Location purpose registry — enforces the owner ruling of 2026-08-22.
 *
 * The property under test: a table cannot hold coordinates without a documented
 * purpose, and a PRECISE purpose cannot be open-ended. "Minimize persistent raw
 * movement history" is unenforceable if either hole exists.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BASELINE_PATH } from "../scripts/parseBaselineSchema.js";
import { coordinateTablesFromBaseline, computeProblems } from "../scripts/checkLocationPurposes.js";
import {
  LOCATION_PURPOSES, LAWFUL_BASES, PRECISION_PREFERENCE,
  precisePurposes, unboundedPrecisePurposes, purposeTables,
} from "../lib/locationPurposes.js";

const TABLES = coordinateTablesFromBaseline(readFileSync(BASELINE_PATH, "utf8"));

describe("location purposes — the registry is complete", () => {
  it("finds coordinate tables in the baseline", () => {
    assert.ok(TABLES.size > 10, `expected many coordinate tables, got ${TABLES.size}`);
  });

  it("is currently clean", () => {
    const p = computeProblems(TABLES);
    assert.deepEqual(p, [], p.map((x) => `${x.kind}: ${x.detail}`).join("\n"));
  });

  it("every purpose carries all four fields the ruling requires", () => {
    for (const p of LOCATION_PURPOSES) {
      assert.ok(LAWFUL_BASES.includes(p.lawfulBasis), `${p.id}: lawful basis`);
      assert.ok(p.retentionNote.trim().length >= 15, `${p.id}: retention`);
      assert.ok(p.visibility.trim().length >= 15, `${p.id}: visibility`);
      assert.ok(p.deletionBehavior.trim().length >= 15, `${p.id}: deletion behaviour`);
    }
  });

  it("purpose ids are unique", () => {
    const ids = LOCATION_PURPOSES.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("location purposes — minimising raw movement history", () => {
  it("NO precise purpose is unbounded", () => {
    const bad = unboundedPrecisePurposes();
    assert.deepEqual(bad.map((p) => p.id), [],
      "a precise purpose with no retention bound is exactly what the ruling forbids");
  });

  it("every precise purpose states a clock or an explicit session/incident bound", () => {
    for (const p of precisePurposes()) {
      const bounded = p.retentionSeconds !== null || /session|incident|OPEN:/i.test(p.retentionNote);
      assert.ok(bounded, `${p.id} retains precise location with no stated bound`);
    }
  });

  it("aggregate and derived are preferred over precise", () => {
    assert.ok(PRECISION_PREFERENCE.aggregate < PRECISION_PREFERENCE.derived);
    assert.ok(PRECISION_PREFERENCE.derived < PRECISION_PREFERENCE.coarse);
    assert.ok(PRECISION_PREFERENCE.coarse < PRECISION_PREFERENCE.precise);
  });

  it("the intel path is DERIVED and stores no coordinates — the shape the ruling prefers", () => {
    const intel = LOCATION_PURPOSES.find((p) => p.id === "intel_claim")!;
    assert.equal(intel.precision, "derived");
    assert.match(intel.retentionNote, /no coordinates/i);
    // and the schema backs that up
    const sql = readFileSync(new URL("../migrations/2130_intel_storage.sql", import.meta.url), "utf8");
    assert.doesNotMatch(sql, /intel_observations[\s\S]*?\n\s+(lat|lng|latitude|longitude)\s+/,
      "intel_observations must not gain coordinate columns");
  });

  it("sensitive social/location capabilities require a separate user control", () => {
    for (const id of ["live_session_sharing", "presence_in_context", "safety_return", "journey_observation", "intel_claim"]) {
      const p = LOCATION_PURPOSES.find((x) => x.id === id)!;
      assert.equal(p.requiresSeparateControl, true, `${id} shares or infers location and needs its own control`);
    }
  });
});

describe("location purposes — the guard bites", () => {
  it("FAILS when a new coordinate table is unclaimed", () => {
    const withNew = new Map(TABLES);
    withNew.set("shadow_gps_trail", ["lat", "lng"]);
    const hit = computeProblems(withNew).find((p) => p.detail.includes("shadow_gps_trail"));
    assert.ok(hit, "a new coordinate table passed unclaimed");
    assert.equal(hit!.kind, "UNCLAIMED LOCATION TABLE");
  });

  it("no purpose table is claimed twice under conflicting purposes", () => {
    const seen = new Map<string, string>();
    for (const p of LOCATION_PURPOSES) {
      for (const t of p.tables) {
        const prev = seen.get(t);
        // Sharing a table across purposes is legitimate (a table can serve two
        // uses); what must not differ is the precision class it is treated as.
        if (prev) {
          const a = LOCATION_PURPOSES.find((x) => x.id === prev)!;
          assert.equal(a.precision, p.precision,
            `${t} is claimed by ${prev} (${a.precision}) and ${p.id} (${p.precision}) at different precision`);
        }
        seen.set(t, p.id);
      }
    }
    assert.ok(purposeTables().size > 0);
  });
});
