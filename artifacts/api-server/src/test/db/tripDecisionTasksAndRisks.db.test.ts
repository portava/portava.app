/**
 * 2762 + 2766 executed on the real chain: ADD/UPDATE/REMOVE_DECISION_TASK and
 * ADD/UPDATE/REMOVE_RISK through `trip_kernel_execute`, the rows they leave in
 * `trip_decision_tasks` / `trip_risks`, the events they append, the 2762 RLS a
 * client reads them through, and the exact select lists the unflagged reader
 * (`GET /trips/:tripId/decisions`, routes/tripDecisions.ts) issues.
 *
 * census-trips TR85 (`trip_decision_tasks`), TR86 (`trip_risks`), TR22
 * (`TripRisk`), TR21 (`TripDecisionTask`). Those rows were held W on §29.3's
 * evidence rule: no test executed ADD_DECISION_TASK or ADD_RISK against a
 * database carrying the real chain — the live and local-db tiers never issued
 * them, and db/harness/probe_goal_decision_risk_families.sql PRINTS its rows and
 * asserts nothing. This suite is that execution, asserted.
 *
 * Runs in CI's kernel-SQL job (scripts/local-db/run-tests.sh). It skips without
 * LOCAL_DB_URL, and run-tests.sh refuses a run with skipped > 0.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, asUser, command, deleteUser, kernel, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("2766 decision-task and risk families on the real chain (TR85, TR86, TR21, TR22)", { skip: SKIP }, () => {
  let owner = ""; let alice = ""; let stranger = ""; let tripId = "";
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
  const version = () => Number(scalar(`SELECT version FROM public.trips WHERE id = '${tripId}'`));
  const lastEvent = () => rows<{ type: string; family: string; aggregate_version: number }>(
    `SELECT type, payload_json->>'family' AS family, aggregate_version FROM public.trip_events WHERE trip_id = '${tripId}' ORDER BY aggregate_version DESC LIMIT 1`,
  )[0]!;

  before(() => {
    owner = seedUser("dr_owner"); alice = seedUser("dr_alice"); stranger = seedUser("dr_stranger");
    tripId = randomUUID();
    ok(owner, { type: "CREATE_TRIP", payload: { title: "decisions", destination_city: "Lisboa", destination_country: "Portugal", visibility: "private" } });
    ok(owner, { type: "ADD_PARTICIPANT", payload: { user_id: alice, role: "member" } });
  });
  after(() => { for (const u of [owner, alice, stranger]) if (u) deleteUser(u); });

  it("ADD_DECISION_TASK: a crew member writes every column, the status default applies, and one event is appended at the next version (TR85, TR21)", () => {
    const before = version();
    const r = ok(alice, { type: "ADD_DECISION_TASK", payload: { type: "booking", deadline_at: "2026-11-01T09:00:00Z", consequence: "the fare doubles", assigned_user_id: owner } });
    const id = r.result.id as string;
    const row = rows<{ type: string; deadline: string; consequence: string; assigned: string; status: string }>(
      `SELECT type, to_char(deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS deadline, consequence, assigned_user_id::text AS assigned, status FROM public.trip_decision_tasks WHERE id = '${id}' AND trip_id = '${tripId}'`,
    )[0];
    assert.deepEqual(row, { type: "booking", deadline: "2026-11-01T09:00:00", consequence: "the fare doubles", assigned: owner, status: "pending" });
    assert.equal(version(), before + 1, "the aggregate version moves exactly once");
    assert.deepEqual(lastEvent(), { type: "trip.decision_task_added", family: "decision_task", aggregate_version: before + 1 });
  });

  it("ADD_DECISION_TASK: an assignee who is not crew is refused TRIP_ASSIGNEE_NOT_CREW and writes nothing; the vocabulary is the table's", () => {
    const count = () => Number(scalar(`SELECT count(*) FROM public.trip_decision_tasks WHERE trip_id = '${tripId}'`));
    const before = count();
    const v = version();
    refused("TRIP_ASSIGNEE_NOT_CREW", owner, { type: "ADD_DECISION_TASK", payload: { type: "booking", assigned_user_id: stranger } });
    refused("TRIP_COMMAND_MALFORMED", owner, { type: "ADD_DECISION_TASK", payload: { type: "vibes" } });
    refused("TRIP_COMMAND_MALFORMED", owner, { type: "ADD_DECISION_TASK", payload: {} });
    assert.equal(count(), before, "a refused command wrote a row");
    assert.equal(version(), v, "a refused command moved the version");
  });

  it("UPDATE_DECISION_TASK / REMOVE_DECISION_TASK: no reassignment outside the crew, status vocabulary enforced, remove is a delete and an unknown id is NOT_FOUND", () => {
    const id = ok(owner, { type: "ADD_DECISION_TASK", payload: { type: "document", assigned_user_id: alice } }).result.id as string;
    refused("TRIP_ASSIGNEE_NOT_CREW", owner, { type: "UPDATE_DECISION_TASK", payload: { task_id: id, patch: { assigned_user_id: stranger } } });
    assert.equal(scalar(`SELECT assigned_user_id::text FROM public.trip_decision_tasks WHERE id = '${id}'`), alice);
    ok(alice, { type: "UPDATE_DECISION_TASK", payload: { task_id: id, patch: { status: "done" } } });
    assert.equal(scalar(`SELECT status FROM public.trip_decision_tasks WHERE id = '${id}'`), "done");
    assert.equal(lastEvent().type, "trip.decision_task_updated");
    refused("TRIP_COMMAND_MALFORMED", alice, { type: "UPDATE_DECISION_TASK", payload: { task_id: id, patch: { status: "maybe" } } });
    assert.equal(scalar(`SELECT status FROM public.trip_decision_tasks WHERE id = '${id}'`), "done");
    ok(owner, { type: "REMOVE_DECISION_TASK", payload: { task_id: id } });
    assert.equal(scalar(`SELECT count(*) FROM public.trip_decision_tasks WHERE id = '${id}'`), "0");
    assert.equal(lastEvent().type, "trip.decision_task_removed");
    refused("TRIP_DECISION_TASK_NOT_FOUND", owner, { type: "REMOVE_DECISION_TASK", payload: { task_id: randomUUID() } });
    refused("TRIP_DECISION_TASK_NOT_FOUND", owner, { type: "UPDATE_DECISION_TASK", payload: { task_id: randomUUID(), patch: { status: "done" } } });
  });

  it("ADD_RISK: likelihood, impact, trigger and mitigation are stored; omitted defaults apply; one event at the next version (TR86, TR22)", () => {
    const before = version();
    const id = ok(alice, { type: "ADD_RISK", payload: { likelihood: "high", impact: "medium", trigger_json: { when: "rail strike" }, mitigation_json: { do: "book the bus" } } }).result.id as string;
    const row = rows<{ likelihood: string; impact: string; trigger_json: unknown; mitigation_json: unknown; status: string }>(
      `SELECT likelihood, impact, trigger_json, mitigation_json, status FROM public.trip_risks WHERE id = '${id}' AND trip_id = '${tripId}'`,
    )[0];
    assert.deepEqual(row, { likelihood: "high", impact: "medium", trigger_json: { when: "rail strike" }, mitigation_json: { do: "book the bus" }, status: "open" });
    assert.equal(version(), before + 1);
    assert.deepEqual(lastEvent(), { type: "trip.risk_added", family: "risk", aggregate_version: before + 1 });
    const bare = ok(owner, { type: "ADD_RISK", payload: { likelihood: "low", impact: "low" } }).result.id as string;
    assert.deepEqual(rows(`SELECT status, trigger_json, mitigation_json FROM public.trip_risks WHERE id = '${bare}'`)[0], { status: "open", trigger_json: {}, mitigation_json: {} },
      "an omitted NOT NULL DEFAULT column is coalesced, not refused");
  });

  it("ADD_RISK / UPDATE_RISK / REMOVE_RISK: the vocabularies are the table's, a non-object trigger is refused, and an unknown id is NOT_FOUND", () => {
    const count = () => Number(scalar(`SELECT count(*) FROM public.trip_risks WHERE trip_id = '${tripId}'`));
    const n = count();
    refused("TRIP_COMMAND_MALFORMED", owner, { type: "ADD_RISK", payload: { likelihood: "certain", impact: "low" } });
    refused("TRIP_COMMAND_MALFORMED", owner, { type: "ADD_RISK", payload: { likelihood: "low" } });
    refused("TRIP_COMMAND_MALFORMED", owner, { type: "ADD_RISK", payload: { likelihood: "low", impact: "low", trigger_json: [1, 2] } });
    assert.equal(count(), n, "a refused ADD_RISK wrote a row");
    const id = ok(owner, { type: "ADD_RISK", payload: { likelihood: "medium", impact: "high" } }).result.id as string;
    ok(alice, { type: "UPDATE_RISK", payload: { risk_id: id, patch: { status: "mitigated", mitigation_json: { do: "travel a day early" } } } });
    assert.deepEqual(rows(`SELECT status, mitigation_json FROM public.trip_risks WHERE id = '${id}'`)[0], { status: "mitigated", mitigation_json: { do: "travel a day early" } });
    assert.equal(lastEvent().type, "trip.risk_updated");
    refused("TRIP_COMMAND_MALFORMED", alice, { type: "UPDATE_RISK", payload: { risk_id: id, patch: { status: "maybe" } } });
    ok(owner, { type: "REMOVE_RISK", payload: { risk_id: id } });
    assert.equal(scalar(`SELECT count(*) FROM public.trip_risks WHERE id = '${id}'`), "0");
    assert.equal(lastEvent().type, "trip.risk_removed");
    refused("TRIP_RISK_NOT_FOUND", owner, { type: "REMOVE_RISK", payload: { risk_id: randomUUID() } });
  });

  it("a non-member cannot issue either family (TRIP_AUTH_NOT_CREW), and nothing is written", () => {
    const tasks = scalar(`SELECT count(*) FROM public.trip_decision_tasks WHERE trip_id = '${tripId}'`);
    const risks = scalar(`SELECT count(*) FROM public.trip_risks WHERE trip_id = '${tripId}'`);
    refused("TRIP_AUTH_NOT_CREW", stranger, { type: "ADD_DECISION_TASK", payload: { type: "booking" } });
    refused("TRIP_AUTH_NOT_CREW", stranger, { type: "ADD_RISK", payload: { likelihood: "low", impact: "low" } });
    assert.equal(scalar(`SELECT count(*) FROM public.trip_decision_tasks WHERE trip_id = '${tripId}'`), tasks);
    assert.equal(scalar(`SELECT count(*) FROM public.trip_risks WHERE trip_id = '${tripId}'`), risks);
  });

  it("2762 RLS: crew read both tables, a stranger reads nothing, and no client writes them directly", () => {
    const taskId = ok(owner, { type: "ADD_DECISION_TASK", payload: { type: "payment" } }).result.id as string;
    const riskId = ok(owner, { type: "ADD_RISK", payload: { likelihood: "low", impact: "medium" } }).result.id as string;
    for (const crew of [owner, alice]) {
      assert.equal(Number(asUser(crew, `SELECT count(*) FROM public.trip_decision_tasks WHERE id = '${taskId}';`)[0]), 1);
      assert.equal(Number(asUser(crew, `SELECT count(*) FROM public.trip_risks WHERE id = '${riskId}';`)[0]), 1);
    }
    assert.equal(Number(asUser(stranger, `SELECT count(*) FROM public.trip_decision_tasks WHERE trip_id = '${tripId}';`)[0]), 0);
    assert.equal(Number(asUser(stranger, `SELECT count(*) FROM public.trip_risks WHERE trip_id = '${tripId}';`)[0]), 0);
    const counts = () => scalar(`SELECT (SELECT count(*) FROM public.trip_decision_tasks WHERE trip_id = '${tripId}') || '/' || (SELECT count(*) FROM public.trip_risks WHERE trip_id = '${tripId}')`);
    const before = counts();
    for (const sql of [
      `INSERT INTO public.trip_decision_tasks (trip_id, type) VALUES ('${tripId}', 'booking');`,
      `INSERT INTO public.trip_risks (trip_id, likelihood, impact) VALUES ('${tripId}', 'low', 'low');`,
      `UPDATE public.trip_risks SET status = 'closed' WHERE id = '${riskId}';`,
      `DELETE FROM public.trip_decision_tasks WHERE id = '${taskId}';`,
    ]) {
      // Refused outright (no grant / RLS) or a no-op (no write policy matches): either way the
      // database must be unchanged, which is what is asserted below — not the error text.
      try { asUser(alice, sql); } catch (e) { assert.match(String((e as Error).message), /permission denied|row-level security/, sql); }
    }
    assert.equal(counts(), before, "a client INSERT or DELETE reached a decision table directly");
    assert.equal(scalar(`SELECT status FROM public.trip_risks WHERE id = '${riskId}'`), "open", "a client UPDATE changed a risk");
  });

  it("the unflagged reader's exact select lists hold on the real tables (routes/tripDecisions.ts)", () => {
    // The two literals GET /trips/:tripId/decisions issues through the service client.
    const tasks = rows<Record<string, unknown>>(`SELECT id, type, deadline_at, consequence, assigned_user_id, status FROM public.trip_decision_tasks WHERE trip_id = '${tripId}'`);
    const risks = rows<Record<string, unknown>>(`SELECT id, likelihood, impact, status, trigger_json, mitigation_json FROM public.trip_risks WHERE trip_id = '${tripId}' ORDER BY id LIMIT 100`);
    assert.ok(tasks.length >= 2, `tasks served: ${tasks.length}`);
    assert.ok(risks.length >= 2, `risks served: ${risks.length}`);
    for (const r of risks) {
      assert.ok(["low", "medium", "high"].includes(String(r["likelihood"])) && ["low", "medium", "high"].includes(String(r["impact"])));
      assert.ok(["open", "mitigated", "realised", "closed"].includes(String(r["status"])));
    }
  });
});
