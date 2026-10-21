/** L221/L147: the abort uses a current, explicitly supplied origin and the existing budgeted route port. Real migrated schema, fixture provider only. */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PRESSED_SKIP_REASON, applyPress, openForPress, type PressedDb } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";
import { LAYOVER_RETURN_CORRIDOR_PROVIDER } from "../../services/airport/LayoverReturnCorridor.js";
import { unmeasured, type CorridorQuery } from "../../lib/providers/routeCorridorProvider.js";
import { currentRoutesRequestBudget } from "../../domain/trips/contracts/RoutesRequestBudget.js";
const PRESS = { migrations: ["2741"], flags: { layover_safe_return_status_enabled: true } } as const;
let db: PressedDb, app: PressedApp;
const original = LAYOVER_RETURN_CORRIDOR_PROVIDER.corridor;
let queries: CorridorQuery[] = [], scopes: unknown[] = [], variant = "good";
const point = () => ({ lat: 1.31987654, lng: 103.89876543, accuracyMeters: 20, observedAt: new Date().toISOString(), mode: "drive" });
async function run(origin: unknown = point()) {
  const user = await db.seedUser(`route${Math.random().toString(16).slice(2,10)}`);
  const session = await startSession(app, user, { iata: "SIN" }, { departsInH: 9 });
  return { user, session, reply: await app.call("POST", `/api/airport/sessions/${session.id}/return-now`, user, { origin }) };
}
describe("B2-BUDDY abort route on migrated schema", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openForPress(PRESS); await productionBaseFlags(db); await applyPress(db, PRESS); app = await startPressedLayoverApp(db);
    LAYOVER_RETURN_CORRIDOR_PROVIDER.corridor = async (q) => {
      queries.push(q); scopes.push(currentRoutesRequestBudget());
      if (variant === "throws") throw new Error("fixture network failure");
      return { ok: true, value: { from: q.from!, to: q.to!, departAt: q.departAt.toISOString(), routes: [{ totalMinutes: 20, transferCount: 0, legs: [{ mode: q.mode ?? "drive", minutes: 15, distanceMeters: 15000, interruptibility: "interruptible", transferPointId: null }] }], independentRouteCount: 1, reliability: unmeasured("fixture"), queueFriction: unmeasured("fixture"), weather: unmeasured("fixture"), airportReentryMinutes: unmeasured("fixture"), observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + (variant === "stale" ? -1000 : 300000)).toISOString(), sourceClass: "LIVE", confidence: "MEDIUM", sourceRefs: variant === "fallback" ? ["fixture:fallback:FALLBACK_TRAFFIC_UNAWARE"] : ["fixture:official-routes"] } };
    };
  });
  beforeEach(() => { queries = []; scopes = []; variant = "good"; });
  after(async () => { LAYOVER_RETURN_CORRIDOR_PROVIDER.corridor = original; await app?.close(); await db?.close(); });
  it("R1 current origin routes only the journey BACK, charges the owned layover scope and preserves the canonical deadline", async () => {
    const origin = point(); const { reply, session, user } = await run(origin);
    assert.equal(reply.status, 200, reply.raw); const contract = reply.body.returnContract;
    assert.ok(contract.route, "abort must carry the measured way back"); assert.equal(queries.length, 1);
    assert.deepEqual(queries[0]!.from, { lat: origin.lat, lng: origin.lng }); assert.notDeepEqual(queries[0]!.to, queries[0]!.from);
    assert.equal(contract.route.minutes, 20); assert.ok(contract.route.conservativeMinutes > 20); assert.equal(contract.routeUnavailableReason, null);
    assert.equal(contract.route.hardReturnBy, contract.hardReturnTime); assert.equal(contract.route.canMeetDeadline, true);
    assert.equal((scopes[0] as any).userId, user.id); assert.equal((scopes[0] as any).layoverSessionId, session.id);
    const rows = await db.query<any>(`SELECT metadata FROM public.layover_events WHERE session_id='${session.id}'`);
    assert.equal(JSON.stringify(rows).includes(String(origin.lat)), false); assert.equal(JSON.stringify(rows).includes(String(origin.lng)), false);
  });
  it("R2 stale or out-of-range client origins cannot trigger a provider call; the abort still succeeds", async () => {
    for (const origin of [{ ...point(), lat: 91 }, { ...point(), observedAt: new Date(Date.now()-600000).toISOString() }, { ...point(), accuracyMeters: 5000 }]) {
      const { reply } = await run(origin); assert.equal(reply.status, 200, reply.raw); assert.equal(reply.body.returnContract.route, null); assert.equal(reply.body.returnContract.routeUnavailableReason, "origin_unavailable");
    } assert.equal(queries.length, 0);
  });
  it("R3 expired route is a named absence and never a certified itinerary", async () => { variant="stale"; const { reply }=await run(); assert.equal(reply.status,200,reply.raw); assert.equal(reply.body.returnContract.route,null); assert.equal(reply.body.returnContract.routeUnavailableReason,"route_stale"); });
  it("R4 provider failure does not fail an abort or fabricate a route", async () => { variant="throws"; const { reply }=await run(); assert.equal(reply.status,200,reply.raw); assert.equal(reply.body.returnContract.route,null); assert.equal(reply.body.returnContract.routeUnavailableReason,"PROVIDER_UNAVAILABLE"); });
  it("R5 traffic-unaware fallback is not certified as the return forecast", async () => { variant="fallback"; const { reply }=await run(); assert.equal(reply.status,200,reply.raw); assert.equal(reply.body.returnContract.route,null); assert.equal(reply.body.returnContract.routeUnavailableReason,"return_forecast_unavailable"); });
  it("R6 another traveller cannot route from someone else's layover", async () => { const { session }=await run(); queries=[]; const stranger=await db.seedUser("route-stranger"); const reply=await app.call("POST",`/api/airport/sessions/${session.id}/return-now`,stranger,{origin:point()}); assert.equal(reply.status,404); assert.equal(queries.length,0); });
  it("R7 an unchanged canonical snapshot routes from the current validated request instant, not its stored past clock",async()=>{
    const realNow=Date.now;let now=Math.floor(realNow()/60000)*60000+10000;Date.now=()=>now; // the origin is observed on THIS clock: new Date() reads the real one, up to 50 s past `now`, beyond the 30 s future allowance
    await db.setFlags({layover_decision_persistence_enabled:true,layover_canonical_snapshot_enabled:true});
    try {const user=await db.seedUser('return-current-clock'),session=await startSession(app,user,{iata:'SIN'},{departsInH:9});const before=await app.call('GET',`/api/airport/sessions/${session.id}/safety`,user);assert.equal(before.status,200,before.raw);const old=now;now+=200;queries=[];const r=await app.call('POST',`/api/airport/sessions/${session.id}/return-now`,user,{origin:{...point(),observedAt:new Date(now).toISOString()}});assert.equal(r.status,200,r.raw);assert.ok(r.body.returnContract.route,r.raw);assert.equal(queries[0]!.departAt.getTime(),now);assert.notEqual(queries[0]!.departAt.getTime(),old);const rows=await db.query<{inputs:{nowMs:number}}>(`SELECT inputs FROM public.layover_certified_computations WHERE session_id='${session.id}'`);assert.equal(rows.length,1,'the immutable prior snapshot is reused');assert.equal(rows[0]!.inputs.nowMs,old);}
    finally {Date.now=realNow;await db.setFlags({layover_canonical_snapshot_enabled:false});}
  });
});
