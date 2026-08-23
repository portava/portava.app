/**
 * D6 classifications — the rulings applied mechanically, and kept that way.
 *
 * The property under test is not "these are the right fates" — that is the
 * owner's call, recorded in the file. It is that the record stays HONEST:
 * every entry cites a ruling, every escalation names the columns that make it
 * straddle, and the escalation set can shrink but never quietly grow.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { D6_CLASSIFICATIONS, d6ByFate, d6StillUndecided } from "../lib/d6Classifications.js";
import { UNCLASSIFIED_BACKLOG } from "../lib/deletionDispositions.js";

describe("D6 classifications — shape", () => {
  it("every entry cites one of the five rulings and gives a reason", () => {
    for (const c of D6_CLASSIFICATIONS) {
      assert.ok(c.rule >= 1 && c.rule <= 5, `${c.table}: rule ${c.rule} is not one of the five`);
      assert.ok(c.reason.length > 80,
        `${c.table}: the reason is too short to be a reason someone could disagree with`);
    }
  });

  it("no table is classified twice", () => {
    const seen = D6_CLASSIFICATIONS.map((c) => c.table);
    assert.equal(new Set(seen).size, seen.length);
  });

  it("every escalation names the exact columns that make it straddle", () => {
    // The owner's instruction: escalate only what genuinely straddles two
    // rulings, and say which columns cause it. An escalation without that is a
    // shrug wearing a label.
    for (const c of d6StillUndecided()) {
      assert.ok(c.ambiguousColumns && c.ambiguousColumns.length > 0,
        `${c.table} is escalated but names no ambiguous columns`);
    }
  });

  it("a table NOT escalated must not name ambiguous columns", () => {
    for (const c of D6_CLASSIFICATIONS) {
      if (c.fate !== "NEEDS_OWNER_DECISION") {
        assert.equal(c.ambiguousColumns, undefined,
          `${c.table} is decided, so it should not still be carrying an ambiguity list`);
      }
    }
  });
});

describe("D6 classifications — the escalation set is a ratchet", () => {
  it("at most 2 tables await an owner ruling", () => {
    // Applying the five rulings mechanically took 21 undecided tables to 2.
    // This number may fall. If it rises, someone escalated instead of applying
    // the rulings, which is the habit the rulings exist to end.
    assert.ok(d6StillUndecided().length <= 2,
      `${d6StillUndecided().length} tables await a ruling; the mechanical pass left 2. ` +
      `Apply the rulings rather than adding to this list.`);
  });

  it("the two known escalations are the ones the owner was asked about", () => {
    assert.deepEqual(
      d6StillUndecided().map((c) => c.table).sort(),
      ["journey_shadow_cohort_assignments", "rent_buddy_review_notes"],
    );
  });
});

describe("D6 classifications — honest about not being implemented", () => {
  it("classified tables are still in the backlog, because no code performs these fates yet", () => {
    // Deliberate. A disposition that claims a table is erased before the worker
    // erases it is the exact false claim this codebase keeps finding. Entries
    // leave UNCLASSIFIED_BACKLOG when the worker does the work, not when the
    // decision is written down.
    const backlog = new Set(UNCLASSIFIED_BACKLOG);
    const claimedErased = d6ByFate("ERASE").filter((t) => backlog.has(t));
    assert.ok(claimedErased.length > 0,
      "expected the ERASE set to still sit in the backlog until the worker implements it");
  });

  it("profiles is classified — the one row guaranteed to survive", () => {
    const p = D6_CLASSIFICATIONS.find((c) => c.table === "profiles");
    assert.ok(p, "profiles must be classified; it survives every deletion");
    assert.equal(p.fate, "ANONYMIZE");
    assert.match(p.reason, /derived from the schema/,
      "the reason must record that a hand-maintained column list drifts");
  });
});
