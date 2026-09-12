/**
 * 2781 + 2783 + 2784 executed: the persisted §21.2 decision ledger with its
 * §5.3 retention, §8.1 goal scope with owner-only personal goals,
 * §3.1 permissions_version, and §15.4 / §18.3 reservation history — on the
 * real tables, triggers and policies.
 *
 * census-trips TR19, TR80, TR100, TR138, TR139, TR297, TR298, TR352, TR387, TR401, TR402.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, asUser, command, deleteUser, exec, kernel, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("2781 decisions, 2783 goal scope / permissions_version, 2784 reservation history", { skip: SKIP }, () => {
  let owner = ""; let alice = ""; let tripId = "";
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
  const svc = (sql: string) => exec(`SET LOCAL ROLE service_role;\n${sql}`, { single: true });

  before(() => {
    owner = seedUser("lg_owner"); alice = seedUser("lg_alice");
    tripId = randomUUID();
    ok(owner, { type: "CREATE_TRIP", payload: { title: "ledger", destination_city: "Wien", destination_country: "Austria", visibility: "private" } });
    ok(owner, { type: "ADD_PARTICIPANT", payload: { user_id: alice, role: "member" } });
  });
  after(() => { for (const u of [owner, alice]) if (u) deleteUser(u); });

  it("2781: a decision row keeps every §21.2 field, refuses coordinates in its inputs, and is pruned by policy (TR401, TR402, TR387, TR100)", () => {
    const id = randomUUID();
    svc(`INSERT INTO public.trip_decisions (decision_id, trip_id, decision_type, engine_versions_json, inputs_json, sources, assumptions, constraints, result_json, confidence, source_trip_version, calculated_at)
         VALUES ('${id}', '${tripId}', 'trip_health', '{"TripHealth":"2026-09-12.1"}', '{"commitments": 2, "tripVersion": 3}', ARRAY['trips','trip_commitments'], ARRAY['clock is UTC'], ARRAY['no routed provider'], '{"health":"AT_RISK"}', 'MEDIUM', 3, now());`);
    const row = rows<{ decision_type: string; confidence: string; retain_days: number }>(`SELECT decision_type, confidence, extract(day from retain_until - recorded_at)::int AS retain_days FROM public.trip_decisions WHERE decision_id = '${id}'`)[0]!;
    assert.deepEqual(row, { decision_type: "trip_health", confidence: "MEDIUM", retain_days: 90 });
    let threw = "";
    try { svc(`INSERT INTO public.trip_decisions (decision_id, trip_id, decision_type, inputs_json, calculated_at) VALUES ('${randomUUID()}', '${tripId}', 'today_projection', '{"lat": 48.2}', now());`); } catch (e) { threw = String((e as Error).message); }
    assert.match(threw, /trip_decisions_inputs_minimised/, "a coordinate in the inputs was accepted");
    assert.equal(Number(asUser(alice, `SELECT count(*) FROM public.trip_decisions WHERE decision_id = '${id}';`)[0]), 1, "crew read the ledger");
    // retention: an expired row goes, a live one stays, and the prune reports the count
    const old = randomUUID();
    svc(`INSERT INTO public.trip_decisions (decision_id, trip_id, decision_type, calculated_at, recorded_at, retain_until) VALUES ('${old}', '${tripId}', 'freedom_windows', now() - interval '100 days', now() - interval '100 days', now() - interval '10 days');`);
    const pruned = JSON.parse(svc(`SELECT public.trip_decisions_prune()::text;`).at(-1)!);
    assert.ok(pruned.pruned >= 1, JSON.stringify(pruned));
    assert.equal(scalar(`SELECT count(*) FROM public.trip_decisions WHERE decision_id = '${old}'`), "0");
    assert.equal(scalar(`SELECT count(*) FROM public.trip_decisions WHERE decision_id = '${id}'`), "1");
  });

  it("2783: a personal goal is its owner's — invisible to other crew, uneditable by them; shared goals are the crew's; weight is 0..1 (TR138, TR139)", () => {
    const personal = ok(alice, { type: "ADD_GOAL", payload: { type: "rest", scope: "personal", weight: 0.7 } }).result.id;
    const shared = ok(alice, { type: "ADD_GOAL", payload: { type: "social", priority: "high" } }).result.id;
    assert.equal(scalar(`SELECT scope || '/' || coalesce(owner_user_id::text, 'none') || '/' || weight FROM public.trip_goals WHERE id = '${personal}'`), `personal/${alice}/0.700`);
    assert.equal(scalar(`SELECT scope || '/' || coalesce(owner_user_id::text, 'none') FROM public.trip_goals WHERE id = '${shared}'`), "shared/none");
    refused("TRIP_COMMAND_MALFORMED", alice, { type: "ADD_GOAL", payload: { type: "other", weight: 2 } });
    assert.equal(Number(asUser(owner, `SELECT count(*) FROM public.trip_goals WHERE id = '${personal}';`)[0]), 0, "the owner of the TRIP read alice's personal goal");
    assert.equal(Number(asUser(alice, `SELECT count(*) FROM public.trip_goals WHERE id = '${personal}';`)[0]), 1);
    assert.equal(Number(asUser(owner, `SELECT count(*) FROM public.trip_goals WHERE id = '${shared}';`)[0]), 1);
    refused("TRIP_AUTH_NOT_CREATOR", owner, { type: "UPDATE_GOAL", payload: { goal_id: personal, patch: { priority: "low" } } });
    refused("TRIP_AUTH_NOT_CREATOR", owner, { type: "REMOVE_GOAL", payload: { goal_id: personal } });
    ok(alice, { type: "UPDATE_GOAL", payload: { goal_id: personal, patch: { scope: "shared" } } });
    assert.equal(scalar(`SELECT scope || '/' || coalesce(owner_user_id::text, 'none') FROM public.trip_goals WHERE id = '${personal}'`), "shared/none");
    ok(owner, { type: "REMOVE_GOAL", payload: { goal_id: personal } });
  });

  it("2783: SET_PARTICIPANT_ROLE bumps permissions_version and says so on the event (TR19, TR80)", () => {
    assert.equal(scalar(`SELECT permissions_version FROM public.trip_members WHERE trip_id = '${tripId}' AND user_id = '${alice}'`), "0");
    const r = ok(owner, { type: "SET_PARTICIPANT_ROLE", payload: { user_id: alice, role: "co_host" } });
    assert.equal(r.result.permissions_version, 1);
    assert.equal(r.result.status, "accepted", "membership_state travels with the grant");
    assert.equal(scalar(`SELECT permissions_version FROM public.trip_members WHERE trip_id = '${tripId}' AND user_id = '${alice}'`), "1");
    ok(owner, { type: "SET_PARTICIPANT_ROLE", payload: { user_id: alice, role: "member" } });
    assert.equal(scalar(`SELECT permissions_version FROM public.trip_members WHERE trip_id = '${tripId}' AND user_id = '${alice}'`), "2");
  });

  it("2784: every change appends history with the changed keys; cancel is a state, not a delete; the version moves on every UPDATE (TR297, TR352)", () => {
    const id = randomUUID();
    svc(`SELECT set_config('portava.actor', '${owner}', true); INSERT INTO public.trip_reservations (id, trip_id, user_id, type, title, status, created_from) VALUES ('${id}', '${tripId}', '${owner}', 'stay', 'Hotel Sacher', 'pending_confirm', 'manual');`);
    svc(`SELECT set_config('portava.actor', '${owner}', true); UPDATE public.trip_reservations SET status = 'confirmed', confirmation_ref = 'ABC' WHERE id = '${id}';`);
    svc(`SELECT set_config('portava.actor', '${alice}', true); UPDATE public.trip_reservations SET status = 'cancelled' WHERE id = '${id}';`);
    const hist = rows<{ event_type: string; from_status: string | null; to_status: string; version: number; changed_keys: string[]; actor_user_id: string }>(
      `SELECT event_type, from_status, to_status, version::int, changed_keys, actor_user_id FROM public.trip_reservation_events WHERE reservation_id = '${id}' ORDER BY id`,
    );
    assert.deepEqual(hist.map((h) => [h.event_type, h.from_status, h.to_status, h.version]), [["created", null, "pending_confirm", 0], ["confirmed", "pending_confirm", "confirmed", 1], ["cancelled", "confirmed", "cancelled", 2]]);
    assert.deepEqual(hist[1]!.changed_keys.sort(), ["confirmation_ref", "status"]);
    assert.equal(hist[2]!.actor_user_id, alice);
    assert.ok(hist[2]!.changed_keys.includes("cancelled_at"), "cancel did not stamp cancelled_at");
    assert.equal(scalar(`SELECT version || '/' || status || '/' || (cancelled_at IS NOT NULL) FROM public.trip_reservations WHERE id = '${id}'`), "2/cancelled/true");
    // §18.3: an UPDATE keyed on a stale version touches nothing
    svc(`UPDATE public.trip_reservations SET title = 'stale write' WHERE id = '${id}' AND version = 0;`);
    assert.equal(scalar(`SELECT title FROM public.trip_reservations WHERE id = '${id}'`), "Hotel Sacher");
    // history is append-only: no UPDATE, no DELETE while the reservation exists; clients cannot DELETE the reservation
    let threw = "";
    try { svc(`UPDATE public.trip_reservation_events SET event_type = 'updated' WHERE reservation_id = '${id}';`); } catch (e) { threw = String((e as Error).message); }
    assert.match(threw, /append-only/);
    threw = "";
    try { svc(`DELETE FROM public.trip_reservation_events WHERE reservation_id = '${id}';`); } catch (e) { threw = String((e as Error).message); }
    assert.match(threw, /append-only/);
    threw = "";
    try { asUser(owner, `DELETE FROM public.trip_reservations WHERE id = '${id}';`); } catch (e) { threw = String((e as Error).message); }
    assert.match(threw, /permission denied/, "a client deleted a reservation");
    assert.equal(Number(asUser(alice, `SELECT count(*) FROM public.trip_reservation_events WHERE reservation_id = '${id}';`)[0]), 3, "crew read the history");
  });

  it("2784: compensation is a new event against a cancelled reservation; the row is untouched (TR298)", () => {
    const id = randomUUID();
    svc(`INSERT INTO public.trip_reservations (id, trip_id, user_id, type, title, status, created_from) VALUES ('${id}', '${tripId}', '${owner}', 'activity', 'Opera', 'confirmed', 'manual');`);
    const notCancelled = JSON.parse(svc(`SELECT public.trip_reservation_record_compensation('${id}', '${owner}', '{"amount_minor": 1000, "currency": "EUR"}')::text;`).at(-1)!);
    assert.equal(notCancelled.reason, "TRIP_BOOKING_HISTORY_APPEND_ONLY");
    svc(`UPDATE public.trip_reservations SET status = 'cancelled' WHERE id = '${id}';`);
    const versionBefore = scalar(`SELECT version FROM public.trip_reservations WHERE id = '${id}'`);
    const comp = JSON.parse(svc(`SELECT public.trip_reservation_record_compensation('${id}', '${owner}', '{"amount_minor": 1000, "currency": "EUR", "note": "voucher"}')::text;`).at(-1)!);
    assert.equal(comp.ok, true, JSON.stringify(comp));
    assert.equal(scalar(`SELECT version FROM public.trip_reservations WHERE id = '${id}'`), versionBefore, "compensation moved the reservation's version");
    const last = rows<{ event_type: string; payload_json: any }>(`SELECT event_type, payload_json FROM public.trip_reservation_events WHERE reservation_id = '${id}' ORDER BY id DESC LIMIT 1`)[0]!;
    assert.equal(last.event_type, "compensated");
    assert.equal(last.payload_json.note, "voucher");
    const missing = JSON.parse(svc(`SELECT public.trip_reservation_record_compensation('${randomUUID()}', '${owner}', '{}')::text;`).at(-1)!);
    assert.equal(missing.reason, "TRIP_BOOKING_NOT_FOUND");
  });
});
