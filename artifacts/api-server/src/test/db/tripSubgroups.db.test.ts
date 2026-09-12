/**
 * 2780 executed: §9.2 temporary subgroups on the real kernel.
 *
 * census-trips TR24 ("Subgroup has zero occurrences outside docs/"), TR148
 * ("the SUBGROUP scope had no subject"), TR151 ("crews cannot split and
 * recombine without forking the Trip"), TR152 ("a subgroup can own a meetup,
 * shared transport and temporary presence sharing while the parent Trip
 * remains canonical") and TR384 (the closeout step with nothing to dissolve).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, asUser, command, deleteUser, exec, kernel, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("2780 temporary subgroups", { skip: SKIP }, () => {
  let owner = ""; let alice = ""; let bob = ""; let stranger = "";
  let tripId = ""; let stageId = "";

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
  const lastEvent = () => rows<{ type: string; payload_json: any }>(`SELECT type, payload_json FROM public.trip_events WHERE trip_id = '${tripId}' ORDER BY aggregate_version DESC LIMIT 1`)[0]!;
  const members = (g: string) => rows<{ user_id: string; left: boolean }>(`SELECT user_id, (left_at IS NOT NULL) AS left FROM public.trip_subgroup_members WHERE subgroup_id = '${g}' ORDER BY user_id`);

  before(() => {
    owner = seedUser("sub_owner"); alice = seedUser("sub_alice"); bob = seedUser("sub_bob"); stranger = seedUser("sub_stranger");
    tripId = randomUUID();
    ok(owner, { type: "CREATE_TRIP", payload: { title: "split", destination_city: "Berlin", destination_country: "Germany", visibility: "private" } });
    stageId = ok(owner, { type: "ADD_STAGE", payload: { stage_type: "city", city_id: randomUUID(), timezone: "Europe/Berlin", sequence: 1, starts_at: "2026-10-01T08:00:00Z", ends_at: "2026-10-03T20:00:00Z" } }).result.id;
    ok(owner, { type: "ADD_PARTICIPANT", payload: { user_id: alice, role: "member" } });
    ok(owner, { type: "ADD_PARTICIPANT", payload: { user_id: bob, role: "member" } });
  });
  after(() => { for (const u of [owner, alice, bob, stranger]) if (u) deleteUser(u); });

  it("CREATE_SUBGROUP by a crew member: creator is always a member, named members must be accepted crew (TR24, TR151)", () => {
    refused("TRIP_SUBGROUP_MEMBER_NOT_CREW", alice, { type: "CREATE_SUBGROUP", payload: { name: "Nightlife", member_ids: [stranger] } });
    refused("TRIP_AUTH_NOT_CREW", stranger, { type: "CREATE_SUBGROUP", payload: { name: "Outsiders" } });
    const r = ok(alice, { type: "CREATE_SUBGROUP", payload: { name: "Nightlife", member_ids: [bob] } });
    assert.deepEqual(new Set(r.result.member_ids), new Set([alice, bob]));
    const ev = lastEvent();
    assert.equal(ev.type, "trip.subgroup_created");
    assert.equal(ev.payload_json.family, "subgroup");
    assert.deepEqual(members(r.result.id).map((m) => m.left), [false, false]);
    assert.equal(scalar(`SELECT state FROM public.trip_subgroups WHERE id = '${r.result.id}'`), "active");
  });

  it("a subgroup-scoped plan must name an ACTIVE subgroup the actor is in; the CHECK refuses a scope without a subject (TR148)", () => {
    const g = ok(alice, { type: "CREATE_SUBGROUP", payload: { name: "Museum crowd" } }).result.id;
    refused("TRIP_COMMAND_MALFORMED", alice, { type: "ADD_PLAN", payload: { title: "no subject", stage_id: stageId, day_date: "2026-10-02", plan_scope: "subgroup" } });
    refused("TRIP_SUBGROUP_NOT_FOUND", alice, { type: "ADD_PLAN", payload: { title: "ghost", stage_id: stageId, day_date: "2026-10-02", plan_scope: "subgroup", subgroup_id: randomUUID() } });
    refused("TRIP_SUBGROUP_NOT_MEMBER", bob, { type: "ADD_PLAN", payload: { title: "not mine", stage_id: stageId, day_date: "2026-10-02", plan_scope: "subgroup", subgroup_id: g } });
    const plan = ok(alice, { type: "ADD_PLAN", payload: { title: "Pergamon", stage_id: stageId, day_date: "2026-10-02", plan_scope: "subgroup", subgroup_id: g } }).result;
    assert.equal(plan.plan_scope, "subgroup");
    assert.equal(plan.subgroup_id, g);
    let threw = "";
    try { exec(`SET LOCAL ROLE service_role; UPDATE public.trip_plan_items SET subgroup_id = NULL WHERE id = '${plan.id}';`, { single: true }); } catch (e) { threw = String((e as Error).message); }
    assert.match(threw, /trip_plan_items_subgroup_scope_named/, "a subgroup-scoped plan lost its subgroup without the CHECK noticing");
    // bob joins, then may patch a plan into the subgroup
    ok(bob, { type: "JOIN_SUBGROUP", payload: { subgroup_id: g } });
    assert.equal(lastEvent().type, "trip.subgroup_joined");
    const own = ok(bob, { type: "ADD_PLAN", payload: { title: "Bob's", stage_id: stageId, day_date: "2026-10-02" } }).result.id;
    ok(bob, { type: "UPDATE_PLAN", payload: { item_id: own, patch: { plan_scope: "subgroup", subgroup_id: g } } });
    assert.equal(scalar(`SELECT subgroup_id FROM public.trip_plan_items WHERE id = '${own}'`), g);
  });

  it("LEAVE_SUBGROUP keeps the membership as history and stops the leaver's subgroup-scoped live-share (TR152)", () => {
    const g = ok(alice, { type: "CREATE_SUBGROUP", payload: { name: "Walkers", member_ids: [bob] } }).result.id;
    exec(`SET LOCAL ROLE service_role; INSERT INTO public.trip_crew_location_sessions (user_id, trip_id, allowed_member_ids, expires_at, status, visibility_level, subgroup_id) VALUES ('${bob}', '${tripId}', ARRAY['${alice}']::uuid[], now() + interval '2 hours', 'active', 'nearby', '${g}');`, { single: true });
    refused("TRIP_SUBGROUP_NOT_MEMBER", owner, { type: "LEAVE_SUBGROUP", payload: { subgroup_id: g } });
    ok(bob, { type: "LEAVE_SUBGROUP", payload: { subgroup_id: g } });
    assert.equal(lastEvent().type, "trip.subgroup_left");
    assert.deepEqual(members(g).find((m) => m.user_id === bob), { user_id: bob, left: true });
    assert.equal(scalar(`SELECT status FROM public.trip_crew_location_sessions WHERE user_id = '${bob}' AND subgroup_id = '${g}'`), "stopped");
    ok(bob, { type: "JOIN_SUBGROUP", payload: { subgroup_id: g } });
    assert.deepEqual(members(g).find((m) => m.user_id === bob), { user_id: bob, left: false }, "recombining re-activates the same membership row");
  });

  it("DISSOLVE_SUBGROUP: creator or host only; members leave, scoped live-shares stop, the parent trip is untouched (TR152, TR384)", () => {
    const g = ok(alice, { type: "CREATE_SUBGROUP", payload: { name: "Dinner", member_ids: [bob] } }).result.id;
    refused("TRIP_AUTH_NOT_HOST", bob, { type: "DISSOLVE_SUBGROUP", payload: { subgroup_id: g } });
    exec(`SET LOCAL ROLE service_role; INSERT INTO public.trip_crew_location_sessions (user_id, trip_id, allowed_member_ids, expires_at, status, visibility_level, subgroup_id) VALUES ('${alice}', '${tripId}', ARRAY[]::uuid[], now() + interval '2 hours', 'active', 'nearby', '${g}');`, { single: true });
    const tripStatus = scalar(`SELECT status FROM public.trips WHERE id = '${tripId}'`);
    const r = ok(owner, { type: "DISSOLVE_SUBGROUP", payload: { subgroup_id: g, reason: "closeout" } });
    assert.equal(r.result.members_left, 2);
    assert.equal(lastEvent().type, "trip.subgroup_dissolved");
    assert.equal(scalar(`SELECT state FROM public.trip_subgroups WHERE id = '${g}'`), "dissolved");
    assert.equal(scalar(`SELECT dissolved_reason FROM public.trip_subgroups WHERE id = '${g}'`), "closeout");
    assert.deepEqual(members(g).map((m) => m.left), [true, true]);
    assert.equal(scalar(`SELECT status FROM public.trip_crew_location_sessions WHERE user_id = '${alice}' AND subgroup_id = '${g}'`), "stopped");
    assert.equal(scalar(`SELECT status FROM public.trips WHERE id = '${tripId}'`), tripStatus, "the parent trip's state changed on a subgroup dissolution");
    refused("TRIP_SUBGROUP_NOT_FOUND", alice, { type: "JOIN_SUBGROUP", payload: { subgroup_id: g } });
    refused("TRIP_SUBGROUP_NOT_FOUND", alice, { type: "ADD_PLAN", payload: { title: "late", stage_id: stageId, day_date: "2026-10-02", plan_scope: "subgroup", subgroup_id: g } });
  });

  it("RLS: crew read subgroups and memberships; a non-member reads nothing; nobody but the kernel writes", () => {
    const g = ok(alice, { type: "CREATE_SUBGROUP", payload: { name: "Readable" } }).result.id;
    assert.equal(Number(asUser(bob, `SELECT count(*) FROM public.trip_subgroups WHERE id = '${g}';`)[0]), 1);
    assert.equal(Number(asUser(bob, `SELECT count(*) FROM public.trip_subgroup_members WHERE subgroup_id = '${g}';`)[0]), 1);
    assert.equal(Number(asUser(stranger, `SELECT count(*) FROM public.trip_subgroups WHERE id = '${g}';`)[0]), 0);
    let threw = "";
    try { asUser(alice, `INSERT INTO public.trip_subgroups (trip_id, name, created_by) VALUES ('${tripId}', 'direct', '${alice}');`); } catch (e) { threw = String((e as Error).message); }
    assert.match(threw, /permission denied/);
  });
});
