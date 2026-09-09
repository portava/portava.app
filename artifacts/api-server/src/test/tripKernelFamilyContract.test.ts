/**
 * Trip Kernel — the invariants EVERY §5 command family must satisfy.
 *
 * The per-family tests (tripKernelStageFamily, tripKernelLegCommitmentFamilies,
 * tripKernelGoalDecisionRiskFamilies) pin what is specific to each. This file
 * pins what is common, and it discovers the migrations rather than listing them,
 * so a family added later is held to the same rules without anyone remembering
 * to add it here.
 *
 * The rules exist because each was broken once:
 *   * v_family — 2764's first draft set v_event_type on all three branches and
 *     v_family on none, so every stage event was filed under the plan family.
 *     Seven contract tests passed on that draft; the local PostgreSQL harness
 *     found it by executing the command.
 *   * the base assertion — 2764 was pointed at portava-ci, whose kernel predates
 *     2590. Without the assertion it would have applied cleanly and produced a
 *     kernel missing three migrations' worth of commands.
 *   * the branch-count invariant — the 2764 rollback's overrun postcondition
 *     could not be tested until the count was added; a mutation that excised one
 *     branch too many is now caught by name and number.
 *
 * What this file CANNOT do is check behaviour: it reads SQL as text. Behaviour
 * is db/harness/run.sh, which is not part of `npm test`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { TRIP_EVENT_TYPES } from "../lib/tripKernel.js";

const MIG_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const ROLLBACK_DIR = fileURLToPath(new URL("../../../../db/rollback/", import.meta.url));
const ts = readFileSync(new URL("../lib/tripKernel.ts", import.meta.url), "utf8");

/**
 * Every migration that changes trip_kernel_execute falls into exactly one of two
 * kinds, and the difference is the whole reason this file exists:
 *
 *   RESTATEMENT — 2420, 2450, 2500, 2590. Each writes the function out in full
 *   (707 lines by 2590). Safe to read, expensive to review, and it silently
 *   discards anything a later migration added.
 *
 *   TRANSFORM — 2764 onward. Each reads the deployed definition, asserts its
 *   anchors, replaces only those, and EXECUTEs the result. It cannot discard
 *   what it does not name, and it cannot be reviewed by reading the file alone.
 *
 * The invariants below apply to TRANSFORMS. Classifying by CONTENT rather than
 * by a filename glob means a family added later is caught by the same rules, and
 * the "exactly one kind" assertion means a migration cannot escape both.
 */
const KERNEL_MIGRATIONS = readdirSync(MIG_DIR).filter((f) => /trip_kernel/.test(f)).sort();
const isTransform = (sql: string) =>
  sql.includes("pg_get_functiondef") && /EXECUTE\s+d;/.test(sql);
const isRestatement = (sql: string) =>
  sql.includes("CREATE OR REPLACE FUNCTION public.trip_kernel_execute");

const CLASSIFIED = KERNEL_MIGRATIONS.map((f) => {
  const sql = readFileSync(MIG_DIR + f, "utf8");
  return { file: f, sql, transform: isTransform(sql), restatement: isRestatement(sql) };
});
const FAMILY_MIGRATIONS = CLASSIFIED.filter((c) => c.transform).map((c) => c.file);

const rollbacks = readdirSync(ROLLBACK_DIR);

describe("every §5 kernel family migration", () => {
  it("every kernel migration is exactly one of a transform or a restatement", () => {
    for (const c of CLASSIFIED) {
      assert.ok(c.transform !== c.restatement,
        `${c.file} is ${c.transform && c.restatement ? "both" : "neither"} a transform nor a restatement — ` +
        "it changes the kernel in a way this file does not know how to hold to any rule");
    }
  });

  it("there is at least one transform, or this file is silently vacuous", () => {
    assert.ok(FAMILY_MIGRATIONS.length >= 3,
      `found ${FAMILY_MIGRATIONS.length} transforms among ${KERNEL_MIGRATIONS.length} kernel migrations; the classifier has stopped matching`);
  });

  for (const { file, sql } of CLASSIFIED.filter((c) => c.transform)) {
    const prefix = file.slice(0, 4);

    describe(file, () => {
      it("sets v_family on every branch that emits an event", () => {
        const events = sql.match(/v_event_type := '(trip\.[a-z_]+)'/g) ?? [];
        assert.ok(events.length > 0, "emits no events at all");
        for (const m of events) {
          const idx = sql.indexOf(m);
          const preceding = sql.slice(Math.max(0, idx - 140), idx);
          assert.match(preceding, /v_family\s+:= '[a-z_]+';/,
            `${m} is emitted with no v_family set immediately before it — the event would be filed under the previous branch's family`);
        }
      });

      it("counts its own family assignments in a postcondition", () => {
        // Matched on SUBSTANCE, not on one migration's wording: the check must
        // count occurrences of the v_family assignment IN THE INSTALLED
        // DEFINITION, so a dropped assignment is refused at apply time and not
        // only by a source-reading test like this one.
        assert.match(sql, /family assignments/,
          "no postcondition counts the family assignments, so a dropped one applies silently");
        assert.match(sql, /length\(replace\(d, E?'v_family/,
          "the family count is not derived from the installed definition, so it proves nothing about what was applied");
      });

      it("refuses a base that is not the kernel it transforms", () => {
        assert.match(sql, /predates 2590/,
          "no base assertion: this would apply to a 2420 kernel and produce a wrong function");
        assert.match(sql, /RAISE EXCEPTION/);
      });

      it("asserts each anchor occurs exactly once before replacing it", () => {
        const anchorChecks = sql.match(/occurs % times, expected 1/g) ?? [];
        assert.ok(anchorChecks.length >= 3,
          `found ${anchorChecks.length} exactly-once anchor assertions, expected at least 3 (declaration, dispatch, branches)`);
      });

      it("pins the number of branches it adds", () => {
        assert.match(sql, /command branches, expected exactly \d+/,
          "no branch-count invariant: an insert landing in the wrong place would pass every other check");
      });

      it("declares itself non-idempotent rather than applying twice", () => {
        assert.match(sql, /is already present; this migration is not idempotent by design/);
      });

      it("checks that what it did not name survived", () => {
        for (const survivor of ["TRIP_VERSION_CONFLICT", "authz.is_accepted_trip_member",
                                "trip_command_receipts", "trip_outbox"]) {
          assert.ok(sql.includes(survivor),
            `${survivor} is not checked for survival; a careless transform would drop it silently`);
        }
      });

      it("has a rollback, named for it, that is an inverse transform", () => {
        const rb = rollbacks.find((r) => r.includes(`-${prefix}-`));
        assert.ok(rb, `no rollback file mentions ${prefix}; a migration that cannot be withdrawn`);
        const body = readFileSync(ROLLBACK_DIR + rb!, "utf8");
        assert.match(body, /command branches, expected exactly \d+/,
          "the rollback does not pin how many branches it removes, so an overrun passes");
        assert.match(body, /the excision overran/,
          "the rollback has no overrun postcondition");
        assert.ok(body.includes("pg_get_functiondef"),
          "the rollback re-creates the body instead of reversing named edits, which discards later migrations");
      });

      it("emits only events TypeScript knows about, and declares only reasons it returns", () => {
        const events = [...sql.matchAll(/v_event_type := '(trip\.[a-z_]+)'/g)].map((m) => m[1]);
        for (const evt of new Set(events)) {
          assert.ok((TRIP_EVENT_TYPES as readonly string[]).includes(evt),
            `${evt} is emitted by SQL and unknown to every consumer`);
        }
        const reasons = [...sql.matchAll(/'reason',\s*'(TRIP_[A-Z_]+)'/g)].map((m) => m[1]);
        for (const reason of new Set(reasons)) {
          assert.ok(ts.includes(`"${reason}"`),
            `${reason} is returned by SQL and missing from TripKernelReason`);
        }
      });
    });
  }
});
