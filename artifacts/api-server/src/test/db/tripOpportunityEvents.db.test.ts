/**
 * Trips spec §13.3 — trip.opportunities_changed recorded by the kernel
 * (2786), executed on the local replica. census-trips TR244–TR253.
 *
 * Run: scripts/local-db/run-tests.sh (or with LOCAL_DB_URL set:
 *   node --import tsx/esm --test src/test/db/tripOpportunityEvents.db.test.ts)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, command, deleteUser, exec, kernel, rows, seedUser } from "./localDb.ts";

describe("2786 RECORD_OPPORTUNITY_CHANGE → trip.opportunities_changed", { skip: !HAVE_DB && "no LOCAL_DB_URL" }, () => {
  let owner = ""; let stranger = ""; const tripId = randomUUID();
  const ok = (over: Record<string, unknown>) => {
    const r = kernel(command({ actor_user_id: owner, trip_id: tripId, ...over }));
    assert.equal(r.ok, true, JSON.stringify(r)); return r;
  };
  const sys = (over: Record<string, unknown>) => kernel(command({ actor_user_id: null, actor_role: "system", trip_id: tripId, ...over }));
  const payload = (over: Record<string, unknown> = {}) => ({
    trigger: "signal", window_id: "fw:A:B", previous_window: { beginsAt: "2026-10-03T12:00:00Z", endsAt: "2026-10-03T16:00:00Z" }, new_window: { beginsAt: "2026-10-03T12:00:00Z", endsAt: "2026-10-03T16:00:00Z" },
    added: [{ id: "fw:A:B:museum", name: "Musée d'Orsay" }], removed: [{ id: "fw:A:B:rooftop", name: "Rooftop", reasonCodes: ["EXPERIENCE_WEATHER_INVALIDATED"] }],
    significance: "high", expires_at: "2026-10-03T16:00:00Z", reason_codes: ["OPPORTUNITY_REMOVED", "OPPORTUNITY_FALLBACK_AVAILABLE", "EXPERIENCE_WEATHER_INVALIDATED"], source: "TripOpportunityProjection", ...over,
  });

  before(() => {
    owner = seedUser("opp_owner"); stranger = seedUser("opp_stranger");
    ok({ type: "CREATE_TRIP", payload: { title: "opportunities", destination_city: "Paris", destination_country: "France", visibility: "private" } });
  });
  after(() => { if (HAVE_DB) { deleteUser(owner); deleteUser(stranger); } });

  it("the engine (actor_role system, no actor) records the §13.3 contract as one event, with the payload echoed as the result", () => {
    const r = sys({ type: "RECORD_OPPORTUNITY_CHANGE", idempotency_key: "engine:opportunity:fw:A:B:1", payload: payload() });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.significance, "high"); assert.equal(r.result.trigger, "signal");
    assert.deepEqual(r.result.reason_codes, ["OPPORTUNITY_REMOVED", "OPPORTUNITY_FALLBACK_AVAILABLE", "EXPERIENCE_WEATHER_INVALIDATED"]);
    assert.equal(r.result.added.length, 1); assert.equal(r.result.removed.length, 1);
    const ev = rows<{ type: string; payload_json: any; actor_role: string }>(
      `select type, payload_json::text as payload_json, actor_role from public.trip_events where trip_id = '${tripId}' and type = 'trip.opportunities_changed'`,
    );
    assert.equal(ev.length, 1); assert.equal(ev[0].actor_role, "system");
    // trip_events.payload_json is { payload, result } (2420); the §13.3 contract is both.
    const stored = JSON.parse(String(ev[0].payload_json));
    assert.equal(stored.payload.window_id, "fw:A:B"); assert.equal(stored.result.significance, "high");
  });
  it("§22.4: the same key is one event; a different diff is another", () => {
    const dup = sys({ type: "RECORD_OPPORTUNITY_CHANGE", idempotency_key: "engine:opportunity:fw:A:B:1", payload: payload() });
    assert.equal(dup.ok, true); assert.equal(dup.duplicate, true);
    const next = sys({ type: "RECORD_OPPORTUNITY_CHANGE", idempotency_key: "engine:opportunity:fw:A:B:2", payload: payload({ significance: "low", removed: [] }) });
    assert.equal(next.ok, true); assert.equal(next.duplicate, false);
    const n = rows<{ n: string }>(`select count(*)::text as n from public.trip_events where trip_id = '${tripId}' and type = 'trip.opportunities_changed'`);
    assert.equal(n[0].n, "2");
  });
  it("malformed: a missing window_id, an unknown significance, or a non-array list is TRIP_COMMAND_MALFORMED", () => {
    for (const bad of [payload({ window_id: "" }), payload({ significance: "huge" }), payload({ added: "museum" })]) {
      const r = sys({ type: "RECORD_OPPORTUNITY_CHANGE", payload: bad });
      assert.equal(r.ok, false); assert.equal(r.reason, "TRIP_COMMAND_MALFORMED", JSON.stringify(r));
    }
  });
  it("2788: the ledger accepts the §42/§43 decision types and still refuses an unknown one", () => {
    const insert = (type: string) => exec(
      `SET LOCAL ROLE service_role;\nINSERT INTO public.trip_decisions (decision_id, trip_id, decision_type, engine_versions_json, inputs_json, sources, assumptions, constraints, result_json, confidence, source_trip_version, calculated_at)\n` +
      `VALUES ('${randomUUID()}', '${tripId}', '${type}', '{}', '{}', '{}', '{}', '{}', '{}', 'N/A', 1, now());`,
    );
    for (const t of ["pulse_projection", "opportunity_portfolio", "opportunity_projection"]) assert.doesNotThrow(() => insert(t), t);
    assert.throws(() => insert("made_up_projection"), /trip_decisions_decision_type|check constraint/i);
    const n = rows<{ n: string }>(`select count(*)::text as n from public.trip_decisions where trip_id = '${tripId}'`);
    assert.equal(n[0].n, "3");
  });
  it("a stranger may not record one (engine capability: system, or accepted crew); the owner may", () => {
    const s = kernel(command({ actor_user_id: stranger, trip_id: tripId, type: "RECORD_OPPORTUNITY_CHANGE", payload: payload() }));
    assert.equal(s.ok, false); assert.equal(s.reason, "TRIP_AUTH_NOT_CREW");
    const o = ok({ type: "RECORD_OPPORTUNITY_CHANGE", payload: payload({ significance: "medium" }) });
    assert.equal(o.result.significance, "medium");
  });
});
