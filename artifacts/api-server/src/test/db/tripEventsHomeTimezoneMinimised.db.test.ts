/**
 * Owner ruling 2026-10-12: "Keep `home_timezone` private by default." Migration
 * 3769 (census-trips §94), EXECUTED on the kernel the migrations define.
 *
 * The kernel copies the whole trips row into every trip-family event
 * (`payload_json.result`), so after 3768 every UPDATE_TRIP / CANCEL_TRIP / ...
 * event would carry the owner's home zone into a table 2420 made crew-readable.
 * 3769's BEFORE INSERT trigger strips it; the trips row and the owner's own
 * kernel result keep it.
 *
 * Skips without LOCAL_DB_URL exactly as the other db tests do.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, command, deleteUser, kernel, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("3769: trip events never carry the owner's home zone", { skip: SKIP }, () => {
  let owner = ""; let tripId = "";
  const lastEvent = (): any => {
    const raw = scalar(`SELECT payload_json::text FROM public.trip_events WHERE trip_id = '${tripId}' ORDER BY sequence DESC LIMIT 1`);
    assert.ok(raw, "the command wrote an event");
    return JSON.parse(raw);
  };

  before(() => {
    owner = seedUser("tz_owner");
    const minted = randomUUID();
    const r = kernel(command({ actor_user_id: owner, type: "CREATE_TRIP", trip_id: minted,
      payload: { title: "home zone", destination_city: "Lisboa", destination_country: "Portugal", visibility: "public" } }));
    assert.equal(r.ok, true, JSON.stringify(r));
    tripId = r.result?.id ?? minted;
  });
  after(() => { if (owner) deleteUser(owner); });

  it("UPDATE_TRIP stores the zone on the trip and answers the owner with it, and its event has no trace of it", () => {
    const r = kernel(command({ actor_user_id: owner, type: "UPDATE_TRIP", trip_id: tripId,
      payload: { patch: { home_timezone: "Pacific/Chatham", timezone: "Europe/Lisbon" } } }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.home_timezone, "Pacific/Chatham", "the owner's own command result keeps it");
    assert.equal(scalar(`SELECT home_timezone FROM public.trips WHERE id = '${tripId}'`), "Pacific/Chatham");
    const e = lastEvent();
    assert.equal(JSON.stringify(e).includes("Pacific/Chatham"), false, JSON.stringify(e));
    assert.equal("home_timezone" in e.result, false);
    assert.equal(e.result.timezone, "Europe/Lisbon", "the destination zone stays in the event");
    assert.ok(Array.isArray(e.payload.changed) && e.payload.changed.includes("home_timezone"), "the event still says WHICH column changed");
  });

  it("a later trip-family command (a title change) does not re-publish the stored zone through its row copy", () => {
    const r = kernel(command({ actor_user_id: owner, type: "UPDATE_TRIP", trip_id: tripId, payload: { patch: { title: "renamed" } } }));
    assert.equal(r.ok, true, JSON.stringify(r));
    const e = lastEvent();
    assert.equal(e.result.title, "renamed");
    assert.equal(JSON.stringify(e).includes("Pacific/Chatham"), false, JSON.stringify(e));
  });

  it("no event of this trip carries the zone anywhere", () => {
    assert.equal(scalar(`SELECT count(*) FROM public.trip_events WHERE trip_id = '${tripId}' AND payload_json::text LIKE '%Pacific/Chatham%'`), "0");
  });
});
