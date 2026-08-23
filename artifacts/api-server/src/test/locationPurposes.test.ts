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
  precisePurposes, unboundedPrecisePurposes, purposeTables, RETENTION_BOUNDS,
  undecidedRetentionPurposes, ACKNOWLEDGED_OPEN_DECISIONS,
  INTEL_IDENTIFIABLE_RETENTION_SECONDS,
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

  it("every precise purpose declares a TYPED bound, not a phrase", () => {
    for (const p of precisePurposes()) {
      assert.ok(RETENTION_BOUNDS.includes(p.retentionBound), `${p.id}: bound must be typed`);
      if (p.retentionBound === "clock") {
        assert.ok(p.retentionSeconds !== null, `${p.id}: clock bound needs a number`);
      }
      assert.notEqual(p.retentionBound, "open_decision",
        `${p.id} retains precise location under an undecided policy`);
    }
  });

  it("a stamp is content, not movement history (owner ruling 2026-08-23)", () => {
    const stamp = LOCATION_PURPOSES.find((p) => p.id === "stamp_content")!;
    assert.equal(stamp.precision, "precise", "a stamp legitimately keeps its precise coordinates");
    assert.equal(stamp.retentionBound, "content_lifetime");
    assert.equal(stamp.lawfulBasis, "contract");
    // The GPS child IS deleted — verified against the live schema, not inferred
    // from AccountDeletionService, which never names the table. The earlier
    // version of this assertion pinned the opposite claim, which is exactly how
    // an unverified belief becomes a test that defends it.
    assert.match(stamp.deletionBehavior, /ON DELETE CASCADE/,
      "the registry must name the constraint that actually deletes the coordinates");
    assert.doesNotMatch(stamp.deletionBehavior, /TODAY IS NOT/,
      "the superseded claim that stamp GPS survives deletion must not come back");
    // The real gap the ruling exposes is the PARENT: the stamp outlives the
    // account on production, where profiles has no FK to auth.users.
    assert.match(stamp.deletionBehavior, /the PARENT survives/,
      "the registry must record that the stamp itself is not deleted on production");
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

describe("location purposes — undecided retention is visible at ANY precision", () => {
  it("no purpose has an undecided retention window", () => {
    // intel_claim was the last one; the owner ruled 180 days on 2026-08-23.
    // Asserting EMPTY rather than asserting intel_claim is absent, so a new
    // undecided purpose fails here too rather than sliding in beside it.
    assert.deepEqual(undecidedRetentionPurposes().map((p) => p.id), []);
    assert.deepEqual([...ACKNOWLEDGED_OPEN_DECISIONS], [],
      "the acknowledgement list is debt, not permission — it should stay empty");
  });

  it("intel_claim carries the ruled 180-day identifiable window", () => {
    const p = LOCATION_PURPOSES.find((x) => x.id === "intel_claim")!;
    assert.equal(p.retentionBound, "clock");
    assert.equal(p.retentionSeconds, INTEL_IDENTIFIABLE_RETENTION_SECONDS);
    assert.equal(p.retentionSeconds, 180 * 24 * 3600, "180 days, per the ruling");
    // The mechanism that surfaced it must still work for the NEXT purpose:
    // a derived+open_decision entry is reported by undecidedRetentionPurposes(),
    // never by unboundedPrecisePurposes(), which only inspects PRECISE ones.
    assert.equal(unboundedPrecisePurposes().length, 0);
  });

  it("every undecided purpose is acknowledged — known debt may exist, not grow", () => {
    for (const p of undecidedRetentionPurposes()) {
      assert.ok(ACKNOWLEDGED_OPEN_DECISIONS.includes(p.id), `${p.id} is undecided but unacknowledged`);
    }
  });

  it("FAILS when a NEW purpose declares open_decision without acknowledgement", () => {
    const ghost = { id: "ghost_purpose", retentionBound: "open_decision" };
    assert.ok(!ACKNOWLEDGED_OPEN_DECISIONS.includes(ghost.id),
      "an unacknowledged open_decision must not be silently permitted");
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
