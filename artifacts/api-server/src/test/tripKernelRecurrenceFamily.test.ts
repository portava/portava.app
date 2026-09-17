/**
 * Trips spec §23 "Long-stay 45 days" — the recurrence family (2797 / 2798 /
 * 2799), census-trips TR427.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE, SAID FIRST
 * ===============================================
 * Behaviour lives in plpgsql and is exercised by db/harness/run.sh
 * (probe_recurrence_family.sql, probe_recurrence_fold.sql), a local PostgreSQL
 * cluster, because no Supabase database carries the kernel these families are
 * built on (docs/architecture/blocker-ledger.md, TRIP_KERNEL_NEVER_DEPLOYED).
 * That harness is not part of `npm test` — it needs a PostgreSQL installation.
 *
 * This file pins the CONTRACT: that the command types, the event vocabulary and
 * the refusal reasons agree between TypeScript and the migrations, and that the
 * SCHEMA still says what the read side assumes it says. The division matters —
 * a contract test checks that two files agree on a NAME and cannot check what
 * the name does (2765's header records the defect that taught this codebase
 * the difference).
 *
 * It also holds the one structural guarantee the whole feature rests on: that
 * NOTHING MATERIALISES AN OCCURRENCE. That is checkable from the text, because
 * materialising would mean a table, a column or an INSERT that is not there.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { TRIP_EVENT_TYPES, tripCommandFamily, type TripCommandType } from "../domain/trips/commands/tripKernel.js";
import { MAX_HORIZON_DAYS } from "../domain/trips/invariants/TripRecurrence.js";

const read = (f: string): string => readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8");
const schema = read("2797_trip_commitment_recurrences.sql");
const kernel = read("2798_trip_kernel_recurrence_family.sql");
const fold = read("2799_trip_snapshot_fold_recurrence_vocabulary.sql");
const ts = readFileSync(new URL("../domain/trips/commands/tripKernel.ts", import.meta.url), "utf8");

const COMMANDS = [
  "ADD_RECURRING_COMMITMENT", "UPDATE_RECURRING_COMMITMENT", "REMOVE_RECURRING_COMMITMENT",
  "SKIP_RECURRENCE_OCCURRENCE", "UNSKIP_RECURRENCE_OCCURRENCE",
] as const;
const EVENTS = [
  "trip.recurring_commitment_added", "trip.recurring_commitment_updated", "trip.recurring_commitment_removed",
  "trip.recurrence_occurrence_skipped", "trip.recurrence_occurrence_restored",
] as const;
const REASONS = [
  "TRIP_RECURRENCE_NOT_FOUND", "TRIP_RECURRENCE_TIMEZONE_UNKNOWN",
  "TRIP_RECURRENCE_RANGE_TOO_LONG", "TRIP_RECURRENCE_DATE_OUT_OF_RANGE",
] as const;

describe("§23 recurrence family — TypeScript and the migration agree", () => {
  it("every command the migration dispatches is declared in TypeScript", () => {
    for (const cmd of COMMANDS) {
      assert.ok(kernel.includes(`'${cmd}'`), `${cmd} missing from 2798`);
      assert.ok(ts.includes(`"${cmd}"`), `${cmd} missing from TripCommandType`);
    }
  });

  it("every command is in the 'recurrence' family, so its events are filed under it", () => {
    for (const cmd of COMMANDS) {
      assert.equal(tripCommandFamily(cmd as TripCommandType), "recurrence", cmd);
      // 2764's defect class: a branch that sets v_event_type and not v_family
      // files every event under 'plan'. The migration's own postcondition counts
      // these; this is the TypeScript half agreeing about how many there are.
    }
    const assignments = kernel.match(/v_family {5}:= 'recurrence';/g) ?? [];
    assert.equal(assignments.length, COMMANDS.length,
      "the migration's family assignments and the command list have drifted apart");
  });

  it("every event the migration emits is in TRIP_EVENT_TYPES", () => {
    for (const evt of EVENTS) {
      assert.ok(kernel.includes(`'${evt}'`), `${evt} not emitted by 2798`);
      assert.ok((TRIP_EVENT_TYPES as readonly string[]).includes(evt),
        `${evt} is emitted by SQL and unknown to every consumer`);
    }
  });

  it("every event is named by the snapshot fold, so none lands in `unfolded`", () => {
    // 2787's header states the failure mode: an unnamed type leaves the replay
    // agreeing with itself while the snapshot is quietly wrong.
    for (const evt of EVENTS) assert.ok(fold.includes(`'${evt}'`), `${evt} is not named in 2799`);
  });

  it("every refusal reason the migration returns is declared in TypeScript", () => {
    for (const reason of REASONS) {
      assert.ok(kernel.includes(`'${reason}'`), `${reason} not returned by 2798`);
      assert.ok(ts.includes(`"${reason}"`), `${reason} missing from TripKernelReason`);
    }
  });

  it("the capability is crew for all five, like every other §5 family", () => {
    for (const cmd of COMMANDS) {
      assert.ok(kernel.includes(`WHEN '${cmd}' THEN 'crew'`), `${cmd} has no crew capability dispatch`);
    }
  });
});

describe("§23 — the transform is a transform, and refuses the wrong base", () => {
  it("2798 asserts its base before it edits anything", () => {
    assert.match(kernel, /predates 2765 \(no commitment family\)/,
      "2798 does not refuse a kernel without the commitment family it anchors on");
    assert.match(kernel, /requires 2797 \(trip_commitment_recurrences\)/,
      "2798 does not refuse a database without the table it writes");
    assert.match(kernel, /already present; this migration is not idempotent by design/);
  });

  it("every anchor is counted before it is replaced", () => {
    // 2764's method. A replace() whose anchor occurs twice edits both and a
    // replace() whose anchor is gone edits nothing; both are silent.
    for (const anchor of ["v_commit_id", "ADD_COMMITMENT dispatch", "ADD_COMMITMENT branch"]) {
      assert.ok(kernel.includes(`anchor ${anchor} occurs % times, expected 1`),
        `the ${anchor} anchor is not counted`);
    }
    assert.match(kernel, /the transform added % command branches, expected exactly 5/);
  });

  it("what the transform did not name, its postconditions prove it did not move", () => {
    for (const survivor of ["TRIP_VERSION_CONFLICT", "authz.is_accepted_trip_member",
                            "trip_command_receipts", "trip_outbox", "CREATE_TRIP"]) {
      assert.ok(kernel.includes(`'${survivor}'`), `${survivor} is not checked after apply`);
    }
    assert.match(kernel, /2765''s 3 commitment-family assignments became/);
    assert.match(kernel, /2764''s 3 stage-family assignments became/);
  });

  it("the rollback is the inverse transform and refuses the wrong order", () => {
    const rb = readFileSync(
      new URL("../../../../db/rollback/2026-09-17-2798-trip-kernel-recurrence-family-rollback.sql", import.meta.url), "utf8");
    assert.match(rb, /the excision removed % command branches, expected exactly 5/);
    assert.match(rb, /the commitment family is gone, so the excision has no terminator/);
    assert.ok(!/CREATE OR REPLACE FUNCTION public\.trip_kernel_execute/.test(rb),
      "the rollback re-creates the function instead of reversing named edits");
  });
});

describe("§23 — 'no bloated itinerary model' is a structural guarantee", () => {
  it("nothing materialises an occurrence: no table, no column, no second INSERT", () => {
    // The migration asserts all three itself, at apply time, over the LIVE
    // catalogue. This checks the assertions are still in the file, because a
    // guarantee nobody re-checks is a guarantee that decays.
    assert.match(schema, /an occurrence table exists \(%\)/);
    assert.match(schema, /materialisation column\(s\) on the rule table/);
    assert.match(schema, /trigger\(s\) on the rule table; a rule must not write anything/);
    assert.match(kernel, /expected exactly 1 INSERT INTO trip_commitments \(2765''s\), found % — an occurrence is being materialised/);
  });

  it("there is no MATERIALISE command, and no command writes commitments from a rule", () => {
    const anyCommand = /'(?:[A-Z_]*MATERIALI[SZ]E[A-Z_]*|EXPAND_[A-Z_]+)'/;
    assert.ok(!anyCommand.test(kernel), "2798 declares a materialise/expand command");
    assert.ok(!anyCommand.test(ts), "tripKernel.ts declares a materialise/expand command");
  });

  it("the write-time cap and the read-time horizon are both real numbers, and differ on purpose", () => {
    assert.match(kernel, /TRIP_RECURRENCE_RANGE_TOO_LONG/);
    assert.match(kernel, /'max_days', 400/);
    assert.ok(MAX_HORIZON_DAYS < 400,
      "the read horizon is not tighter than the write cap; a reader could then ask for a whole rule at once");
  });
});

describe("§23 — the schema says what the read side assumes", () => {
  it("the wall-clock columns are time/date/date, and the migration proves it after apply", () => {
    assert.match(schema, /local_time\s+time\b/);
    assert.match(schema, /effective_from\s+date\s+NOT NULL/);
    assert.match(schema, /effective_until\s+date\s+NOT NULL/);
    assert.match(schema, /the wall-clock columns are not time\/date\/date/,
      "nothing holds a later migration to the wall-clock model");
  });

  it("RLS on, exactly one policy, SELECT only, no client write grants", () => {
    assert.match(schema, /ALTER TABLE public\.trip_commitment_recurrences ENABLE ROW LEVEL SECURITY;/);
    assert.match(schema, /CREATE POLICY trip_commitment_recurrences_select_crew[\s\S]*?FOR SELECT USING \(authz\.is_trip_crew\(trip_id\)\)/);
    assert.match(schema, /REVOKE ALL ON public\.trip_commitment_recurrences FROM PUBLIC, anon, authenticated;/);
    assert.match(schema, /GRANT SELECT ON public\.trip_commitment_recurrences TO authenticated;/);
    assert.match(schema, /authenticated holds a write privilege/);
    assert.match(schema, /expected 1 policy, found %/);
    assert.match(schema, /anon can SELECT/);
  });

  it("the type and flexibility vocabularies are 2761's, and the migration refuses if they drift", () => {
    assert.match(schema, /CHECK \(type IN \('lodging','transport','event','booking','meeting','other'\)\)/);
    assert.match(schema, /CHECK \(flexibility IN \('fixed','shiftable','flexible'\)\)/);
    assert.match(schema, /trip_commitments_type_known is not 2761''s list/);
  });

  it("the CHECK constraints are PROVEN TO REFUSE, not merely declared", () => {
    // The postcondition builds a temp table LIKE the real one and runs probes
    // through the real predicates. These are the cases the read side would
    // otherwise have to defend against in TypeScript.
    for (const probe of ["a DUPLICATE weekday was accepted",
                         "an UNSORTED weekday list was accepted",
                         "weekday 8 was accepted",
                         "an EMPTY weekday list was accepted for a weekly rule",
                         "a weekly rule with NO weekdays was accepted",
                         "a DAILY rule carrying weekdays was accepted",
                         "an INVERTED effective range was accepted",
                         "a NEGATIVE prep_duration was accepted",
                         "interval_count 0 was accepted",
                         "a UTC OFFSET was accepted as a timezone",
                         "a NULL skip date was accepted"]) {
      assert.ok(schema.includes(probe), `the postconditions do not probe: ${probe}`);
    }
    assert.match(schema, /the probe table holds % rows, expected exactly 2/,
      "nothing counts the rows the probes left behind, so a probe that silently succeeded would pass");
  });

  it("the columns the expander reads are the columns the postcondition counts", () => {
    for (const col of ["timezone", "freq", "interval_count", "by_weekday", "local_time",
                       "effective_from", "effective_until", "skip_dates", "arrival_lead"]) {
      assert.ok(schema.includes(`'${col}'`), `${col} is not in the postcondition's column set`);
    }
    assert.match(schema, /expected the 9 rule columns, found %/);
  });
});
