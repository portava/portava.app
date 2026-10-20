import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { layoverRouteSubjectRef, validLayoverRouteSubject } from "../lib/layoverRouteSubjectRef.js";
import { impactedSessions, normalizeEvent, type ReplanSession } from "../services/airport/LayoverEventReplanner.js";
import { routeSubjectPublicationGate } from '../services/airport/LayoverRouteSubjects.js';
import type { SupabaseClient } from '@supabase/supabase-js';
const secret = "local-route-subject-fixture-secret-32-characters";
const from = { lat: 1.3, lng: 103.9 }, to = { lat: 1.31, lng: 103.91 };
describe("L259 opaque measured route subjects", () => {
  it('an absent capability row is inert and an unreadable row refuses before touching route schema',async()=>{
    const client=(error:unknown):SupabaseClient=>({from(table:string){assert.equal(table,'feature_flags');const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:null,error})};return q;}} as unknown as SupabaseClient);
    assert.deepEqual(await routeSubjectPublicationGate(client(null),false),{ok:true,required:false});
    assert.deepEqual(await routeSubjectPublicationGate(client({code:'08006'}),true),{ok:false,reason:'route_subject_flags_unreadable'});
  });
  it("identities are stable, directional, mode-specific and secret-keyed without exposing coordinates", () => {
    const ref = layoverRouteSubjectRef(from, to, "walk", secret); assert.ok(ref && validLayoverRouteSubject(ref));
    assert.equal(ref, layoverRouteSubjectRef({ ...from }, { ...to }, "walk", secret));
    for (const other of [layoverRouteSubjectRef(to, from, "walk", secret), layoverRouteSubjectRef(from, to, "drive", secret), layoverRouteSubjectRef(from, to, "walk", secret + "2")]) assert.notEqual(other, ref);
    assert.equal(ref.includes("103.9"), false);
  });
  it("unknown mode, invalid points and missing secret cannot mint a dependency", () => {
    assert.equal(layoverRouteSubjectRef(from, to, "unknown", secret), null);
    assert.equal(layoverRouteSubjectRef(from, { ...to, lat: NaN }, "walk", secret), null);
    assert.equal(layoverRouteSubjectRef(from, to, "walk", ""), null);
  });
  it("only matching active route sessions within the cutoff are impacted, once", () => {
    const ref = layoverRouteSubjectRef(from, to, "walk", secret)!;
    const now = Date.parse("2026-10-19T12:00:00Z");
    const normalized = normalizeEvent({ eventId: "route-event", eventType: "mobility.route_degraded", source: "fixture", sourceEventId: "1", occurredAt: new Date(now).toISOString(), subjectRefs: [{ kind: "route", ref }], payload: { extraMinutes: 10 }, confidence: "HIGH" }, { receivedAtMs: now });
    assert.ok(normalized.ok); if (!normalized.ok) return;
    const base: ReplanSession = { status: "active", airportRef: "SIN", routeRefs: [ref], session: { id: "matching", arrivalTime: "2026-10-19T10:00:00Z", departureTime: "2026-10-19T18:00:00Z", boardingTime: null, flightType: "domestic", immigrationRequired: false, checkedBags: false, wantsToLeave: true } };
    const list = [base, { ...base,status:'returning',session:{...base.session,id:'heading-back'} }, { ...base, routeRefs: [], session: { ...base.session, id: "other-route" } }, { ...base, status: "completed", session: { ...base.session, id: "closed" } }, { ...base, session: { ...base.session, id: "past", departureTime: "2026-10-19T11:00:00Z" } }];
    assert.deepEqual(impactedSessions(normalized.event, list).map(x => [x.session.session.id, x.via]), [["matching", "route_subject"],['heading-back','route_subject']]);
    assert.deepEqual(impactedSessions({ ...normalized.event, eventType: "airport.security_wait_changed", payload: { waitMinutes: 10 } }, list), []);
  });
});

import {drainDurableRouteWork} from '../services/airport/LayoverRouteFanout.js';
it('durable route worker caps oversized caller batches and leaves OFF schema untouched',async()=>{
 const calls:Array<{name:string;args:Record<string,unknown>}>=[];let enabled=false;
 const db={from(table:string){assert.equal(table,'feature_flags');const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{enabled},error:null})};return q;},async rpc(name:string,args:Record<string,unknown>){calls.push({name,args});return{data:{scanned:0,tasks:[],hasMore:false},error:null};}} as unknown as SupabaseClient;
 const prepare=async()=>{throw Error('no tasks may prepare');};
 assert.equal((await drainDurableRouteWork(db,1000,prepare)).enabled,false);assert.deepEqual(calls,[]);enabled=true;
 const pass=await drainDurableRouteWork(db,1000,prepare);assert.equal(pass.failed,0);assert.deepEqual(calls,[{name:'layover_route_fanout_claim',args:{p_limit:200}}]);
});
