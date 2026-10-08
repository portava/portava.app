/**
 * 3976 on a real database: a private plan item's name and place do not reach
 * trip_events or trip_snapshots, and no client role reads trip_events
 * (census-trips §85; verifier R1 on 87df318f4; lead ruling D-65).
 *
 * WHAT WAS WRONG: the kernel stored each command's input and result minus only
 * lat/lng, and 2420's `trip_events_crew_select` let every accepted member read
 * them through PostgREST; the snapshot fold copied the title into
 * trip_snapshots, which the crew reads too.
 *
 * WHAT IS ASSERTED, on the functions and tables the chain defines:
 *   E1  ADD_PLAN of a PRIVATE item stores no title, notes, location name, city
 *       or country in its event (payload or result);
 *   E2  CONTROL: a PUBLIC item's event keeps its title;
 *   E3  a crew member signed in as `authenticated` cannot SELECT trip_events
 *       (the door), while service_role still can;
 *   E4  a snapshot written after a private ADD_PLAN carries no title for it,
 *       and still replays to itself;
 *   E5  a public item flipped private: its earlier events lose the title, the
 *       stored snapshot's title is nulled, and replay still verifies;
 *   E6  append-only holds: any UPDATE other than the redaction is refused.
 *
 * Skips without LOCAL_DB_URL (scripts/local-db/run-tests.sh refuses a run with
 * skipped > 0, so CI's api-server-local-db job runs every case).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, asUser, command, deleteUser, exec, kernel, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("3976: private plan items in trip_events and trip_snapshots", { skip: SKIP }, () => {
  let owner = "";
  let member = "";
  let tripId = "";
  let stageId = "";
  let privateItem = "";
  let publicItem = "";

  function ok(over: Record<string, unknown>) {
    const r = kernel(command({ actor_user_id: owner, ...over }));
    assert.equal(r.ok, true, `${String(over["type"])} was rejected: ${JSON.stringify(r)}`);
    return r;
  }
  const eventOf = (itemId: string, type = "trip.plan_added") =>
    rows<{ payload_json: any }>(
      `SELECT payload_json FROM public.trip_events WHERE trip_id = '${tripId}' AND type = '${type}' AND payload_json->'result'->>'id' = '${itemId}'`,
    );

  before(() => {
    owner = seedUser("tev_owner");
    member = seedUser("tev_member");
    tripId = randomUUID();
    ok({ type: "CREATE_TRIP", trip_id: tripId, payload: { title: "tev", destination_city: "Lisboa", destination_country: "Portugal", visibility: "private" } });
    exec(`INSERT INTO public.trip_members (trip_id, user_id, role, status) VALUES ('${tripId}', '${member}', 'member', 'accepted') ON CONFLICT DO NOTHING;`);
    stageId = ok({
      type: "ADD_STAGE", trip_id: tripId,
      payload: { stage_type: "city", city_id: randomUUID(), timezone: "Europe/Lisbon", sequence: 1, starts_at: "2026-10-01T08:00:00Z", ends_at: "2026-10-03T20:00:00Z" },
    }).result?.id;
    privateItem = ok({
      type: "ADD_PLAN", trip_id: tripId,
      payload: { title: "Secret Hotel", notes: "room 12", location_name: "Rua Secreta 4", city: "Lisboa", country: "Portugal", stage_id: stageId, day_date: "2026-10-02", location_is_private: true },
    }).result?.id;
    publicItem = ok({
      type: "ADD_PLAN", trip_id: tripId,
      payload: { title: "Open Museum", stage_id: stageId, day_date: "2026-10-02", location_is_private: false },
    }).result?.id;
  });

  after(() => {
    if (owner) deleteUser(owner);
    if (member) deleteUser(member);
  });

  it("E1 THE POINT: a private item's event carries no title, notes, location name, city or country", () => {
    const ev = eventOf(privateItem);
    assert.equal(ev.length, 1, `events: ${JSON.stringify(ev)}`);
    const text = JSON.stringify(ev[0]!.payload_json);
    for (const leaked of ["Secret Hotel", "room 12", "Rua Secreta", "Lisboa", "Portugal"]) {
      assert.equal(text.includes(leaked), false, `"${leaked}" is in the stored event: ${text}`);
    }
    assert.equal(ev[0]!.payload_json.result.id, privateItem, "the slot (its id) stays");
  });

  it("E2 CONTROL: a public item's event keeps its title", () => {
    const ev = eventOf(publicItem);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.payload_json.result.title, "Open Museum");
  });

  it("E3 THE POINT: a crew member cannot read trip_events as `authenticated`; service_role can", () => {
    assert.throws(
      () => asUser(member, `SELECT count(*) FROM public.trip_events WHERE trip_id = '${tripId}';`),
      /permission denied/,
    );
    const n = exec(`SET LOCAL ROLE service_role;\nSELECT count(*) FROM public.trip_events WHERE trip_id = '${tripId}';`, { single: true });
    assert.ok(Number(n.at(-1)) >= 4, `service_role read ${JSON.stringify(n)}`);
  });

  it("E4 a snapshot carries no title for the private item, the public title, and replays to itself", () => {
    const v = Number(scalar(`SELECT version FROM public.trips WHERE id = '${tripId}'`));
    exec(`SET LOCAL ROLE service_role;\nSELECT public.trip_snapshot_write('${tripId}', ${v});`, { single: true });
    const snap = rows<{ snapshot_json: any }>(`SELECT snapshot_json FROM public.trip_snapshots WHERE trip_id = '${tripId}' AND aggregate_version = ${v}`);
    assert.equal(snap.length, 1);
    assert.equal(snap[0]!.snapshot_json.plans[privateItem].title, null);
    assert.equal(snap[0]!.snapshot_json.plans[publicItem].title, "Open Museum");
    const verdict = JSON.parse(exec(`SET LOCAL ROLE service_role;\nSELECT public.trip_snapshot_verify_replay('${tripId}', ${v})::text;`, { single: true }).at(-1)!);
    assert.equal(verdict.equal, true, JSON.stringify(verdict));
  });

  it("E5 THE POINT: a public item made private takes its history with it, and replay still verifies", () => {
    const v = Number(scalar(`SELECT version FROM public.trips WHERE id = '${tripId}'`));
    assert.equal(eventOf(publicItem)[0]!.payload_json.result.title, "Open Museum", "precondition: the public title is stored");
    exec(`UPDATE public.trip_plan_items SET location_is_private = true WHERE id = '${publicItem}';`);
    const after = JSON.stringify(eventOf(publicItem)[0]!.payload_json);
    assert.equal(after.includes("Open Museum"), false, `the old event kept the title: ${after}`);
    const snap = rows<{ snapshot_json: any }>(`SELECT snapshot_json FROM public.trip_snapshots WHERE trip_id = '${tripId}' AND aggregate_version = ${v}`);
    assert.equal(snap[0]!.snapshot_json.plans[publicItem].title, null);
    const verdict = JSON.parse(exec(`SET LOCAL ROLE service_role;\nSELECT public.trip_snapshot_verify_replay('${tripId}', ${v})::text;`, { single: true }).at(-1)!);
    assert.equal(verdict.equal, true, JSON.stringify(verdict));
  });

  it("E6 append-only: an UPDATE that is not the redaction is refused", () => {
    assert.throws(
      () => exec(`SET LOCAL ROLE service_role;\nUPDATE public.trip_events SET payload_json = payload_json || '{"x":1}'::jsonb WHERE trip_id = '${tripId}';`, { single: true }),
      /append-only/,
    );
    assert.throws(
      () => exec(`SET LOCAL ROLE service_role;\nUPDATE public.trip_events SET sequence = sequence + 1000 WHERE trip_id = '${tripId}';`, { single: true }),
      /append-only/,
    );
  });
});
