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

import { TRIP_EVENT_TYPES } from "../domain/trips/commands/tripKernel.js";

const MIG_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const ROLLBACK_DIR = fileURLToPath(new URL("../../../../db/rollback/", import.meta.url));
const ts = readFileSync(new URL("../domain/trips/commands/tripKernel.ts", import.meta.url), "utf8");

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

/**
 * Transforms come in two kinds and the rules differ:
 *
 *   FAMILY — adds command branches and emits events (2764 onward). Everything
 *   below applies.
 *
 *   CORRECTION — changes behaviour inside branches that already exist and adds
 *   none (2769). It has no events to attribute and no branches to count on the
 *   way in, so those two rules are skipped; every other rule still applies, and
 *   it must still pin the branch count as UNCHANGED, which is the same
 *   invariant with a different number.
 *
 * Discriminated by whether the migration emits an event, not by its filename.
 */
const CLASSIFIED = KERNEL_MIGRATIONS.map((f) => {
  const sql = readFileSync(MIG_DIR + f, "utf8");
  const transform = isTransform(sql);
  return {
    file: f, sql, transform,
    restatement: isRestatement(sql),
    // A FAMILY migration AUTHORS branches, and authored branches live in a
    // $branches$ block. Discriminating on `v_event_type :=` was wrong: a
    // correction migration QUOTES an existing branch's event assignment as an
    // anchor (2777 quotes SET_PRESENCE's), which made it look like a family.
    family: transform && /\$branches\$/.test(sql),
  };
});
const FAMILY_MIGRATIONS = CLASSIFIED.filter((c) => c.family).map((c) => c.file);

/**
 * A RE-ISSUE is a transform that ORDER_OVERRIDES.json names as superseding a
 * SKIPPED kernel transform (3979 for 3974, which the live applier could not
 * apply but portava-ci had already committed). It must be a verified no-op where
 * the skipped file ran, so "refuse when already present" cannot hold for it.
 * It is held to a stricter rule instead: the command it installs is the skipped
 * file's, byte for byte, and an installed command is accepted only after it is
 * proven to be that exact text — anything else is refused, never adopted.
 * Discriminated by ORDER_OVERRIDES.json, not by filename, and the skipped file
 * stays in KERNEL_MIGRATIONS, so it is still held to every rule above.
 */
const ORDER_OVERRIDES = JSON.parse(readFileSync(MIG_DIR + "ORDER_OVERRIDES.json", "utf8")) as {
  overrides: Array<{ skip?: string; superseded_by?: string[] }>;
};
const REISSUE_OF = new Map<string, string>();
for (const o of ORDER_OVERRIDES.overrides) {
  if (o.skip && /trip_kernel/.test(o.skip)) {
    for (const s of o.superseded_by ?? []) REISSUE_OF.set(s, o.skip);
  }
}
const branchesBlock = (sql: string) => sql.match(/\$branches\$([\s\S]*?)\$branches\$/)?.[1];

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

  for (const { file, sql, family } of CLASSIFIED.filter((c) => c.transform)) {
    const prefix = file.slice(0, 4);

    describe(file, () => {
      // Unconditional, deliberately. This was `{ skip: !family }` until
      // 2026-09-09, which meant a CORRECTION migration that authored an
      // unfamilied event emission was waved through by the one rule written to
      // catch exactly that — and a skipped test asserts nothing, so nothing
      // said so. The two kinds get different SCOPES, not different amounts of
      // scrutiny.
      it("every event emission it authors sets v_family immediately before it", () => {
        // Scope for a FAMILY migration is the $branches$ block ONLY — the code
        // it AUTHORS. Outside it, a `v_event_type := '...'` is an ANCHOR the
        // migration quotes in order to find pre-existing code (2772 quotes
        // ADD_PLAN's), and those branches set v_family before the CASE. Scanning
        // the whole file confuses the two and fails on a correct migration.
        //
        // A CORRECTION authors no $branches$ block, so its scope is the whole
        // file: every event assignment it writes — as an anchor it matches or as
        // the replacement it installs — must carry its family. 2777's presence
        // anchor and its replacement both do; 2769 writes none at all, and the
        // classification assertion below is what makes that a fact rather than
        // an assumption.
        const authored = sql.match(/\$branches\$([\s\S]*?)\$branches\$/);
        assert.equal(Boolean(authored), family,
          authored
            ? `${file} is classified a correction but authored a $branches$ block`
            : `${file} is classified a family migration but has no $branches$ block`);
        const body = authored ? authored[1] : sql;
        // matchAll, not match+indexOf: two branches emitting the SAME event type
        // both resolve to the first occurrence under indexOf, so the second one
        // was never checked. Real indices check every occurrence.
        const events = [...body.matchAll(/v_event_type := '(trip\.[a-z_]+)'/g)];
        if (family) {
          assert.ok(events.length > 0, "the authored branches emit no events at all");
        }
        for (const m of events) {
          const preceding = body.slice(Math.max(0, m.index - 140), m.index);
          assert.match(preceding, /v_family\s+:= '[a-z_]+';/,
            `${m[0]} is emitted with no v_family set immediately before it — the event would be filed under the previous branch's family`);
        }
      });

      // Also unconditional. A correction has no family of its OWN, but it must
      // still pin the family-assignment count as UNCHANGED — the same invariant
      // with a different number — and both corrections (2769, 2777) already do,
      // so skipping this for them protected nothing.
      it("counts family assignments in a postcondition, derived from the installed definition", () => {
        // Matched on SUBSTANCE, not on one migration's wording: the check must
        // count occurrences of the v_family assignment IN THE INSTALLED
        // DEFINITION, so a dropped assignment is refused at apply time and not
        // only by a source-reading test like this one.
        assert.match(sql, /family assignments/,
          "no postcondition counts the family assignments, so a dropped one applies silently");
        // `d` is the installed definition. A count taken on an alignment-
        // normalised copy of it (`dn := regexp_replace(d, …)` — 3979, which
        // EXECUTEs d and so cannot normalise it in place) is the same
        // measurement of the same text; a count of anything not derived from
        // `d` still fails.
        const derived = /length\(replace\(d, E?'v_family/.test(sql)
          || (/\bdn := regexp_replace\(d, /.test(sql) && /length\(replace\(dn, E?'v_family/.test(sql));
        assert.ok(derived,
          "the family count is not derived from the installed definition, so it proves nothing about what was applied");
      });

      it("refuses a base that is not the kernel it transforms", () => {
        assert.match(sql, /predates \d+|installed kernel is missing|installed kernel has no/,
          "no base assertion: this would apply to a 2420 kernel and produce a wrong function");
        assert.match(sql, /RAISE EXCEPTION/);
      });

      it("asserts each anchor occurs exactly once before replacing it", () => {
        const anchorChecks = sql.match(/occurs % times, expected 1/g) ?? [];
        assert.ok(anchorChecks.length >= 3,
          `found ${anchorChecks.length} exactly-once anchor assertions, expected at least 3 (declaration, dispatch, branches)`);
      });

      it("pins the command-branch count, counted from the installed definition", () => {
        // Substance, not wording: the count must be derived from the function
        // actually installed. A correction migration pins it as UNCHANGED,
        // which is the same invariant with a different number — and it is the
        // check that catches an anchor matching somewhere unintended.
        assert.match(sql, /length\(replace\(d, E'\\n      WHEN/,
          "the branch count is not computed from the installed definition");
        // Singular OR plural: 2775 adds one command branch and one capability
        // arm, and says so in those words. The invariant is the count being
        // pinned, not the grammar.
        assert.match(sql, /command branch(es)?/,
          "no branch-count invariant is asserted at all");
      });

      const skipped = REISSUE_OF.get(file);
      if (!skipped) {
        it("declares itself non-idempotent rather than applying twice", () => {
          assert.match(sql, /(is already present|already applied); this migration is not idempotent by design/);
        });
      } else {
        it(`is a re-issue of ${skipped}: the same command, and adopts an installed one only on exact-text proof`, () => {
          const orig = readFileSync(MIG_DIR + skipped, "utf8");
          assert.ok(isTransform(orig), `${skipped} is not a kernel transform; a re-issue must supersede one`);
          // The skipped file is still held to the non-idempotent rule above.
          assert.match(orig, /(is already present|already applied); this migration is not idempotent by design/);
          const mine = branchesBlock(sql);
          assert.ok(mine, `${file} authors no $branches$ block`);
          assert.equal(mine, branchesBlock(orig),
            `${file}'s authored branch is not ${skipped}'s byte for byte; a re-issue that changes the command is a new migration`);
          const sp = skipped.slice(0, 4);
          const noticeRe = new RegExp(`RAISE NOTICE '(?:[^']|'')*installed exactly as ${sp} wrote it; nothing to do`);
          assert.match(sql, noticeRe,
            "no exact-text proof before the no-op: an installed command of any shape would be adopted");
          const refuseRe = /RAISE EXCEPTION '(?:[^']|'')*refusing to adopt it/;
          assert.match(sql, refuseRe,
            "an installed command that is not the skipped file's text is not refused");
          // The no-op path must sit behind the proof: from the "already
          // installed" test to the RETURN, the refusal and then the notice come
          // first, and no other RETURN precedes them.
          const gate = sql.search(/IF position\('[A-Z_]+' in d\) > 0 THEN/);
          const refuse = sql.search(refuseRe);
          const notice = sql.search(noticeRe);
          const ret = sql.indexOf("RETURN;", gate);
          assert.ok(gate > 0 && refuse > gate && notice > refuse && ret > notice,
            "the no-op RETURN is reachable without passing the exact-text checks");
        });
      }

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
        assert.match(body, /length\(replace\(d, E'\\n      WHEN/,
          "the rollback does not count command branches from the installed definition, so an overrun passes");
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
