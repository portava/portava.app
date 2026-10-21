import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";
import { _setTestOpenAI } from "../../lib/openai.js";
import { _resetRateLimit } from "../../lib/rateLimit.js";
import { proposeCompassReplan, executeCompassReplan, type CompassReplanAction } from "../../services/airport/LayoverCompassReplan.js";
import type { SupabaseClient } from "@supabase/supabase-js";

let db: PressedDb, app: PressedApp, owner: PressedUser, other: PressedUser, sid: string, action: CompassReplanAction;
async function proposal(sessionId = sid) {
  const safety = await app.call("GET", `/api/airport/sessions/${sessionId}/safety`, owner);
  assert.equal(safety.status, 200, safety.raw);
  const result = await proposeCompassReplan(db.client, owner.id, sessionId, safety.body.snapshotId);
  assert.ok(result.ok, JSON.stringify(result));
  return result.action;
}
async function generations() {
  return (await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM public.layover_events WHERE session_id='${sid}' AND event_type='recommendation_generated'`))[0].count;
}
describe("L112 explicit Compass replan on the actual migrated schema and API", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openPressedLayoverDb(); await productionBaseFlags(db);
    await db.setFlags({ layover_stable_recommendation_ids_enabled: true, layover_compass_enabled: true, layover_compass_assistant_enabled: true, layover_compass_replan_enabled: true, layover_canonical_snapshot_enabled: true, layover_decision_persistence_enabled: true, layover_recommendation_status_enabled: true, layover_recommendation_snapshot_enabled: true });
    owner = await db.seedUser("compass_action_owner"); other = await db.seedUser("compass_action_other");
    app = await startPressedLayoverApp(db); sid = (await startSession(app, owner, { wantsToLeave: false })).id;
  });
  after(async () => { _setTestOpenAI(null); _resetRateLimit(); await app?.close(); await db?.close(); });
  it("model replan proposes a saved-facts recheck, never applies its hypothetical flight claim", async () => {
    const [before] = await db.query(`SELECT departure_time FROM public.layover_sessions WHERE id='${sid}'`);
    let calls = 0;
    _setTestOpenAI({ chat: { completions: { create: async () => ({ choices: [{ message: calls++ === 0 ? { role: "assistant", content: null, tool_calls: [{ id: "preview", type: "function", function: { name: "replan", arguments: JSON.stringify({ sessionId: sid, trigger: "flight.departure_delayed", payload: { delayMinutes: 300, newDepartureTime: null, waitMinutes: null, extraMinutes: null, gate: null, condition: null, checkpoint: null } }) } }] } : { role: "assistant", content: JSON.stringify({ reply: "Food sounds pleasant.", compare: [], clarify: null }) } }] }) } } } as never);
    const r = await app.call("POST", `/api/airport/sessions/${sid}/compass`, owner, { question: "Please recheck my current plan." });
    assert.equal(r.status, 200, r.raw); action = r.body.replanAction; assert.ok(action);
    assert.equal(action.kind, "recheck_current_facts"); assert.match(action.label, /saved details/);
    const [after] = await db.query(`SELECT departure_time FROM public.layover_sessions WHERE id='${sid}'`); assert.deepEqual(after, before);
    const [stored] = await db.query(`SELECT status,kind,result FROM public.layover_compass_actions WHERE id='${action.id}'`);
    assert.equal(stored.status, "proposed"); assert.equal(stored.result, null);
    assert.doesNotMatch(JSON.stringify(action), /delayMinutes|300|newDepartureTime/);
  });
  it("requires explicit approval and owner; a model cannot add execution parameters", async () => {
    for (const body of [{ actionId: action.id }, { actionId: action.id, confirmed: false }, { actionId: action.id, confirmed: true, delayMinutes: 500 }]) {
      assert.equal((await app.call("POST", `/api/airport/sessions/${sid}/compass/replan`, owner, body)).status, 400);
    }
    assert.equal((await app.call("POST", `/api/airport/sessions/${sid}/compass/replan`, other, { actionId: action.id, confirmed: true })).status, 404);
    await assert.rejects(db.asUser(owner.id, `SELECT public.claim_layover_compass_replan('${action.id}','${sid}','${owner.id}')`), /permission denied/);
    await assert.rejects(db.asUser(owner.id, `UPDATE public.layover_compass_actions SET status='running',started_at=now() WHERE id='${action.id}' RETURNING id`), /permission denied/);
  });
  it("applies canonical refresh once, preserves immutable evidence, and replay returns the identical stored result", async () => {
    const before = Number(await generations());
    const r = await app.call("POST", `/api/airport/sessions/${sid}/compass/replan`, owner, { actionId: action.id, confirmed: true });
    assert.equal(r.status, 200, r.raw); assert.equal(r.body.result.state, "applied"); assert.equal(r.body.result.recommendationsUpdated, true);
    const [snapshot] = await db.query(`SELECT snapshot_id FROM public.layover_certified_computations WHERE snapshot_id='${r.body.result.snapshotId}'`); assert.ok(snapshot);
    const again = await app.call("POST", `/api/airport/sessions/${sid}/compass/replan`, owner, { actionId: action.id, confirmed: true });
    assert.equal(again.status, 200, again.raw); assert.equal(again.body.duplicate, true); assert.deepEqual(again.body.result, r.body.result);
    assert.equal(Number(await generations()), before + 1);
    await assert.rejects(db.exec(`UPDATE public.layover_compass_actions SET result='{}' WHERE id='${action.id}'`), /immutable/);
    await assert.rejects(db.exec(`UPDATE public.layover_certified_computations SET usable_minutes=999 WHERE snapshot_id='${r.body.result.snapshotId}'`), /immutable/i);
  });
  it("two simultaneous approvals cannot execute the action twice", async () => {
    const p = await proposal(), before = Number(await generations());
    const results = await Promise.all([0, 1].map(() => app.call("POST", `/api/airport/sessions/${sid}/compass/replan`, owner, { actionId: p.id, confirmed: true })));
    assert.ok(results.some(r => r.status === 200 && r.body.result?.state === "applied"), JSON.stringify(results));
    for (const r of results) assert.ok(r.status === 200 || r.status === 409 && r.body.reason === "action_in_progress", r.raw);
    assert.equal(Number(await generations()), before + 1);
  });
  it("stale session state and expired offers refuse without running", async () => {
    const stale = await proposal();
    await db.exec(`UPDATE public.layover_sessions SET updated_at=updated_at+interval '1 second' WHERE id='${sid}'`);
    const r = await app.call("POST", `/api/airport/sessions/${sid}/compass/replan`, owner, { actionId: stale.id, confirmed: true });
    assert.equal(r.status, 409); assert.equal(r.body.reason, "action_stale");
    const expiredId = randomUUID();
    await db.exec(`INSERT INTO public.layover_compass_actions(id,session_id,user_id,kind,expected_snapshot_id,expected_session_updated_at,created_at,expires_at) SELECT '${expiredId}',id,user_id,'recheck_current_facts',active_snapshot_id,updated_at,now()-interval '6 minutes',now()-interval '1 minute' FROM public.layover_sessions WHERE id='${sid}'`);
    const expired = await app.call("POST", `/api/airport/sessions/${sid}/compass/replan`, owner, { actionId: expiredId, confirmed: true });
    assert.equal(expired.status, 409); assert.equal(expired.body.reason, "action_expired");
  });
  it("a dependency disabled after claim publishes a durable partial outcome instead of false completion", async () => {
    const p = await proposal();
    const fault = new Proxy(db.client, { get(target, prop) {
      if (prop === "rpc") return async (...args: Parameters<SupabaseClient["rpc"]>) => {
        const result = await target.rpc(args[0], args[1], args[2]); await db.setFlag("layover_recommendation_status_enabled", false); return result;
      };
      const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = await executeCompassReplan(fault, owner.id, sid, p.id);
    assert.ok(result.ok, JSON.stringify(result)); if (!result.ok) return;
    assert.equal(result.result.state, "partial"); assert.equal(result.result.recommendationsUpdated, false);
    await db.setFlag("layover_recommendation_status_enabled", true);
    const replay = await executeCompassReplan(db.client, owner.id, sid, p.id);
    assert.ok(replay.ok); if (replay.ok) { assert.equal(replay.duplicate, true); assert.deepEqual(replay.result, result.result); }
  });
  it("the FALSE and missing action flag both close proposal and execution without touching recommendations", async () => {
    const p = await proposal(), before = await generations();
    await db.setFlag("layover_compass_replan_enabled", false);
    assert.deepEqual(await proposeCompassReplan(db.client, owner.id, sid, p.snapshotId), { ok: false, reason: "feature_disabled" });
    assert.deepEqual(await executeCompassReplan(db.client, owner.id, sid, p.id), { ok: false, reason: "feature_disabled" });
    await db.exec("DELETE FROM public.feature_flags WHERE flag='layover_compass_replan_enabled'");
    assert.deepEqual(await proposeCompassReplan(db.client, owner.id, sid, p.snapshotId), { ok: false, reason: "feature_disabled" });
    assert.deepEqual(await executeCompassReplan(db.client, owner.id, sid, p.id), { ok: false, reason: "feature_disabled" });
    assert.equal(await generations(), before);
    assert.equal((await db.query(`SELECT status FROM public.layover_compass_actions WHERE id='${p.id}'`))[0].status, "proposed");
    await db.exec("INSERT INTO public.feature_flags(flag,enabled) VALUES ('layover_compass_replan_enabled',true)");
  });

  it("without the stable-ID cutover flag a replan is refused before anything is superseded or regenerated (its stableIds: true sweeps unkeyed legacy cards)", async () => {
    const p = await proposal(), before = await generations();
    await db.setFlag("layover_stable_recommendation_ids_enabled", false);
    try {
      assert.deepEqual(await proposeCompassReplan(db.client, owner.id, sid, p.snapshotId), { ok: false, reason: "feature_disabled" });
      assert.deepEqual(await executeCompassReplan(db.client, owner.id, sid, p.id), { ok: false, reason: "feature_disabled" });
      assert.equal(await generations(), before);
      assert.equal((await db.query(`SELECT status FROM public.layover_compass_actions WHERE id='${p.id}'`))[0].status, "proposed");
    } finally { await db.setFlag("layover_stable_recommendation_ids_enabled", true); }
  });
});
