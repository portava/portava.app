/**
 * A DO block that AUTHORS a function body is a caller — src/scripts/lib/transformedFunction.ts.
 *
 * WHAT WENT WRONG, AND WHY IT IS WORTH A TEST FILE
 * ===============================================
 * `check:security-definer-oracles` finds SECURITY DEFINER functions that
 * nothing references, because an unreferenced definer function over PostgREST
 * is an authorization oracle anyone can ask. It resolved reference edges from
 * `CREATE FUNCTION` bodies, policies, views, triggers and string literals — and
 * from nothing else.
 *
 * The Trips kernel migrations author bodies a sixth way. 2764-2777 do not
 * restate `trip_kernel_execute`; each reads the live definition with
 * `pg_get_functiondef`, splices branches into it, and installs the result with
 * `EXECUTE`. So when 2775 added branches that call `public.trip_proposal_tally`
 * twice, the check saw a definer function referenced by nothing and demanded it
 * be DROPPED or ledgered as unreferenced. Both remedies were wrong: the drop
 * breaks proposal acceptance, and the ledger entry would have recorded a
 * sentence ("nothing references it") that is false.
 *
 * Two properties keep it honest, and this file pins both:
 *   1. a genuine transform IS an authoring site, and
 *   2. a DO block that merely CALLS a function is NOT — otherwise any
 *      postcondition assertion would buy a dead function a reference edge, and
 *      2774's postcondition calls trip_proposal_tally exactly once to check it
 *      answers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { transformedFunctionName } from "../scripts/lib/transformedFunction.js";
import { splitStatements, stripSqlComments } from "../scripts/lib/canonicalSchema.js";

const read = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8");

describe("transformedFunctionName — what counts as authoring a body", () => {
  it("a block that READS a definition and INSTALLS one is a transform", () => {
    const stmt = `DO $mig$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d FROM pg_proc p
   WHERE p.proname = 'trip_kernel_execute';
  d := replace(d, 'x', 'y');
  EXECUTE d;
END
$mig$`;
    assert.equal(transformedFunctionName(stmt), "trip_kernel_execute");
  });

  it("a block that only READS is not a transform — that is a precondition", () => {
    // Every one of these migrations opens with a $base$ block that reads the
    // definition purely to assert its ancestry. It installs nothing.
    const stmt = `DO $base$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d FROM pg_proc p
   WHERE p.proname = 'trip_kernel_execute';
  IF position('SET_TRIP_COVER' in d) = 0 THEN RAISE EXCEPTION 'stale'; END IF;
END
$base$`;
    assert.equal(transformedFunctionName(stmt), null);
  });

  it("a block that only CALLS a function buys it nothing", () => {
    // THE NARROWNESS THAT MATTERS. 2774's postcondition calls
    // trip_proposal_tally to prove it answers. If that counted, a genuinely
    // dead definer function could keep itself alive with its own postcondition.
    const stmt = `DO $post$
BEGIN
  IF (public.trip_proposal_tally('00000000-0000-0000-0000-000000000000')->>'found')::boolean
  THEN RAISE EXCEPTION 'tally claims a nonexistent proposal exists'; END IF;
END
$post$`;
    assert.equal(transformedFunctionName(stmt), null);
  });

  it("a plain statement is not a transform", () => {
    assert.equal(transformedFunctionName("SELECT pg_get_functiondef(1); EXECUTE d;"), null);
  });
});

describe("the real migrations — the edge actually resolves", () => {
  it("2775 has exactly one transform block, and it targets trip_kernel_execute", () => {
    const stmts = splitStatements(stripSqlComments(read("2775_trip_kernel_proposal_governance_and_apply.sql")));
    const targets = stmts.map((s) => transformedFunctionName(s.trim())).filter(Boolean);
    assert.deepEqual(targets, ["trip_kernel_execute"],
      "one authoring block per kernel migration — a second would mean two installs in one file");
  });

  it("the kernel 2775 installs really does call trip_proposal_tally", () => {
    // The premise of the whole fix. If this stops being true the reference edge
    // is a fiction and the check should go back to reporting the function.
    const stmts = splitStatements(stripSqlComments(read("2775_trip_kernel_proposal_governance_and_apply.sql")));
    const block = stmts.map((s) => s.trim()).find((s) => transformedFunctionName(s) !== null)!;
    assert.ok(block, "no transform block found in 2775");
    const calls = [...block.matchAll(/public\.trip_proposal_tally\s*\(/g)];
    assert.ok(calls.length >= 2,
      `expected the installed kernel to call trip_proposal_tally at least twice, found ${calls.length}`);
  });

  it("every Trips kernel transform migration is recognised as an authoring site", () => {
    // 2764-2777 are all the same shape. If one of them stopped matching, its
    // calls would silently vanish from the reference graph — the failure mode
    // this file exists for, one migration at a time.
    const files = [
      "2764_trip_kernel_stage_family.sql",
      "2765_trip_kernel_leg_and_commitment_families.sql",
      "2766_trip_kernel_goal_decision_risk_families.sql",
      "2768_trip_kernel_presence_proposal_outcome_families.sql",
      "2769_trip_kernel_participant_roles_and_terminal_lifecycle.sql",
      "2772_trip_kernel_plan_attendance_and_plan_version.sql",
      "2775_trip_kernel_proposal_governance_and_apply.sql",
      "2777_trip_kernel_presence_ordering.sql",
    ];
    for (const f of files) {
      const stmts = splitStatements(stripSqlComments(read(f)));
      const targets = stmts.map((s) => transformedFunctionName(s.trim())).filter(Boolean);
      assert.deepEqual(targets, ["trip_kernel_execute"], `${f} is not recognised as authoring the kernel`);
    }
  });
});
