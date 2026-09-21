/**
 * 2795 executed: the kernel's write guards on the real kernel.
 *
 * census-trips TR450 (§35's TRIP_KERNEL_CREATE_TRIP_UNGUARDED_INSERT, closed:
 * a draft with no city is TRIP_COMMAND_MALFORMED, not an outage) and TR54
 * (§7.2 at the write: a plan may not overlap a confirmed plan unless the
 * override is named and recorded).
 *
 * Run: LOCAL_DB_URL=... node --import tsx/esm --test src/test/db/tripKernelWriteGuards.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, command, deleteUser, kernel, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("2795 write guards", { skip: SKIP }, () => {
  let owner = ""; let tripId = ""; let stageId = "";
  const as = (actor: string, over: Record<string, unknown>) => kernel(command({ actor_user_id: actor, trip_id: tripId, ...over }));
  function ok(actor: string, over: Record<string, unknown>) {
    const r = as(actor, over);
    assert.equal(r.ok, true, `${String(over["type"])} was rejected: ${JSON.stringify(r)}`);
    return r;
  }
  function refused(reason: string, actor: string, over: Record<string, unknown>) {
    const r = as(actor, over);
    assert.equal(r.ok, false, `${String(over["type"])} was ACCEPTED: ${JSON.stringify(r)}`);
    assert.equal(r.reason, reason, JSON.stringify(r));
    return r;
  }
  const plan = (title: string, s: string, e: string, over: Record<string, unknown> = {}) =>
    ({ type: "ADD_PLAN", payload: { title, stage_id: stageId, day_date: "2026-10-02", starts_at: s, ends_at: e, ...over } });

  before(() => {
    owner = seedUser("wg_owner");
    tripId = randomUUID();
    ok(owner, { type: "CREATE_TRIP", payload: { title: "guards", destination_city: "Lisbon", destination_country: "Portugal", visibility: "private" } });
    stageId = ok(owner, { type: "ADD_STAGE", payload: { stage_type: "city", city_id: randomUUID(), timezone: "Europe/Lisbon", sequence: 1, starts_at: "2026-10-01T08:00:00Z", ends_at: "2026-10-03T20:00:00Z" } }).result.id;
  });
  after(() => { if (owner) deleteUser(owner); });

  it("CREATE_TRIP with no destination_city is TRIP_COMMAND_MALFORMED with the constraint's own sentence, never an escaped 23502 (TR450)", () => {
    const r = kernel(command({ actor_user_id: owner, trip_id: randomUUID(), type: "CREATE_TRIP", payload: { title: "draft with no city" } }));
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.reason, "TRIP_COMMAND_MALFORMED");
    assert.match(String(r.detail ?? ""), /destination_city/);
    assert.equal(scalar(`SELECT count(*)::text FROM public.trips WHERE title = 'draft with no city'`), "0");
  });

  it("ADD_PLAN overlapping a CONFIRMED plan is TRIP_TEMPORAL_CONFLICT naming the plan; override_conflicts keeps both and is recorded on the result and the event (TR54)", () => {
    const dinner = ok(owner, plan("Dinner", "2026-10-02T19:00:00Z", "2026-10-02T21:00:00Z")).result.id;
    ok(owner, { type: "CONFIRM_PLAN", payload: { item_id: dinner, patch: { status: "confirmed" } } });
    const r = refused("TRIP_TEMPORAL_CONFLICT", owner, plan("Show", "2026-10-02T20:00:00Z", "2026-10-02T22:00:00Z"));
    assert.equal(r.plan_id, dinner);
    assert.equal(scalar(`SELECT count(*)::text FROM public.trip_plan_items WHERE trip_id = '${tripId}' AND title = 'Show'`), "0", "nothing was written");
    ok(owner, plan("Adjacent", "2026-10-02T21:00:00Z", "2026-10-02T22:00:00Z"));
    const over = ok(owner, plan("Show", "2026-10-02T20:00:00Z", "2026-10-02T22:00:00Z", { override_conflicts: true }));
    assert.equal(over.result.temporal_conflict?.plan_id, dinner);
    assert.equal(over.result.temporal_conflict?.overridden, true);
    const ev = rows<{ type: string; payload_json: any }>(`SELECT type, payload_json FROM public.trip_events WHERE trip_id = '${tripId}' ORDER BY aggregate_version DESC LIMIT 1`)[0]!;
    assert.equal(ev.type, "trip.plan_added");
    assert.equal(ev.payload_json?.result?.temporal_conflict?.overridden ?? ev.payload_json?.temporal_conflict?.overridden, true, JSON.stringify(ev.payload_json).slice(0, 300));
    const draft = ok(owner, plan("Draft idea", "2026-10-02T09:00:00Z", "2026-10-02T10:00:00Z")).result.id;
    ok(owner, plan("Another draft", "2026-10-02T09:30:00Z", "2026-10-02T10:30:00Z"));
    assert.ok(draft, "two unconfirmed plans may overlap: only a confirmed timeline is guarded");
  });

  it("MOVE_PLAN into a confirmed plan's slot is refused the same way; a move clear of it is not", () => {
    const lunch = ok(owner, plan("Lunch", "2026-10-02T12:00:00Z", "2026-10-02T13:00:00Z")).result.id;
    ok(owner, { type: "CONFIRM_PLAN", payload: { item_id: lunch, patch: { status: "confirmed" } } });
    const walk = ok(owner, plan("Walk", "2026-10-02T15:00:00Z", "2026-10-02T16:00:00Z")).result.id;
    const r = refused("TRIP_TEMPORAL_CONFLICT", owner, { type: "MOVE_PLAN", payload: { item_id: walk, patch: { starts_at: "2026-10-02T12:30:00Z", ends_at: "2026-10-02T13:30:00Z" } } });
    assert.equal(r.plan_id, lunch);
    assert.equal(String(scalar(`SELECT starts_at::text FROM public.trip_plan_items WHERE id = '${walk}'`)).slice(0, 16), "2026-10-02 15:00", "untouched");
    ok(owner, { type: "MOVE_PLAN", payload: { item_id: walk, patch: { starts_at: "2026-10-02T13:00:00Z", ends_at: "2026-10-02T14:00:00Z" } } });
    assert.equal(String(scalar(`SELECT starts_at::text FROM public.trip_plan_items WHERE id = '${walk}'`)).slice(0, 16), "2026-10-02 13:00", "a half-open interval: ending when the other begins is not an overlap");
  });
});
