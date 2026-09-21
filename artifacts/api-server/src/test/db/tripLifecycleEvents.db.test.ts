/**
 * Trips spec §4.2 domain events `trip.participant_joined` and
 * `trip.trip_completed`, EXECUTED on the kernel the migrations define
 * (census-trips TR63, TR67).
 *
 * The census graded both W on the activity-log path: `trip_activity_log`
 * records a join and a completion best-effort, outside the transaction,
 * with no aggregate version, no sequence, no causation / correlation id and
 * no schema version. The kernel path has all five. This file proves the
 * kernel path: an invitee's ACCEPT_INVITE appends `trip.participant_joined`
 * and the owner's COMPLETE_TRIP appends `trip.trip_completed`, each at the
 * next aggregate version, with the command as its causation, the envelope's
 * correlation id, schema_version 1, and a receipt that names the event — in
 * one transaction, because `trip_kernel_execute` is one.
 *
 * Skips without LOCAL_DB_URL exactly as the other db tests do.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, command, deleteUser, kernel, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

interface EventRow { event_id: string; aggregate_version: number; sequence: number; type: string; actor_user_id: string; causation_id: string; correlation_id: string; schema_version: number }

describe("§4.2 participant_joined and trip_completed on a real database", { skip: SKIP }, () => {
  let owner = ""; let bob = ""; let tripId = "";
  const lastEvent = () => rows<EventRow>(
    `SELECT event_id, aggregate_version, sequence, type, actor_user_id, causation_id, correlation_id, schema_version
       FROM public.trip_events WHERE trip_id = '${tripId}' ORDER BY aggregate_version DESC LIMIT 1`,
  )[0]!;
  const version = () => Number(scalar(`SELECT version FROM public.trips WHERE id = '${tripId}'`));

  before(() => {
    owner = seedUser("lifecycle_owner"); bob = seedUser("lifecycle_bob");
    const minted = randomUUID();
    const created = kernel(command({ actor_user_id: owner, type: "CREATE_TRIP", trip_id: minted, payload: { title: "lifecycle", destination_city: "Lisboa", destination_country: "Portugal", visibility: "private" } }));
    assert.equal(created.ok, true, JSON.stringify(created));
    tripId = created.result?.id ?? minted;
  });
  after(() => { if (owner) deleteUser(owner); if (bob) deleteUser(bob); });

  it("INVITE_PARTICIPANT then the invitee's ACCEPT_INVITE: trip.participant_joined at the next version, caused by the command, correlated by the envelope, schema-versioned, receipted", () => {
    const invited = kernel(command({ actor_user_id: owner, type: "INVITE_PARTICIPANT", trip_id: tripId, payload: { user_id: bob } }));
    assert.equal(invited.ok, true, JSON.stringify(invited));
    const v = version();
    const commandId = randomUUID(); const correlationId = randomUUID(); const key = randomUUID();
    const accepted = kernel(command({ command_id: commandId, correlation_id: correlationId, idempotency_key: key, actor_user_id: bob, type: "ACCEPT_INVITE", trip_id: tripId, payload: {} }));
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const ev = lastEvent();
    assert.equal(ev.type, "trip.participant_joined");
    assert.equal(Number(ev.aggregate_version), v + 1, "the next aggregate version");
    assert.equal(Number(ev.aggregate_version), version(), "trips.version is the event's version");
    assert.equal(ev.actor_user_id, bob, "the invitee joined; the event says who");
    assert.equal(ev.causation_id, commandId, "caused by this command");
    assert.equal(ev.correlation_id, correlationId, "the envelope's correlation id travels with the event");
    assert.equal(Number(ev.schema_version), 1);
    assert.ok(Number(ev.sequence) > 0);
    const receipt = rows<{ event_id: string; result_version: number }>(`SELECT event_id, result_version FROM public.trip_command_receipts WHERE trip_id = '${tripId}' AND idempotency_key = '${key}'`)[0]!;
    assert.equal(receipt.event_id, ev.event_id, "the receipt names the event it produced");
    assert.equal(Number(receipt.result_version), v + 1);
    assert.equal(scalar(`SELECT status FROM public.trip_members WHERE trip_id = '${tripId}' AND user_id = '${bob}'`), "accepted", "the membership moved in the same transaction");
  });

  it("COMPLETE_TRIP by the owner: trip.trip_completed at the next version with the same five fields; the trip's lifecycle moved with it", () => {
    const v = version();
    const commandId = randomUUID(); const correlationId = randomUUID();
    const done = kernel(command({ command_id: commandId, correlation_id: correlationId, actor_user_id: owner, type: "COMPLETE_TRIP", trip_id: tripId, payload: {} }));
    assert.equal(done.ok, true, JSON.stringify(done));
    const ev = lastEvent();
    assert.equal(ev.type, "trip.trip_completed");
    assert.equal(Number(ev.aggregate_version), v + 1);
    assert.equal(ev.actor_user_id, owner);
    assert.equal(ev.causation_id, commandId); assert.equal(ev.correlation_id, correlationId); assert.equal(Number(ev.schema_version), 1);
    assert.equal(scalar(`SELECT status FROM public.trips WHERE id = '${tripId}'`), "completed");
    // the activity log is NOT where these live: nothing here wrote it
    assert.equal(Number(scalar(`SELECT count(*) FROM public.trip_activity_log WHERE trip_id = '${tripId}'`)), 0, "the kernel path does not go through trip_activity_log");
  });
});
