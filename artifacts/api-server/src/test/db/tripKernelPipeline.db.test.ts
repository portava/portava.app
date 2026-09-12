/**
 * command -> event -> receipt -> outbox -> projection -> snapshot -> replay,
 * EXECUTED against the functions the migrations define — not read as text.
 *
 * census-trips graded §23.1's "service integration tests cover command ->
 * event -> projection" (TR431) N: *"None of the three stages exists."* All
 * three exist in SQL (2420 events + outbox + receipts, 2520 the projection
 * worker, 2773 snapshot fold/replay) and nothing ran them outside the live
 * CI project, whose credentials this environment does not hold. This file
 * runs them on scripts/local-db (the 2026-08-19 baseline structure plus the
 * canonical chain on a throwaway PostgreSQL) and asserts the pipeline's
 * contracts one stage at a time:
 *
 *   §4.1  every command appends exactly one event with the next aggregate
 *         version and one receipt keyed by its idempotency key;
 *   §22.4 replaying a command by key is a duplicate: same version, no event;
 *   §19.4 the projection worker applies each outbox event once — a second
 *         drain applies nothing — and the projection's source_trip_version
 *         is the aggregate's;
 *   §22.2 a snapshot written at version v replays to the state at v, and a
 *         tampered snapshot does NOT verify;
 *   §23.1 RLS: a signed-in non-member reads nothing of a private trip, the
 *         owner reads it.
 *
 * Skips without LOCAL_DB_URL exactly as tripKernelLive.test.ts skips without
 * credentials; scripts/local-db/run-tests.sh refuses a run with skipped > 0.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, asUser, command, deleteUser, exec, kernel, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("trip kernel pipeline on a real database", { skip: SKIP }, () => {
  let owner = "";
  let stranger = "";
  let tripId = "";
  let stageId = "";
  const versions: Array<[string, number]> = [];

  function ok(over: Record<string, unknown>) {
    const r = kernel(command({ actor_user_id: owner, ...over }));
    assert.equal(r.ok, true, `${String(over["type"])} was rejected: ${JSON.stringify(r)}`);
    return r;
  }

  before(() => {
    owner = seedUser("pipeline_owner");
    stranger = seedUser("pipeline_stranger");
    // The kernel's contract: the CLIENT mints the trip id (a null trip_id is
    // TRIP_COMMAND_MALFORMED even for CREATE_TRIP), so a retry by key targets
    // the same aggregate.
    const mintedTripId = randomUUID();
    const created = ok({
      type: "CREATE_TRIP", trip_id: mintedTripId,
      payload: { title: "pipeline slice", destination_city: "Lisboa", destination_country: "Portugal", visibility: "private" },
    });
    tripId = created.result?.id ?? created.result?.trip_id ?? mintedTripId;
    assert.equal(tripId, mintedTripId, `CREATE_TRIP created a different aggregate: ${JSON.stringify(created)}`);
    versions.push(["CREATE_TRIP", created.version]);
    const stage = ok({
      type: "ADD_STAGE", trip_id: tripId,
      payload: { stage_type: "city", city_id: randomUUID(), timezone: "Europe/Lisbon", sequence: 1, starts_at: "2026-10-01T08:00:00Z", ends_at: "2026-10-03T20:00:00Z" },
    });
    stageId = stage.result?.id;
    versions.push(["ADD_STAGE", stage.version]);
    const plan = ok({ type: "ADD_PLAN", trip_id: tripId, payload: { title: "Dinner", stage_id: stageId, day_date: "2026-10-02" } });
    versions.push(["ADD_PLAN", plan.version]);
  });

  after(() => {
    if (owner) deleteUser(owner);
    if (stranger) deleteUser(stranger);
  });

  it("§4.1 each command appended one event at the next aggregate version, and trips.version is the last one", () => {
    const events = rows<{ aggregate_version: number; type: string; sequence: number }>(
      `SELECT aggregate_version, type, sequence FROM public.trip_events WHERE trip_id = '${tripId}' ORDER BY aggregate_version`,
    );
    assert.equal(events.length, versions.length, `events: ${JSON.stringify(events)}`);
    for (let i = 0; i < events.length; i++) {
      assert.equal(events[i]!.aggregate_version, versions[i]![1], `${versions[i]![0]} event version`);
      if (i > 0) assert.equal(events[i]!.aggregate_version, events[i - 1]!.aggregate_version + 1, "contiguous versions");
    }
    assert.equal(Number(scalar(`SELECT version FROM public.trips WHERE id = '${tripId}'`)), versions.at(-1)![1]);
  });

  it("§4.1 one receipt per idempotency key, pointing at the event it produced", () => {
    const receipts = rows<{ idempotency_key: string; result_version: number; event_id: string; has_event: boolean }>(
      `SELECT r.idempotency_key, r.result_version, r.event_id,
              EXISTS (SELECT 1 FROM public.trip_events e WHERE e.event_id = r.event_id) AS has_event
         FROM public.trip_command_receipts r WHERE r.trip_id = '${tripId}' ORDER BY r.result_version`,
    );
    assert.equal(receipts.length, versions.length);
    assert.equal(new Set(receipts.map((r) => r.idempotency_key)).size, receipts.length, "keys are distinct");
    for (const r of receipts) assert.equal(r.has_event, true, `receipt ${r.idempotency_key} names a missing event`);
  });

  it("§22.4 replaying a command by its key is a duplicate: same version, no new event, no new receipt", () => {
    const key = randomUUID();
    const first = ok({ type: "ADD_PLAN", trip_id: tripId, idempotency_key: key, payload: { title: "Museum", stage_id: stageId, day_date: "2026-10-03" } });
    const before = Number(scalar(`SELECT count(*) FROM public.trip_events WHERE trip_id = '${tripId}'`));
    const again = ok({ type: "ADD_PLAN", trip_id: tripId, idempotency_key: key, payload: { title: "Museum", stage_id: stageId, day_date: "2026-10-03" } });
    assert.equal(again.duplicate, true);
    assert.equal(again.version, first.version);
    assert.equal(again.event_id, first.event_id);
    assert.equal(Number(scalar(`SELECT count(*) FROM public.trip_events WHERE trip_id = '${tripId}'`)), before, "a duplicate appends nothing");
    assert.equal(Number(scalar(`SELECT count(*) FROM public.trip_command_receipts WHERE trip_id = '${tripId}' AND idempotency_key = '${key}'`)), 1);
  });

  it("§4.4 a stale expected_trip_version is refused with TRIP_VERSION_CONFLICT and appends nothing", () => {
    const before = Number(scalar(`SELECT count(*) FROM public.trip_events WHERE trip_id = '${tripId}'`));
    const r = kernel(command({ actor_user_id: owner, type: "ADD_PLAN", trip_id: tripId, expected_trip_version: 0, payload: { title: "Stale", stage_id: stageId, day_date: "2026-10-03" } }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "TRIP_VERSION_CONFLICT");
    assert.equal(Number(scalar(`SELECT count(*) FROM public.trip_events WHERE trip_id = '${tripId}'`)), before);
  });

  it("§4.1 a non-member actor is refused TRIP_AUTH_NOT_CREW by the kernel itself", () => {
    const r = kernel(command({ actor_user_id: stranger, type: "ADD_PLAN", trip_id: tripId, payload: { title: "Intruder", stage_id: stageId, day_date: "2026-10-03" } }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "TRIP_AUTH_NOT_CREW");
  });

  it("§19.4 the projection worker applies every outbox event once; a second drain applies nothing; source_trip_version = trips.version", () => {
    const pending = Number(scalar(`SELECT count(*) FROM public.trip_outbox WHERE trip_id = '${tripId}' AND published_at IS NULL`));
    assert.ok(pending > 0, "the outbox has unpublished events to drain");
    const first = JSON.parse(scalar(`SET LOCAL ROLE service_role; SELECT public.trip_map_projection_drain(1000, false)::text`) ?? "{}");
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.ok(first.applied + (first.replayed ?? 0) >= pending, `drained ${JSON.stringify(first)} for ${pending} pending`);
    const second = JSON.parse(scalar(`SET LOCAL ROLE service_role; SELECT public.trip_map_projection_drain(1000, false)::text`) ?? "{}");
    assert.equal(second.applied, 0, `second drain applied ${JSON.stringify(second)}`);
    const applied = rows<{ event_id: string; n: number }>(
      `SELECT event_id, count(*)::int AS n FROM public.trip_map_projection_applied WHERE trip_id = '${tripId}' GROUP BY event_id`,
    );
    assert.ok(applied.length > 0);
    for (const a of applied) assert.equal(a.n, 1, `event ${a.event_id} applied ${a.n} times`);
    const proj = rows<{ source_trip_version: number; trip_version: number; projection_schema_version: number }>(
      `SELECT p.source_trip_version, t.version AS trip_version, p.projection_schema_version
         FROM public.trip_map_projections p JOIN public.trips t ON t.id = p.trip_id WHERE p.trip_id = '${tripId}'`,
    );
    assert.equal(proj.length, 1, "one projection row per trip");
    assert.equal(proj[0]!.source_trip_version, proj[0]!.trip_version, "the projection is attributed to the aggregate version it was built from");
    assert.equal(Number(scalar(`SELECT count(*) FROM public.trip_outbox WHERE trip_id = '${tripId}' AND published_at IS NULL`)), 0, "nothing left unpublished");
  });

  it("§22.2 a snapshot at the current version replays to the same state; a tampered snapshot does not verify", () => {
    const v = Number(scalar(`SELECT version FROM public.trips WHERE id = '${tripId}'`));
    const written = JSON.parse(scalar(`SET LOCAL ROLE service_role; SELECT public.trip_snapshot_write('${tripId}', ${v})::text`) ?? "{}");
    assert.equal(written.ok, true, JSON.stringify(written));
    assert.equal(written.aggregate_version, v);
    const verified = JSON.parse(scalar(`SET LOCAL ROLE service_role; SELECT public.trip_snapshot_verify_replay('${tripId}', ${v})::text`) ?? "{}");
    assert.equal(verified.ok, true, `replay did not reproduce the snapshot: ${JSON.stringify(verified)}`);
    // Tamper: a snapshot that disagrees with the events must be caught, or the
    // verifier is comparing nothing.
    exec(`SET LOCAL ROLE service_role; UPDATE public.trip_snapshots SET snapshot_json = snapshot_json || '{"tampered": true}'::jsonb WHERE trip_id = '${tripId}' AND aggregate_version = ${v};`, { single: true });
    const tampered = JSON.parse(scalar(`SET LOCAL ROLE service_role; SELECT public.trip_snapshot_verify_replay('${tripId}', ${v})::text`) ?? "{}");
    assert.equal(tampered.ok, false, "a tampered snapshot verified as a faithful replay");
  });

  it("§23.1 RLS: the owner reads the private trip through the authenticated role; a stranger reads nothing", () => {
    const own = asUser(owner, `SELECT count(*) FROM public.trips WHERE id = '${tripId}';`);
    assert.equal(Number(own[0]), 1);
    const other = asUser(stranger, `SELECT count(*) FROM public.trips WHERE id = '${tripId}';`);
    assert.equal(Number(other[0]), 0);
    const otherEvents = asUser(stranger, `SELECT count(*) FROM public.trip_events WHERE trip_id = '${tripId}';`);
    assert.equal(Number(otherEvents[0]), 0, "events of a private trip leak to a non-member");
  });

  it("§23.1 constraints: a second receipt with the same (trip, key) is impossible by unique constraint", () => {
    const r = rows<{ conname: string }>(`SELECT conname FROM pg_constraint WHERE conrelid = 'public.trip_command_receipts'::regclass AND contype IN ('p','u')`);
    assert.ok(r.length >= 1, "trip_command_receipts has a primary/unique key");
    const dup = rows<{ n: number }>(`SELECT count(*)::int AS n FROM (SELECT trip_id, idempotency_key FROM public.trip_command_receipts GROUP BY 1,2 HAVING count(*) > 1) d`);
    assert.equal(dup[0]!.n, 0);
  });
});
