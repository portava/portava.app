/** L272: existing Safe Return routes driven from an owned landside layover, on the full migrated schema. No remote service. */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { PRESSED_SKIP_REASON, applyPress, openForPress, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";
const PRESS = { migrations: ["2741", "2992", "3893"], flags: { safe_return_enabled: true, layover_safe_return_status_enabled: true, layover_decision_persistence_enabled: true, layover_safe_return_product_enabled: true } } as const;
let db: PressedDb, app: PressedApp, server: Server, base: string;
async function call(path: string, user: PressedUser, body?: unknown) {
  const r = await fetch(`${base}/api/me/safe-return${path}`, { method: "POST", headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json() as any };
}
async function context(landside = true, departsInH = 9) {
  const u = await db.seedUser(`sfr${Math.random().toString(16).slice(2,10)}`);
  const s = await startSession(app, u, {}, { departsInH });
  if (landside) { const r = await app.call("POST", `/api/airport/sessions/${s.id}/checkpoints`, u, { type: "LANDSIDE_EXIT", operationId: "left" }); assert.equal(r.status, 201, r.raw); }
  return { u, s };
}
const create = (u: PressedUser, sid: string, over = {}) => call("/sessions", u, { layoverSessionId: sid, timerMinutes: 480, ...over });
describe("B2-BUDDY L272 Safe Return product integration", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openForPress(PRESS); await productionBaseFlags(db); await applyPress(db, PRESS); app = await startPressedLayoverApp(db);
    const api = express(); api.use(express.json()); api.use((r: any, _s, next) => { r.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
    api.use("/api", (await import("../../routes/safeReturn.js")).default);
    server = await new Promise<Server>((resolve) => { const s = api.listen(0, "127.0.0.1", () => resolve(s)); }); base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  after(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); await app?.close(); await db?.close(); });
  it("S1 uses the certified deadline, records the actual start, and reflects RETURNING", async () => {
    const { u, s } = await context(); const overview = await app.call("GET", `/api/airport/sessions/${s.id}/safety`, u);
    const c = await create(u, s.id); assert.equal(c.status, 201, JSON.stringify(c.body));
    const expected = overview.body.overview?.hardReturnTime ?? overview.body.hardReturnTime ?? overview.body.returnDeadline?.hardReturnTime;
    assert.ok(expected, `overview deadline absent: ${overview.raw}`); assert.equal(Date.parse(c.body.session.timerEndAt), Date.parse(expected));
    const reserved = await db.query<any>(`SELECT * FROM public.layover_safe_return_links WHERE layover_session_id='${s.id}'`); assert.equal(reserved.length,1); assert.equal(reserved[0].return_started_at,null);
    const started = await call(`/sessions/${c.body.session.id}/start`, u); assert.equal(started.status,200,JSON.stringify(started.body)); assert.equal(Date.parse(started.body.session.timerEndAt),Date.parse(expected));
    const rows = await db.query<any>(`SELECT l.return_started_at, s.status FROM public.layover_safe_return_links l JOIN public.layover_sessions s ON s.id=l.layover_session_id WHERE s.id='${s.id}'`); assert.ok(rows[0].return_started_at); assert.equal(rows[0].status,"returning");
  });
  it("S2 refuses unreported/airside and foreign layovers before creating a timer", async () => {
    const { u, s } = await context(false); assert.equal((await create(u,s.id)).status,409);
    const stranger = await db.seedUser("sfrstranger"); assert.equal((await create(stranger,s.id)).status,404);
    assert.equal((await db.query<any>(`SELECT id FROM public.safe_return_sessions WHERE user_id IN ('${u.id}','${stranger.id}')`)).length,0);
  });
  it("S3 cannot extend beyond the certificate or confirm airport arrival through the generic button", async () => {
    const { u, s } = await context(); const c = await create(u,s.id); assert.equal(c.status,201,JSON.stringify(c.body)); const id=c.body.session.id;
    assert.equal((await call(`/sessions/${id}/start`,u)).status,200);
    assert.equal((await call(`/sessions/${id}/extend`,u,{minutes:30})).status,403);
    assert.equal((await call(`/sessions/${id}/confirm`,u)).status,403);
    await assert.rejects(db.asUser(u.id, `UPDATE public.safe_return_sessions SET timer_end_at=timer_end_at+interval '1 hour' WHERE id='${id}' RETURNING id`),/layover_safe_return_server_authoritative/);
    const back=await app.call("POST",`/api/airport/sessions/${s.id}/checkpoints`,u,{type:"AIRPORT_REENTRY",operationId:"back"}); assert.equal(back.status,201,back.raw);
    assert.equal((await db.query<any>(`SELECT status FROM public.safe_return_sessions WHERE id='${id}'`))[0].status,"safe");
  });
  it("S4 an overdue linked timer reuses the existing escalation and never authorizes contacts by itself", async () => {
    const { u, s } = await context(true, 1); const c=await create(u,s.id); assert.equal(c.status,201,JSON.stringify(c.body)); const id=c.body.session.id;
    assert.equal((await call(`/sessions/${id}/start`,u)).status,200);
    const missed=await call(`/sessions/${id}/trigger-missed`,u); assert.equal(missed.status,200,JSON.stringify(missed.body)); assert.equal(missed.body.session.status,"missed");
    assert.equal((await db.query<any>(`SELECT id FROM public.safe_return_contacts WHERE session_id='${id}'`)).length,0);
    assert.ok((await db.query<any>(`SELECT id FROM public.safe_return_events WHERE session_id='${id}' AND event_type='check_in_missed'`)).length>0);
  });
  it("S5 publishing a tighter canonical certificate atomically tightens the product timer", async () => {
    await db.setFlags({layover_canonical_snapshot_enabled:true});
    try {
      const {u,s}=await context(); const c=await create(u,s.id); assert.equal(c.status,201,JSON.stringify(c.body)); const id=c.body.session.id;
      assert.equal((await call(`/sessions/${id}/start`,u)).status,200);
      const before=Date.parse(c.body.session.timerEndAt);
      await db.exec(`UPDATE public.layover_sessions SET departure_time=departure_time-interval '30 minutes' WHERE id='${s.id}'`);
      const safety=await app.call("GET",`/api/airport/sessions/${s.id}/safety`,u); assert.equal(safety.status,200,safety.raw);
      const row=(await db.query<any>(`SELECT l.certified_deadline,s.timer_end_at FROM public.layover_safe_return_links l JOIN public.safe_return_sessions s ON s.id=l.safe_return_session_id WHERE s.id='${id}'`))[0];
      assert.ok(new Date(row.certified_deadline).getTime()<=before-1800000,'earlier cutoff cannot loosen the return deadline; a crossed time band may tighten it further'); assert.equal(new Date(row.certified_deadline).getTime(),Date.parse(safety.body.hardReturnTime)); assert.equal(new Date(row.timer_end_at).getTime(),new Date(row.certified_deadline).getTime());
      await assert.rejects(db.asUser(u.id,`SELECT * FROM public.layover_safe_return_links`));
    } finally {await db.setFlags({layover_canonical_snapshot_enabled:false});}
  });
  it("S6 the real background scheduler and foreground retry atomically claim one escalation", async () => {
    const {u,s}=await context(true,1); const c=await create(u,s.id); assert.equal(c.status,201,JSON.stringify(c.body)); const id=c.body.session.id;
    assert.equal((await call(`/sessions/${id}/start`,u)).status,200);
    const {processExpiredSessions}=await import("../../lib/safeReturnScheduler.js");
    await Promise.all([processExpiredSessions(db.client),call(`/sessions/${id}/trigger-missed`,u)]);
    await processExpiredSessions(db.client);
    assert.equal((await db.query<any>(`SELECT status FROM public.safe_return_sessions WHERE id='${id}'`))[0].status,"missed");
    assert.equal((await db.query<any>(`SELECT id FROM public.safe_return_events WHERE session_id='${id}' AND event_type='check_in_missed'`)).length,1);
    assert.equal((await db.query<any>(`SELECT id FROM public.notifications WHERE source_id='${id}' AND user_id='${u.id}' AND event_type='safe_return.missed'`)).length,1);
  });
  it("S7 only the traveller's existing explicit trusted-circle choice permits contact alerts", async () => {
    await db.setFlags({safe_return_trusted_circle_alerts_enabled:true});
    for (const optedIn of [false,true]) {
      const {u,s}=await context(true,1), recipient=await db.seedUser(`sfr-contact-${optedIn}`);
      const c=await create(u,s.id,{escalationLevel:1,trustedCircleEnabled:optedIn,contacts:[{contactUserId:recipient.id,contactMethod:"in_app",canReceiveLiveLocation:false}]}); assert.equal(c.status,201,JSON.stringify(c.body));
      assert.equal((await call(`/sessions/${c.body.session.id}/start`,u)).status,200);
      const missed=await call(`/sessions/${c.body.session.id}/trigger-missed`,u); assert.equal(missed.status,200,JSON.stringify(missed.body));
      const notices=await db.query<any>(`SELECT id FROM public.notifications WHERE user_id='${recipient.id}' AND source_id='${c.body.session.id}'`);
      assert.equal(notices.length,optedIn?1:0);
    }
  });
  it("S8 the product flag refuses creation without leaving a pending timer", async () => {
    const {u,s}=await context(); await db.setFlags({layover_safe_return_product_enabled:false});
    try {assert.equal((await create(u,s.id)).status,403);assert.equal((await db.query<any>(`SELECT id FROM public.safe_return_sessions WHERE user_id='${u.id}'`)).length,0);}
    finally {await db.setFlags({layover_safe_return_product_enabled:true});}
  });
  it("S9 the atomic overdue claim refuses another owner and a still-future timer", async () => {
    const {u,s}=await context(); const c=await create(u,s.id);assert.equal(c.status,201,JSON.stringify(c.body)); const id=c.body.session.id;
    assert.equal((await call(`/sessions/${id}/start`,u)).status,200);
    const stranger=await db.seedUser('sfr-claim-stranger');const {markMissed}=await import('../../services/safeReturn/SafeReturnService.js');
    assert.equal((await markMissed(db.client,id,u.id)).outcome,'no_match');
    assert.equal((await db.query<any>(`SELECT status FROM public.safe_return_sessions WHERE id='${id}'`))[0].status,'active');
    await db.exec(`UPDATE public.layover_safe_return_links SET certified_deadline=now()-interval '1 minute' WHERE safe_return_session_id='${id}'`);
    assert.equal((await markMissed(db.client,id,stranger.id)).outcome,'no_match');
    assert.equal((await db.query<any>(`SELECT status FROM public.safe_return_sessions WHERE id='${id}'`))[0].status,'active');
    assert.equal((await markMissed(db.client,id,u.id)).outcome,'ok');
  });
  it("S10 an unreadable product gate is neither unbound nor a successful airport closure; retry closes it", async () => {
    const {u,s}=await context();const c=await create(u,s.id);assert.equal(c.status,201,JSON.stringify(c.body));const id=c.body.session.id;
    const fault:typeof db.bridge.faults[number]=({target,params})=>target==='feature_flags'&&params.get('flag')==='eq.layover_safe_return_product_enabled'?{status:503,body:{code:'fixture_unavailable',message:'fixture gate outage'}}:null;
    db.bridge.faults.push(fault);
    try {assert.equal((await call(`/sessions/${id}/start`,u)).status,503);assert.equal((await db.query<any>(`SELECT status FROM public.safe_return_sessions WHERE id='${id}'`))[0].status,'pending');}
    finally {db.bridge.faults.splice(db.bridge.faults.indexOf(fault),1);}
    assert.equal((await call(`/sessions/${id}/start`,u)).status,200);db.bridge.faults.push(fault);
    try {const r=await app.call('POST',`/api/airport/sessions/${s.id}/checkpoints`,u,{type:'AIRPORT_REENTRY',operationId:'back-outage'});assert.equal(r.status,201,r.raw);assert.equal(r.body.safeReturn.ok,false);assert.equal((await db.query<any>(`SELECT status FROM public.safe_return_sessions WHERE id='${id}'`))[0].status,'active');}
    finally {db.bridge.faults.splice(db.bridge.faults.indexOf(fault),1);}
    const retry=await app.call('POST',`/api/airport/sessions/${s.id}/checkpoints`,u,{type:'AIRPORT_REENTRY',operationId:'back-outage'});assert.equal(retry.status,200,retry.raw);assert.equal(retry.body.safeReturn.closed,true);
  });
  it("S11 the consumer-OFF Safe Return deadline includes current observed security conditions",async()=>{
    const {u,s}=await context();await db.setFlags({layover_live_signals_enabled:true,layover_canonical_snapshot_enabled:false,layover_snapshot_consumers_enabled:false});
    try {await db.exec("INSERT INTO public.airport_fact_observations(airport_ref,fact_type,fact_class,value,observer_kind,observer_id,source_ref,observed_at,expires_at) VALUES('SIN','security_wait_minutes','FAST_LIVE',90,'official','feed:safe-return-security','fixture:official-security',now(),now()+interval '20 minutes')");const {prepareLayoverSafeReturn}=await import('../../services/airport/LayoverSafeReturnService.js');const context=await prepareLayoverSafeReturn(db.client,u.id,s.id);assert.ok(context.ok,JSON.stringify(context));if(!context.ok)return;assert.ok(context.record.inputs.liveConditions);assert.ok(context.record.deadline.breakdown.liveExtra>0);const c=await create(u,s.id);assert.equal(c.status,201,JSON.stringify(c.body));assert.equal(Date.parse(c.body.session.timerEndAt),Date.parse(context.deadline));}
    finally {await db.setFlags({layover_live_signals_enabled:false});await db.exec("DELETE FROM public.airport_fact_observations WHERE source_ref='fixture:official-security'");}
  });
});
