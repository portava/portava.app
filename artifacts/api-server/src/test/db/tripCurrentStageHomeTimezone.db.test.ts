/**
 * Trips v4 §5.1 `trips.current_stage_id` / `trips.home_timezone` (migration
 * 3768, census-trips TR77), EXECUTED on the kernel the migrations define.
 *
 * Kernel commands are the only writers:
 *   START_STAGE sets the pointer, COMPLETE_STAGE clears it (only if it is
 *   current), an UPDATE_STAGE `state` patch does either, REMOVE_STAGE clears it
 *   through the composite foreign key, and UPDATE_TRIP sets home_timezone,
 *   refusing any name absent from pg_timezone_names.
 * The composite FK makes another trip's stage unrepresentable even for a
 * direct write.
 *
 * Skips without LOCAL_DB_URL exactly as the other db tests do.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, command, deleteUser, exec, kernel, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("3768: trips.current_stage_id and home_timezone on a real database", { skip: SKIP }, () => {
  let owner = ""; let other = ""; let tripId = ""; let otherTrip = "";
  const pointer = () => scalar(`SELECT current_stage_id::text FROM public.trips WHERE id = '${tripId}'`) || null;
  const home = () => scalar(`SELECT home_timezone FROM public.trips WHERE id = '${tripId}'`) || null;
  const mk = (actor: string): string => {
    const minted = randomUUID();
    const r = kernel(command({ actor_user_id: actor, type: "CREATE_TRIP", trip_id: minted, payload: { title: "stages", destination_city: "Lisboa", destination_country: "Portugal", visibility: "private" } }));
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.result?.id ?? minted;
  };
  const addStage = (t: string, seq: number, actor = owner): string => {
    const r = kernel(command({ actor_user_id: actor, type: "ADD_STAGE", trip_id: t, payload: { stage_type: "city", city_id: randomUUID(), timezone: "Europe/Lisbon", sequence: seq } }));
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.result.id as string;
  };
  const stageCmd = (type: string, payload: Record<string, unknown>, t = tripId, actor = owner) =>
    kernel(command({ actor_user_id: actor, type, trip_id: t, payload }));

  before(() => {
    owner = seedUser("stage_owner"); other = seedUser("stage_other");
    tripId = mk(owner); otherTrip = mk(other);
  });
  after(() => { if (owner) deleteUser(owner); if (other) deleteUser(other); });

  it("a new trip carries NULL in both columns", () => {
    assert.equal(pointer(), null);
    assert.equal(home(), null);
  });

  it("START_STAGE / COMPLETE_STAGE / UPDATE_STAGE(state) / REMOVE_STAGE move the pointer, and nothing else does", () => {
    const s1 = addStage(tripId, 1); const s2 = addStage(tripId, 2); const s3 = addStage(tripId, 3);
    assert.equal(stageCmd("START_STAGE", { stage_id: s1 }).ok, true);
    assert.equal(pointer(), s1, "START_STAGE sets it");
    assert.equal(stageCmd("START_STAGE", { stage_id: s2 }).ok, true);
    assert.equal(pointer(), s2, "the most recently started stage is current");
    assert.equal(stageCmd("COMPLETE_STAGE", { stage_id: s1 }).ok, true);
    assert.equal(pointer(), s2, "completing a stage that is not current leaves it");
    assert.equal(stageCmd("COMPLETE_STAGE", { stage_id: s2 }).ok, true);
    assert.equal(pointer(), null, "completing the current stage clears it");
    assert.equal(stageCmd("UPDATE_STAGE", { stage_id: s3, patch: { state: "active" } }).ok, true);
    assert.equal(pointer(), s3, "a state→active patch makes it current");
    assert.equal(stageCmd("UPDATE_STAGE", { stage_id: s3, patch: { timezone: "Europe/Madrid" } }).ok, true);
    assert.equal(pointer(), s3, "a patch without state leaves it");
    assert.equal(stageCmd("REMOVE_STAGE", { stage_id: s3 }).ok, true);
    assert.equal(pointer(), null, "removing the current stage nulls it through the FK");
    assert.equal(scalar(`SELECT count(*) FROM public.trips WHERE id = '${tripId}'`), "1", "only the pointer was nulled, not the trip");
  });

  it("the composite FK refuses another trip's stage, even on a direct write", () => {
    const foreign = addStage(otherTrip, 1, other);
    assert.throws(() => exec(`UPDATE public.trips SET current_stage_id = '${foreign}' WHERE id = '${tripId}';`), /trips_current_stage_same_trip/);
  });

  it("UPDATE_TRIP sets home_timezone to a tzdata name, null clears it, anything else is refused and writes nothing", () => {
    let r = stageCmd("UPDATE_TRIP", { patch: { home_timezone: "America/New_York" } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(home(), "America/New_York");
    assert.equal(r.result.home_timezone, "America/New_York");
    for (const bad of ["Mars/Olympus_Mons", "XYZ3", "UTC+3", "+05:00", ""]) {
      r = stageCmd("UPDATE_TRIP", { patch: { home_timezone: bad, title: "renamed" } });
      assert.equal(r.ok, false, bad);
      assert.equal(r.reason, "TRIP_COMMAND_MALFORMED", bad);
      assert.equal(home(), "America/New_York", `${bad}: nothing written`);
    }
    assert.equal(scalar(`SELECT title FROM public.trips WHERE id = '${tripId}'`), "stages", "the refused commands wrote nothing");
    r = stageCmd("UPDATE_TRIP", { patch: { home_timezone: null } });
    assert.equal(r.ok, true);
    assert.equal(home(), null);
    r = stageCmd("UPDATE_TRIP", { patch: { home_timezone: "Asia/Tokyo" } }, tripId, other);
    assert.equal(r.ok, false, "UPDATE_TRIP is the owner's");
    assert.equal(home(), null);
  });

  it("UPDATE_TRIP never accepts the pointer: it is the stage commands'", () => {
    const s = addStage(tripId, 9);
    const r = stageCmd("UPDATE_TRIP", { patch: { current_stage_id: s } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "TRIP_COMMAND_MALFORMED");
    assert.equal(pointer(), null);
  });

  it("the shape CHECK refuses a POSIX offset on a direct write", () => {
    assert.throws(() => exec(`UPDATE public.trips SET home_timezone = 'UTC+3' WHERE id = '${tripId}';`), /trips_home_timezone_shaped/);
  });
});
