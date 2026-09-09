/**
 * The plan aggregate — §5.1 `trip_plans`, §6.3 privacy scopes, §9.1 attendance
 * (census-trips TR82, TR83).
 *
 * THE IDENTITY QUESTION THIS FILE PINS
 * ====================================
 * §5.1 names a row `trip_plans`. The deployed table is `trip_plan_items`. They
 * are THE SAME AGGREGATE: every kernel plan command writes trip_plan_items,
 * every §4.2 plan event describes it, and trip_outcomes.plan_id points at it.
 * census-trips TR82 recorded that reading before either migration existed —
 * marking `trip_plans` W and naming trip_plan_items as the artifact.
 *
 * So 2770 ADDS the four columns §5.1 lists and trip_plan_items lacked, and
 * 2771 keys trip_plan_participants on trip_plan_items.id. Creating a table
 * named trip_plans would have created a second id space for one concept, with
 * the entire existing command and event vocabulary pointing at the other one.
 * The assertion that no such table exists is in 2770 itself, not only here.
 *
 * Behaviour is db/harness/run.sh. This file reads SQL as text.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MIG = fileURLToPath(new URL("../migrations/", import.meta.url));
const cols = readFileSync(MIG + "2770_trip_plans_spec_columns.sql", "utf8");
const parts = readFileSync(MIG + "2771_trip_plan_participants.sql", "utf8");
const kernel = readFileSync(MIG + "2772_trip_kernel_plan_attendance_and_plan_version.sql", "utf8");
const ts = readFileSync(new URL("../lib/tripKernel.ts", import.meta.url), "utf8");

describe("there is ONE plan aggregate", () => {
  it("no migration in the tree creates a table named trip_plans", () => {
    const offenders = readdirSync(MIG)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => /CREATE TABLE\s+(IF NOT EXISTS\s+)?public\.trip_plans\b/.test(readFileSync(MIG + f, "utf8")));
    assert.deepEqual(offenders, [],
      `these migrations create a second plan aggregate: ${offenders.join(", ")}`);
  });

  it("2770 refuses to apply if one ever appears", () => {
    assert.match(cols, /a table named public\.trip_plans exists/);
  });

  it("trip_plan_participants keys on trip_plan_items, not on an invented table", () => {
    assert.match(parts, /plan_id\s+uuid\s+NOT NULL REFERENCES public\.trip_plan_items\(id\) ON DELETE CASCADE/);
  });

  it("attendance cascades where the stage attachments set null, and says why", () => {
    // 2760-2763 use SET NULL for optional attachments on rows that mean
    // something without them. An attendance row is a statement ABOUT a plan.
    assert.match(parts, /confdeltype='c'/, "the CASCADE is not asserted in a postcondition");
    // Matched on the reason, not on a phrase that a reflow could break in half.
    assert.match(parts, /unlike every other stage\/plan reference/,
      "the difference from 2760-2763's SET NULL is not explained");
    assert.match(parts, /means nothing without one/,
      "the reason for CASCADE is not stated");
  });
});

describe("§5.1 / §6.3 / §9.1 columns", () => {
  it("adds exactly the columns §5.1 lists and trip_plan_items lacked, plus §9.1's plan scope", () => {
    for (const c of ["stage_id", "place_id", "privacy_scope", "version"]) {
      assert.ok(cols.includes(`ADD COLUMN ${c} `) || new RegExp(`ADD COLUMN ${c}\\s`).test(cols),
        `§5.1 column ${c} is not added`);
    }
    assert.match(cols, /ADD COLUMN plan_scope/, "§9.1's PlanScope is not added");
  });

  it("carries all six §6.3 privacy scopes and no others", () => {
    const m = cols.match(/privacy_scope IN \(([^)]*)\)/);
    assert.ok(m, "no privacy_scope vocabulary");
    const got = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    assert.deepEqual(got,
      ["crew", "friends_nearby", "private", "public", "selected_participants", "trip"].sort());
  });

  it("carries all four §9.1 plan scopes and no others", () => {
    const m = cols.match(/plan_scope IN \(([^)]*)\)/);
    assert.ok(m, "no plan_scope vocabulary");
    const got = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    assert.deepEqual(got, ["all_crew", "optional", "solo", "subgroup"]);
  });

  it("carries all five §9.1 attendance states and no others", () => {
    const m = parts.match(/attendance_state IN \(([^)]*)\)/);
    assert.ok(m, "no attendance vocabulary");
    const got = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    assert.deepEqual(got, ["cant_go", "going", "interested", "left", "maybe"]);
  });

  it("ties the legacy two-value visibility to the six-value scope with a CHECK", () => {
    // Two columns describing one property is how a schema starts lying. The
    // one invariant every deployed reader depends on is enforced rather than
    // left to convention.
    assert.match(cols, /CHECK \(\(visibility = 'public'\) = \(privacy_scope = 'public'\)\)/);
  });

  it("backfills before making the column NOT NULL, so no row is born inconsistent", () => {
    const backfill = cols.indexOf("UPDATE public.trip_plan_items\n   SET privacy_scope");
    const notNull = cols.indexOf("ALTER COLUMN privacy_scope SET NOT NULL");
    const tie = cols.indexOf("trip_plan_items_visibility_agrees_with_scope");
    assert.ok(backfill > 0 && notNull > backfill && tie > backfill,
      "the NOT NULL or the tie is applied before the backfill that satisfies it");
  });

  it("refuses to guess if visibility has grown a third value", () => {
    assert.match(cols, /visibility NOT IN \('members','public'\)/);
    assert.match(cols, /the privacy_scope backfill has no mapping for them/);
  });
});

describe("§9.1 attendance is self-only", () => {
  it("no attendance command reads a user_id from the payload", () => {
    // Not "checks it and refuses" — there is no key to send. A rule that cannot
    // be spelled cannot be got wrong.
    const branches = kernel.match(/\$branches\$([\s\S]*?)\$branches\$/);
    assert.ok(branches);
    assert.ok(!/v_payload->>'user_id'/.test(branches[1]),
      "an attendance branch reads a user_id from the payload");
  });

  it("writes the ACTOR as the participant, and asserts it in a postcondition", () => {
    assert.match(kernel, /VALUES \(v_item_id, v_actor,/);
    assert.match(kernel, /JOIN_PLAN does not write the ACTOR as the participant/);
  });

  it("leaving is a transition, not a delete, because §9.1 has a 'left' state", () => {
    assert.match(kernel, /SET attendance_state = 'left'/);
    assert.match(kernel, /A state that exists in the\n-- vocabulary and can never be reached is not a vocabulary/);
  });
});

describe("§5.1 trip_plans.version — plan-level concurrency", () => {
  it("is a different conflict from the trip's", () => {
    assert.ok(ts.includes('"TRIP_PLAN_VERSION_CONFLICT"'));
    assert.ok(ts.includes('"TRIP_VERSION_CONFLICT"'));
    assert.match(kernel, /expected_plan_version/);
  });

  it("bumps the plan version on every plan update", () => {
    assert.match(kernel, /version\s+= version \+ 1,/);
  });

  it("derives visibility on both write paths so 2770's tie cannot be broken", () => {
    const derivations = kernel.match(/= 'public'\s*\n?\s*THEN 'public' ELSE 'members' END/g) ?? [];
    assert.ok(derivations.length >= 2,
      `visibility is derived on ${derivations.length} write path(s); ADD_PLAN and UPDATE_PLAN both need it`);
    assert.match(kernel, /UPDATE_PLAN still patches visibility directly/,
      "nothing refuses a surviving direct visibility patch, which would silently win");
  });

  it("wraps both plan writes so a vocabulary CHECK is a typed refusal, not a 500", () => {
    // 2450's header states the contract: "Rejections are RETURNED, never
    // RAISED". ADD_PLAN had no handler because none of its columns had a
    // vocabulary; 2770 gave it three. Found by executing it, not by reading it.
    assert.match(kernel, /expected ADD_PLAN and UPDATE_PLAN both wrapped/);
  });
});
