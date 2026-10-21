import React from 'react';
import {render,screen,waitFor,act} from '@testing-library/react-native';
import {LayoverExperiencePlanCard} from '../LayoverExperiencePlanCard.tsx';
import {LayoverExperienceGeometry} from '../LayoverExperienceGeometry.tsx';
import {googleMapContent} from '../../../lib/layoverGoogleMap.ts';
import {currentExperienceGeometry,type ExperienceGeometry} from '../../../services/layoverExperienceGeometry.ts';
import type {ExperiencePlan} from '../../../services/layoverExperiencePlans.ts';
// NOTE: intentionally exhaustive — the token module initializes native SecureStore. Only authentication is substituted.
jest.mock('../../../services/apiToken.ts',()=>({freshToken:jest.fn(async()=> 'owner-token')}));
jest.mock('../LayoverGoogleRouteMap',()=>({...jest.requireActual('../LayoverGoogleRouteMap'),LayoverGoogleRouteMap:(props:unknown)=>{const React=require('react'),{Text}=require('react-native'),{googleMapContent}=require('../../../lib/layoverGoogleMap.ts');const content=googleMapContent(props);return content?React.createElement(Text,{'testID':'experience-map-lines'},JSON.stringify(content.lines)):null;}}));
const sid='11111111-1111-4111-8111-111111111111',planId='22222222-2222-4222-8222-222222222222';
const stopIds=['33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'];
function fixture(){
 const at=(min:number)=>new Date(Date.now()+min*60000).toISOString();
 const itinerary=[{kind:'outbound',startsAt:at(5),endsAt:at(15),mode:'walk',candidateId:'a'},{kind:'experience',startsAt:at(15),endsAt:at(45),mode:null,candidateId:'a'},{kind:'outbound',startsAt:at(45),endsAt:at(55),mode:'walk',candidateId:'b'},{kind:'experience',startsAt:at(55),endsAt:at(85),mode:null,candidateId:'b'},{kind:'return',startsAt:at(85),endsAt:at(95),mode:'walk',candidateId:'airport'}] as ExperiencePlan['contract']['itinerary'];
 const plan:ExperiencePlan={id:planId,version:1,phase:'selected',stopIds,createdAt:at(-1),contract:{state:'READY',snapshotId:'snapshot-current',candidateIds:['a','b'],insideAirport:false,expiresAt:at(2),departBy:at(5),estimatedArrival:at(15),leaveActivityBy:at(85),expectedAirportReturn:at(95),hardReturnBy:at(120),riskBand:'LOW',confidence:'MEDIUM',minExperienceMinutes:60,idealExperienceMinutes:60,returnBufferMinutes:30,fallbackPlan:{beforeDeparture:'stay_airside',duringExperience:'return_to_airport',returnBy:at(120),returnRoute:{}},abortThreshold:{leaveBy:at(85),returnDeadline:at(120),conditions:['snapshot_changed']},failureModes:[],reasonCodes:[],itinerary}};
 const map:ExperienceGeometry={provider:'google_maps',displayPolicy:'google_map_only',cachePolicy:'no_store',sessionId:sid,planId,planVersion:1,snapshotId:'snapshot-current',stopIds,expiresAt:at(1),airport:{lat:1,lng:104,iataCode:'SIN'},hops:itinerary.filter(s=>s.kind!=='experience').map((s,i)=>({fromKey:i===0?'airport':i===1?'a':'b',toKey:s.candidateId!,direction:i===0?'outbound':i===1?'between_stops':'return',forecastAt:s.startsAt,startsAt:s.startsAt,endsAt:s.endsAt,geometry:{provider:'google_maps',displayPolicy:'google_map_only',cachePolicy:'no_store',geometry:{type:'LineString',coordinates:[[104+i*.01,1],[104+(i+1)*.01,1]]}}}))};
 return {plan,map};
}
const response=(body:unknown)=>({ok:true,status:200,json:async()=>body}) as Response;
beforeEach(()=>{jest.clearAllMocks();});
it('actual plan-card path fetches exact plan-bound geometry with authentication/no-store and renders every ordered leg',async()=>{
 const {plan,map}=fixture(),fetcher=jest.fn(async(url:string)=>response(url.includes('/map?')?{ok:true,map}:{ok:true,plan,usable:true,reason:null}));global.fetch=fetcher as typeof fetch;
 await render(<LayoverExperiencePlanCard sessionId={sid} stops={[]} timezone="UTC" canStart onChanged={()=>{}}/>);
 await waitFor(()=>expect(screen.getByTestId('experience-map-lines')).toBeTruthy());
 const lines=JSON.parse(screen.getByTestId('experience-map-lines').props.children);expect(lines.map((l:{direction:string})=>l.direction)).toEqual(['outbound','between_stops','return']);
 const request=fetcher.mock.calls.find(c=>c[0].includes('/map?'));expect(request?.[0]).toContain(`planId=${plan.id}&version=1`);
 const options=(fetcher.mock.calls as unknown as Array<[string,RequestInit]>).find(c=>c[0].includes('/map?'))?.[1];expect(options?.cache).toBe('no-store');expect(options?.headers).toEqual({Authorization:'Bearer owner-token'});
});
it('plan changes immediately remove old geometry and ignore its late response',async()=>{
 const {plan,map}=fixture();let resolveOld!:(r:Response)=>void;
 const fetcher=jest.fn((url:string)=>url.includes('version=1')?new Promise<Response>(resolve=>{resolveOld=resolve;}):Promise.resolve(response({ok:false,reason:'route_geometry_unavailable'})));global.fetch=fetcher as typeof fetch;
 const view=await render(<LayoverExperienceGeometry sessionId={sid} plan={plan} usable/>);await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
 const next={...plan,id:'55555555-5555-4555-8555-555555555555',version:2};await view.rerender(<LayoverExperienceGeometry sessionId={sid} plan={next} usable/>);
 await act(async()=>{resolveOld(response({ok:true,map}));});expect(screen.queryByTestId('experience-map-lines')).toBeNull();
});
it('expiry clears displayed geometry, and offline/invalid selection makes no map request',async()=>{
 const {plan,map}=fixture();map.expiresAt=new Date(Date.now()+300).toISOString();const fetcher=jest.fn(async()=>response({ok:true,map}));global.fetch=fetcher as typeof fetch;
 const view=await render(<LayoverExperienceGeometry sessionId={sid} plan={plan} usable/>);await waitFor(()=>expect(screen.getByTestId('experience-map-lines')).toBeTruthy());
 await waitFor(()=>expect(screen.queryByTestId('experience-map-lines')).toBeNull(),{timeout:2000});
 const n=fetcher.mock.calls.length;await view.rerender(<LayoverExperienceGeometry sessionId={sid} plan={plan} usable offline/>);expect(fetcher).toHaveBeenCalledTimes(n);expect(screen.getByText('Street navigation is not saved offline.')).toBeTruthy();
 await view.rerender(<LayoverExperienceGeometry sessionId={sid} plan={plan} usable={false}/>);expect(fetcher).toHaveBeenCalledTimes(n);
});
it('malformed order/version/snapshot/expiry never falls back to independent recommendation geometry',()=>{
 const snap=`snap:${'a'.repeat(32)}`,fx=fixture(),plan={...fx.plan,contract:{...fx.plan.contract,snapshotId:snap}},map={...fx.map,snapshotId:snap};expect(currentExperienceGeometry(map,plan,Date.now())).toBe(true);
 const line={provider:'google_maps',displayPolicy:'google_map_only',cachePolicy:'no_store',geometry:{type:'LineString',coordinates:[[104,1],[104.01,1.01]]}},expiresAt=new Date(Date.now()+300000).toISOString();
 const data={snapshotId:snap,envelope:{centre:{lat:1,lng:104},basis:'routed_union',certifiedInward:true,certifiedOutward:false,polygonInteriorCertified:false,outerBound:null,windowStartsAt:new Date().toISOString(),hardReturnBy:new Date(Date.now()+3600000).toISOString(),usableMinutes:60,dwellFloorMinutes:30,confidence:'LOW',members:[],excluded:[],sectors:[],polygon:[],expiresAt,displayPolicy:'google_map_only'},cards:[{id:'a',title:'Garden',routing:{state:'FEASIBLE',band:'SAFE',reason:null,absence:null,outboundMinutes:5,conservativeReturnMinutes:10,returnContract:null,expiresAt,geometry:{outbound:line,returnLeg:line}}}]} as any;
 const base={data,currentSnapshotId:snap,selectedIds:['a'],airport:map.airport,nowMs:Date.now()};
 expect(googleMapContent(base)?.lines.map(l=>l.direction)).toEqual(['outbound','return']);expect(googleMapContent({...base,experienceMap:map,experiencePlan:plan})?.planRoute).toBe(true);
 for(const bad of [{...map,planVersion:2},{...map,snapshotId:'old'},{...map,stopIds:[...stopIds].reverse()},{...map,hops:[...map.hops].reverse()},{...map,expiresAt:new Date(0).toISOString()},null]){
  expect(googleMapContent({...base,experienceMap:bad,experiencePlan:plan})).toBeNull();
 }
});
it('changed compile inputs and unbound legacy plans ask for a new review instead of showing a route',async()=>{
 for(const reason of ['candidate_changed','plan_review_required']){
  const {plan}=fixture(),fetcher=jest.fn(async()=>response({ok:false,reason}));global.fetch=fetcher as typeof fetch;
  const view=await render(<LayoverExperienceGeometry sessionId={sid} plan={plan} usable/>);await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
  await waitFor(()=>expect(screen.getByText('The measured route no longer fits this timetable. Review a new timed experience.')).toBeTruthy());expect(screen.queryByTestId('experience-map-lines')).toBeNull();await view.unmount();
 }
});
