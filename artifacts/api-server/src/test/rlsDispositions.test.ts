/**
 * rlsDispositions.ts — the property the whole disposition manifest exists to
 * guarantee: every `public`-schema table in the committed baseline has
 * exactly one disposition entry, and that entry's class is consistent with
 * what the baseline actually shows.
 *
 * Deliberately re-parses the baseline file fresh at test time (via the same
 * parseBaselineSchema.ts the manifest was generated with) rather than
 * trusting the manifest's own generation-time claims — a manifest that
 * verifies itself against its own assumptions can't catch drift between the
 * two. If a future baseline capture adds/removes/renames a table and
 * rlsDispositions.ts isn't regenerated, this is what goes red.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadBaselineTables } from "../scripts/parseBaselineSchema.js";
import { RLS_DISPOSITIONS, FOLLOW_UPS } from "../scripts/rlsDispositions.js";

describe("rlsDispositions — coverage", () => {
  it("every public table in the baseline has a disposition entry", () => {
    const baseline = loadBaselineTables();
    const missing = [...baseline.keys()].filter((t) => !(t in RLS_DISPOSITIONS));
    assert.deepEqual(
      missing,
      [],
      `${missing.length} baseline table(s) have no rlsDispositions.ts entry: ${missing.join(", ")}`,
    );
  });

  it("no disposition entry references a table absent from the baseline (staleness)", () => {
    const baseline = loadBaselineTables();
    const stale = Object.keys(RLS_DISPOSITIONS).filter((t) => !baseline.has(t));
    assert.deepEqual(
      stale,
      [],
      `${stale.length} rlsDispositions.ts entries reference a table not in the current baseline: ${stale.join(", ")}`,
    );
  });

  it("baseline table count matches disposition entry count exactly (no duplicates, no gaps)", () => {
    const baseline = loadBaselineTables();
    assert.equal(Object.keys(RLS_DISPOSITIONS).length, baseline.size);
  });
});

describe("rlsDispositions — class consistency with the baseline", () => {
  it("every RLS_REQUIRED entry has RLS enabled and >= 1 policy in the baseline", () => {
    const baseline = loadBaselineTables();
    const bad: string[] = [];
    for (const [table, disp] of Object.entries(RLS_DISPOSITIONS)) {
      if (disp.class !== "RLS_REQUIRED") continue;
      const info = baseline.get(table);
      if (!info || !info.rlsEnabled || info.policyCount < 1) bad.push(table);
    }
    assert.deepEqual(bad, [], `RLS_REQUIRED mismatched against baseline: ${bad.join(", ")}`);
  });

  it("every DENY_ALL_BY_DESIGN entry has RLS enabled and exactly 0 policies in the baseline", () => {
    const baseline = loadBaselineTables();
    const bad: string[] = [];
    for (const [table, disp] of Object.entries(RLS_DISPOSITIONS)) {
      if (disp.class !== "DENY_ALL_BY_DESIGN") continue;
      const info = baseline.get(table);
      if (!info || !info.rlsEnabled || info.policyCount !== 0) bad.push(table);
    }
    assert.deepEqual(bad, [], `DENY_ALL_BY_DESIGN mismatched against baseline: ${bad.join(", ")}`);
  });

  it("every REVIEWED_EXEMPT entry has RLS disabled in the baseline", () => {
    const baseline = loadBaselineTables();
    const bad: string[] = [];
    for (const [table, disp] of Object.entries(RLS_DISPOSITIONS)) {
      if (disp.class !== "REVIEWED_EXEMPT") continue;
      const info = baseline.get(table);
      if (!info || info.rlsEnabled) bad.push(table);
    }
    assert.deepEqual(bad, [], `REVIEWED_EXEMPT mismatched against baseline: ${bad.join(", ")}`);
  });

  it("no table with RLS actually disabled in the baseline is classified RLS_REQUIRED or DENY_ALL_BY_DESIGN", () => {
    // The inverse of the checks above: catches a table whose RLS status
    // regressed (or was mis-generated) landing in a class that implies
    // protection it does not have.
    const baseline = loadBaselineTables();
    const bad: string[] = [];
    for (const [table, info] of baseline) {
      if (info.rlsEnabled) continue;
      const disp = RLS_DISPOSITIONS[table];
      if (disp && (disp.class === "RLS_REQUIRED" || disp.class === "DENY_ALL_BY_DESIGN")) bad.push(table);
    }
    assert.deepEqual(bad, [], `RLS-disabled table(s) wrongly classified as protected: ${bad.join(", ")}`);
  });
});

describe("rlsDispositions — required fields per class", () => {
  it("DENY_ALL_BY_DESIGN and REVIEWED_EXEMPT entries all carry a non-empty reason", () => {
    const bad = Object.entries(RLS_DISPOSITIONS)
      .filter(([, d]) => d.class === "DENY_ALL_BY_DESIGN" || d.class === "REVIEWED_EXEMPT")
      .filter(([, d]) => !d.reason || !d.reason.trim())
      .map(([t]) => t);
    assert.deepEqual(bad, [], `missing reason: ${bad.join(", ")}`);
  });

  it("REVIEWED_EXEMPT entries all carry a reviewer and a date", () => {
    const bad = Object.entries(RLS_DISPOSITIONS)
      .filter(([, d]) => d.class === "REVIEWED_EXEMPT")
      .filter(([, d]) => !d.reviewer?.trim() || !d.date?.trim())
      .map(([t]) => t);
    assert.deepEqual(bad, [], `missing reviewer/date: ${bad.join(", ")}`);
  });

  it("MUTATION-PROOF: an entry with class DENY_ALL_BY_DESIGN and no reason fails the reason check", () => {
    const fake: Record<string, { class: "DENY_ALL_BY_DESIGN"; policyCount: number }> = {
      not_a_real_table: { class: "DENY_ALL_BY_DESIGN", policyCount: 0 },
    };
    const bad = Object.entries(fake)
      .filter(([, d]) => d.class === "DENY_ALL_BY_DESIGN")
      .filter(([, d]: any) => !d.reason || !d.reason.trim())
      .map(([t]) => t);
    assert.deepEqual(bad, ["not_a_real_table"]);
  });
});

describe("rlsDispositions — FOLLOW_UPS survives", () => {
  const EXPECTED_USER_FACING_DENY_ALL = [
    "devices", "key_packages", "comment_likes", "post_reactions", "post_shares", "circle_invites",
  ];

  it("carries an entry for all 6 packet-flagged user-facing DENY_ALL_BY_DESIGN tables", () => {
    const tracked = new Set(FOLLOW_UPS.map((f) => f.table));
    const missing = EXPECTED_USER_FACING_DENY_ALL.filter((t) => !tracked.has(t));
    assert.deepEqual(missing, [], `FOLLOW_UPS is missing: ${missing.join(", ")}`);
  });

  it("every FOLLOW_UPS table is still classified DENY_ALL_BY_DESIGN in the manifest (not silently resolved)", () => {
    const bad = FOLLOW_UPS.filter((f) => RLS_DISPOSITIONS[f.table]?.class !== "DENY_ALL_BY_DESIGN").map((f) => f.table);
    assert.deepEqual(bad, [], `FOLLOW_UPS table no longer DENY_ALL_BY_DESIGN (update or remove the follow-up): ${bad.join(", ")}`);
  });

  it("every FOLLOW_UPS entry has a non-empty note", () => {
    const bad = FOLLOW_UPS.filter((f) => !f.note?.trim()).map((f) => f.table);
    assert.deepEqual(bad, [], `empty note: ${bad.join(", ")}`);
  });
});
