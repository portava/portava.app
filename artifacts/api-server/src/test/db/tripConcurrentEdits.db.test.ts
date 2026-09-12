/**
 * Trips spec §23 "Concurrent host edits — optimistic concurrency and impact
 * preview", EXECUTED against the kernel the migrations define (census-trips
 * TR422; §4.4 optimistic concurrency, §9.4 impact preview).
 *
 * Two devices hold the same trip at version v. Device B moves the dinner;
 * device A, still at v, tries to move it somewhere else. The kernel refuses
 * A with TRIP_VERSION_CONFLICT and writes nothing — B's move stands — and
 * A's impact preview, computed over the trip as it now is, describes B's
 * dinner, not the one A remembered. A retries at the current version and
 * succeeds. Nothing here is last-write-wins.
 *
 * Skips without LOCAL_DB_URL exactly as the other db tests do;
 * scripts/local-db/run-tests.sh refuses a run with skipped > 0.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, command, deleteUser, kernel, rows, scalar, seedUser } from "./localDb.ts";
import { previewImpact, type ImpactState } from "../../services/trips/TripImpactPreview.js";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("§23 concurrent host edits on a real database", { skip: SKIP }, () => {
  let owner = "";
  let tripId = "";
  let stageId = "";
  let planId = "";

  function ok(over: Record<string, unknown>) {
    const r = kernel(command({ actor_user_id: owner, ...over }));
    assert.equal(r.ok, true, `${String(over["type"])} was rejected: ${JSON.stringify(r)}`);
    return r;
  }
  const version = () => Number(scalar(`SELECT version FROM public.trips WHERE id = '${tripId}'`));
  const events = () => Number(scalar(`SELECT count(*) FROM public.trip_events WHERE trip_id = '${tripId}'`));

  before(() => {
    owner = seedUser("concurrent_owner");
    const minted = randomUUID();
    const created = ok({ type: "CREATE_TRIP", trip_id: minted, payload: { title: "two devices", destination_city: "Lisboa", destination_country: "Portugal", visibility: "private" } });
    tripId = created.result?.id ?? minted;
    const stage = ok({ type: "ADD_STAGE", trip_id: tripId, payload: { stage_type: "city", city_id: randomUUID(), timezone: "Europe/Lisbon", sequence: 1, starts_at: "2026-10-01T08:00:00Z", ends_at: "2026-10-03T20:00:00Z" } });
    stageId = stage.result?.id;
    const plan = ok({ type: "ADD_PLAN", trip_id: tripId, payload: { title: "Dinner", stage_id: stageId, day_date: "2026-10-02" } });
    planId = plan.result?.id;
    assert.ok(planId, `ADD_PLAN returned no id: ${JSON.stringify(plan)}`);
    ok({ type: "UPDATE_PLAN", trip_id: tripId, payload: { item_id: planId, patch: { starts_at: "2026-10-02T20:00:00Z", ends_at: "2026-10-02T22:00:00Z" } } });
  });

  after(() => { if (owner) deleteUser(owner); });

  it("B moves the dinner at version v; A's move at the same v is TRIP_VERSION_CONFLICT and writes nothing; A's preview over the re-read state is B's dinner; A retries at v+1 and lands", () => {
    const v = version();
    const eventsBefore = events();

    // device B
    const b = ok({ type: "MOVE_PLAN", trip_id: tripId, expected_trip_version: v, payload: { item_id: planId, patch: { starts_at: "2026-10-02T21:00:00Z", ends_at: "2026-10-02T23:00:00Z" } } });
    assert.equal(b.version, v + 1);

    // device A, still at v
    const a = kernel(command({ actor_user_id: owner, type: "MOVE_PLAN", trip_id: tripId, expected_trip_version: v, payload: { item_id: planId, patch: { starts_at: "2026-10-02T19:00:00Z", ends_at: "2026-10-02T21:00:00Z" } } }));
    assert.equal(a.ok, false);
    assert.equal(a.reason, "TRIP_VERSION_CONFLICT");
    assert.equal(events(), eventsBefore + 1, "B's event only; A appended nothing");
    const row = rows<{ starts_at: string; ends_at: string; status: string; title: string; day_date: string }>(
      `SELECT starts_at, ends_at, status, title, day_date::text FROM public.trip_plan_items WHERE id = '${planId}'`,
    )[0]!;
    assert.equal(new Date(row.starts_at).toISOString(), "2026-10-02T21:00:00.000Z", "B's move stands; A's stale write did not land");

    // A re-reads and previews the change it wanted, over the trip as it now is
    const state: ImpactState = {
      plans: [{ id: planId, title: row.title, status: row.status, startsAt: new Date(row.starts_at).toISOString(), endsAt: new Date(row.ends_at).toISOString(), dayDate: row.day_date, participantIds: [owner], planScope: "ALL_CREW", confirmed: ["confirmed", "in_progress"].includes(row.status) }],
      reservations: [], transport: [], commitments: [], safeReturnActiveFor: [], crewIds: [owner],
    };
    const preview = previewImpact({ kind: "move_plan", targetId: planId, startsAt: "2026-10-02T19:00:00Z", endsAt: "2026-10-02T21:00:00Z", proposedBy: owner }, state, Date.parse("2026-10-02T12:00:00Z"));
    assert.equal(preview.change.targetId, planId);
    assert.equal(state.plans[0]!.startsAt, "2026-10-02T21:00:00.000Z", "the preview's input is B's dinner, not the one A remembered");
    assert.equal(preview.bookingSideEffects.requiresUserConfirmation, false, "nothing is booked");
    assert.ok(preview.summary.length > 0);

    // A retries at the current version
    const retry = ok({ type: "MOVE_PLAN", trip_id: tripId, expected_trip_version: v + 1, payload: { item_id: planId, patch: { starts_at: "2026-10-02T19:00:00Z", ends_at: "2026-10-02T21:00:00Z" } } });
    assert.equal(retry.version, v + 2);
    assert.equal(new Date(scalar(`SELECT starts_at FROM public.trip_plan_items WHERE id = '${planId}'`)!).toISOString(), "2026-10-02T19:00:00.000Z");
  });

  it("the same stale command replayed by its key is the same refusal, not a second attempt", () => {
    const v = version();
    const key = randomUUID();
    const first = kernel(command({ actor_user_id: owner, idempotency_key: key, type: "MOVE_PLAN", trip_id: tripId, expected_trip_version: v - 1, payload: { item_id: planId, patch: { starts_at: "2026-10-02T18:00:00Z" } } }));
    assert.equal(first.ok, false); assert.equal(first.reason, "TRIP_VERSION_CONFLICT");
    const again = kernel(command({ actor_user_id: owner, idempotency_key: key, type: "MOVE_PLAN", trip_id: tripId, expected_trip_version: v - 1, payload: { item_id: planId, patch: { starts_at: "2026-10-02T18:00:00Z" } } }));
    assert.equal(again.ok, false); assert.equal(again.reason, "TRIP_VERSION_CONFLICT");
    assert.equal(version(), v, "nothing moved");
  });
});
