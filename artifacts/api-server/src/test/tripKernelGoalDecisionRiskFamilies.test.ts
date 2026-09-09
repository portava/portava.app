/**
 * Trip Kernel — the §5.1 goal, decision-task and risk families
 * (census-trips TR84, TR85, TR86).
 *
 * The invariants every family shares are in tripKernelFamilyContract.test.ts,
 * which discovers the migrations rather than listing them. This file holds only
 * what is specific to 2766, which is two things: the assignee rule, and the
 * NOT NULL DEFAULT columns.
 *
 * Behaviour is db/harness/run.sh (a local PostgreSQL cluster), not this file —
 * no Supabase database carries the kernel these families build on
 * (docs/architecture/blocker-ledger.md, TRIP_KERNEL_NEVER_DEPLOYED).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  new URL("../migrations/2766_trip_kernel_goal_decision_risk_families.sql", import.meta.url),
  "utf8",
);
const ts = readFileSync(new URL("../lib/tripKernel.ts", import.meta.url), "utf8");

describe("§5.1 goal / decision-task / risk — the assignee rule", () => {
  it("both decision-task writes check the assignee is an accepted member", () => {
    // trip_decision_tasks.assigned_user_id references profiles, so the foreign
    // key proves the person exists and nothing more. A task assigned to someone
    // not on the trip is a task its assignee cannot see, cannot act on, and will
    // never be told about — a row that looks assigned and is not.
    const checks = sql.match(
      /NOT authz\.is_accepted_trip_member\(v_trip_id, \(v_(?:payload|patch)->>'assigned_user_id'\)::uuid\)/g,
    ) ?? [];
    assert.equal(checks.length, 2,
      "expected the assignee check on both ADD_DECISION_TASK and UPDATE_DECISION_TASK");
  });

  it("refuses with TRIP_ASSIGNEE_NOT_CREW, not TRIP_AUTH_NOT_CREW", () => {
    // The actor is authorised; the assignee is not. Collapsing the two would
    // show "you are not on this trip" to someone who is.
    assert.match(sql, /'reason', 'TRIP_ASSIGNEE_NOT_CREW'/);
    assert.ok(ts.includes('"TRIP_ASSIGNEE_NOT_CREW"'),
      "TRIP_ASSIGNEE_NOT_CREW is returned by SQL and missing from TripKernelReason");
    const authNotCrew = sql.match(/'reason', 'TRIP_AUTH_NOT_CREW'/g) ?? [];
    assert.equal(authNotCrew.length, 0,
      "this migration must not return the actor's refusal for an assignee problem");
  });

  it("checks the assignee only when one is given", () => {
    // assigned_user_id is nullable; an unassigned task is a legitimate state and
    // must not be refused for having no crew member to check.
    const guarded = sql.match(/\(v_(?:payload|patch)->>'assigned_user_id'\) IS NOT NULL\n\s*AND NOT authz\.is_accepted_trip_member/g) ?? [];
    assert.equal(guarded.length, 2, "an unassigned task would be refused");
  });
});

describe("§5.1 goal / decision-task / risk — NOT NULL DEFAULT columns", () => {
  // priority, status, evidence_json, trigger_json and mitigation_json are all
  // NOT NULL with a default. Passing v_payload->>'status' straight through sends
  // NULL when the key is absent, the NOT NULL refuses it, and the client is told
  // TRIP_COMMAND_MALFORMED about a payload that was never malformed.
  const DEFAULTED: ReadonlyArray<readonly [string, string]> = [
    ["priority", "'normal'"],
    ["status", "'open'"],
    ["evidence_json", "'{}'::jsonb"],
    ["trigger_json", "'{}'::jsonb"],
    ["mitigation_json", "'{}'::jsonb"],
  ];

  for (const [col, def] of DEFAULTED) {
    it(`${col} falls back to ${def} rather than writing NULL`, () => {
      assert.ok(sql.includes(`coalesce((v_payload->${col.endsWith("_json") ? "" : ">"}'${col}'), ${def})`),
        `${col} is not coalesced to its table default on insert`);
    });
  }

  it("jsonb columns take the sub-object, never its text rendering", () => {
    // ->> on a jsonb column stringifies {"a":1} into the text '{"a": 1}', which
    // then casts back to a jsonb STRING rather than an object, and the
    // jsonb_typeof(...) = 'object' CHECK refuses it.
    for (const col of ["evidence_json", "trigger_json", "mitigation_json"]) {
      assert.ok(!sql.includes(`v_payload->>'${col}'`),
        `${col} is read with ->>, which stringifies the object`);
      assert.ok(!sql.includes(`v_patch->>'${col}'`),
        `${col} is patched with ->>, which stringifies the object`);
      assert.ok(sql.includes(`v_payload->'${col}'`), `${col} is not read from the payload at all`);
    }
  });

  it("the required keys are checked before any write, not by the NOT NULL", () => {
    for (const required of ["type", "likelihood", "impact"]) {
      assert.ok(sql.includes(`coalesce(v_payload->>'${required}','') = ''`),
        `${required} is left to the NOT NULL constraint instead of being validated`);
    }
  });
});
