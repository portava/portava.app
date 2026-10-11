/**
 * Trips v4 §5.1 `trips.current_stage_id` and `trips.home_timezone` (migration
 * 3768, census-trips TR77, §92).
 *
 * What this file pins, and what it cannot:
 *  - the PURE decisions: which stage Today is in, what counts as a time zone
 *    name, and which read error means "3768 is not applied here";
 *  - the CONTRACT between 3768 and the server. The pointer has kernel writers
 *    only. It is never in UPDATE_TRIP's allow-list. The transform adds no
 *    command branch. The rollback exists and removes every insertion.
 * The kernel's BEHAVIOUR is plpgsql. It is executed by
 * src/test/db/tripCurrentStageHomeTimezone.db.test.ts in CI's database job,
 * and by the PGlite rehearsal recorded in census-trips §92.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

import {
  chooseTodayStage, isIanaTimeZoneName, isTripStageAnchorsAbsent, readTripStageAnchors,
  type TripStageAnchors,
} from "../domain/trips/services/tripStageAnchors.js";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const stages = [
  { id: "s1", sequence: 1, starts_at: "2026-10-10T00:00:00Z", ends_at: "2026-10-12T00:00:00Z" },
  { id: "s2", sequence: 2, starts_at: null, ends_at: null },
];
const on = (currentStageId: string | null): TripStageAnchors => ({ available: true, currentStageId, homeTimezone: null });
const off: TripStageAnchors = { available: false, reason: "TRIP_STAGE_ANCHORS_NOT_IN_SCHEMA" };

describe("chooseTodayStage — the started stage outranks the interval rule", () => {
  it("a started stage wins even when another stage's interval contains now", () => {
    const r = chooseTodayStage(stages, on("s2"), NOW);
    assert.equal(r.stage?.id, "s2");
    assert.equal(r.stageReading, "stage s2 (sequence 2) is the trip's started stage");
  });
  it("no stage started: the interval rule, with the pre-3768 reading verbatim", () => {
    const r = chooseTodayStage(stages, on(null), NOW);
    assert.equal(r.stage?.id, "s1");
    assert.equal(r.stageReading, "stage s1 (sequence 1) contains now");
  });
  it("3768 unapplied: the interval rule, and the reading says why the pointer did not decide", () => {
    const r = chooseTodayStage(stages, off, NOW);
    assert.equal(r.stage?.id, "s1");
    assert.equal(r.stageReading, "this database has no current-stage pointer (3768 unapplied); stage s1 (sequence 1) contains now");
  });
  it("a pointer naming a stage this read did not return is reported, not trusted", () => {
    const r = chooseTodayStage(stages, on("gone"), NOW);
    assert.equal(r.stage?.id, "s1");
    assert.match(r.stageReading, /^the current-stage pointer names gone, which this read did not return; /);
  });
  it("no stages / no containing interval keep their readings", () => {
    assert.equal(chooseTodayStage([], on(null), NOW).stageReading, "the trip has no stages");
    assert.equal(chooseTodayStage([stages[1]!], on(null), NOW).stageReading, "no stage's interval contains now");
    assert.equal(chooseTodayStage([stages[1]!], on(null), NOW).stage, null);
  });
});

describe("isIanaTimeZoneName — the route's early refusal (the kernel's pg_timezone_names is the authority)", () => {
  for (const ok of ["America/New_York", "Europe/Lisbon", "UTC", "Etc/GMT+5", "America/Argentina/Buenos_Aires", "Asia/Ho_Chi_Minh"]) {
    it(`admits ${ok}`, () => assert.equal(isIanaTimeZoneName(ok), true));
  }
  for (const bad of ["", "UTC+3", "+05:00", "-03:00", "Mars/Olympus_Mons", "Europe/Lisbon; DROP", "/Europe", "Europe//Lisbon", "x".repeat(65)]) {
    it(`refuses ${JSON.stringify(bad).slice(0, 20)}`, () => assert.equal(isIanaTimeZoneName(bad), false));
  }
});

describe("isTripStageAnchorsAbsent — only an undefined-column error naming 3768's columns", () => {
  it("42703 / PGRST204 naming either column: absent", () => {
    assert.equal(isTripStageAnchorsAbsent({ code: "42703", message: "column trips.current_stage_id does not exist" }), true);
    assert.equal(isTripStageAnchorsAbsent({ code: "PGRST204", message: "Could not find the 'home_timezone' column of 'trips' in the schema cache" }), true);
  });
  it("an undefined column that is NOT 3768's, or any other error, is not absence", () => {
    assert.equal(isTripStageAnchorsAbsent({ code: "42703", message: "column trips.owner_user_id does not exist" }), false);
    assert.equal(isTripStageAnchorsAbsent({ code: "57014", message: "current_stage_id timeout" }), false);
    assert.equal(isTripStageAnchorsAbsent(null), false);
  });
});

describe("readTripStageAnchors", () => {
  const client = (answer: { data: unknown; error: unknown }) => {
    const calls: string[] = [];
    const f: any = {
      from: (t: string) => { calls.push(`from:${t}`); return f; },
      select: (c: string) => { calls.push(`select:${c}`); return f; },
      eq: (c: string, v: string) => { calls.push(`eq:${c}=${v}`); return f; },
      maybeSingle: async () => answer,
    };
    return { sc: f, calls };
  };
  it("reads the two columns of THIS trip from trips", async () => {
    const { sc, calls } = client({ data: { current_stage_id: "s2", home_timezone: "Europe/Lisbon" }, error: null });
    const r = await readTripStageAnchors(sc, "t1");
    assert.deepEqual(r, { ok: true, anchors: { available: true, currentStageId: "s2", homeTimezone: "Europe/Lisbon" } });
    assert.deepEqual(calls, ["from:trips", "select:current_stage_id, home_timezone", "eq:id=t1"]);
  });
  it("absent columns -> available:false; another error -> not ok; no row -> not ok (never a pair of nulls)", async () => {
    let r = await readTripStageAnchors(client({ data: null, error: { code: "42703", message: "column trips.home_timezone does not exist" } }).sc, "t1");
    assert.deepEqual(r, { ok: true, anchors: { available: false, reason: "TRIP_STAGE_ANCHORS_NOT_IN_SCHEMA" } });
    r = await readTripStageAnchors(client({ data: null, error: { code: "57014", message: "timeout" } }).sc, "t1");
    assert.equal(r.ok, false);
    r = await readTripStageAnchors(client({ data: null, error: null }).sc, "t1");
    assert.equal(r.ok, false);
  });
});

describe("3768 — the migration's contract with the server", () => {
  const sql = readFileSync(new URL("../migrations/3768_trips_current_stage_and_home_timezone.sql", import.meta.url), "utf8");
  const rbUrl = new URL("../../../../db/rollback/2026-10-11-3768-trips-current-stage-and-home-timezone-rollback.sql", import.meta.url);
  it("adds both columns nullable, with NO backfill (no UPDATE public.trips outside the kernel transform)", () => {
    assert.match(sql, /ADD COLUMN current_stage_id uuid NULL/);
    assert.match(sql, /ADD COLUMN home_timezone    text NULL/);
    const outsideKernel = sql.split("DO $mig$")[0]!;
    assert.doesNotMatch(outsideKernel, /UPDATE public\.trips/i, "an UPDATE before the kernel transform would be an invented backfill");
  });
  it("the pointer is a COMPOSITE same-trip FK, nulled (only itself) when its stage is removed", () => {
    assert.match(sql, /FOREIGN KEY \(current_stage_id, id\) REFERENCES public\.trip_stages \(id, trip_id\)\s+ON DELETE SET NULL \(current_stage_id\)/);
  });
  it("home_timezone joins UPDATE_TRIP's allow-list; current_stage_id never does", () => {
    assert.match(sql, /'show_header_publicly','home_timezone'\];/);
    assert.doesNotMatch(sql, /'current_stage_id'\]/);
    assert.match(sql, /pg_catalog\.pg_timezone_names/);
  });
  it("the transform adds no command branch and the postconditions are self-contained (no temp table / GUC)", () => {
    assert.match(sql, /the transform changed the number of command branches/);
    assert.doesNotMatch(sql, /pg_temp\.|set_config\(/);
  });
  it("its rollback exists and removes every insertion", () => {
    assert.ok(existsSync(rbUrl), "db/rollback file for 3768");
    const rb = readFileSync(rbUrl, "utf8");
    for (const t of ["DROP COLUMN IF EXISTS current_stage_id", "DROP COLUMN IF EXISTS home_timezone", "trip_stages_id_trip_unique", "a trace of 3768 survived"]) {
      assert.ok(rb.includes(t), t);
    }
  });
});
