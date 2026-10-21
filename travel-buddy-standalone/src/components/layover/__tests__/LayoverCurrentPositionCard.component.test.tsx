import React from 'react';
import {render,screen,fireEvent,waitFor,cleanup,act} from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {LayoverCurrentPositionCard} from '../LayoverCurrentPositionCard.tsx';
import {requestLocationForUserAction} from '../../../lib/location/locationRequestDoor.ts';
// NOTE: intentionally exhaustive — native SecureStore auth is unavailable in the test host; real preview transport is exercised.
jest.mock('../../../services/apiToken.ts',()=>({freshToken:jest.fn(async()=>'owner-token')}));
jest.mock('../../../lib/location/locationRequestDoor.ts',()=>({...jest.requireActual('../../../lib/location/locationRequestDoor.ts'),requestLocationForUserAction:jest.fn()}));
const gps=jest.mocked(requestLocationForUserAction),recs=[{id:'candidate',snapshotId:'snapshot',insideAirport:false,title:'Museum',routing:{state:'FEASIBLE'}}] as any;
const fix=()=>({granted:true,lat:1.31987654,lng:103.89876543,accuracyMeters:20,observedAtMs:Date.now()});
function transport(over:Record<string,unknown>={}){const fetcher=jest.fn(async(_url:string,init:RequestInit)=>{const body=JSON.parse(String(init.body)),now=Date.now(),iso=(n:number)=>new Date(n).toISOString(),leg={departAt:iso(now),arrivesAt:iso(now+600000),minutes:10,conservativeMinutes:15,expiresAt:iso(now+60000),confidence:'MEDIUM',mode:'drive'};return {ok:true,json:async()=>({ok:true,preview:{requestId:body.requestId,sessionId:'session',snapshotId:body.snapshotId,candidateId:body.candidateId,previewOnly:true,expiresAt:iso(now+60000),hardReturnBy:iso(now+3600000),riskBand:'MODERATE',reasonCodes:[],activityCommitment:null,window:{beginsAt:iso(now),endsAt:iso(now+2700000),usableMinutes:30,confidence:'MEDIUM'},outbound:leg,activityMinutes:20,returnRoute:leg,currentReturn:leg,disclosure:'Preview only',...over}})} as Response;});global.fetch=fetcher as typeof fetch;return fetcher;}
beforeEach(async()=>{jest.clearAllMocks();await AsyncStorage.clear();gps.mockResolvedValue(fix());});
afterEach(cleanup);
it('explicit press alone requests one fix and real transient transport; nothing is saved offline',async()=>{
 const send=transport();await render(<LayoverCurrentPositionCard sessionId="session" recs={recs} timezone="UTC" enabled/>);expect(gps).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
 await fireEvent.press(screen.getByTestId('check-from-location'));await waitFor(()=>expect(screen.getByTestId('current-position-preview')).toBeTruthy());expect(gps).toHaveBeenCalledTimes(1);expect(send).toHaveBeenCalledTimes(1);const [url,init]=send.mock.calls[0]!;expect(url).toContain('/session/current-position-check');expect(init.cache).toBe('no-store');const body=JSON.parse(String(init.body));expect(body.origin.lat).toBe(fix().lat);expect(body.origin.mode).toBe('drive');expect(await AsyncStorage.getAllKeys()).toEqual([]);expect(screen.getByText(/does not start or update your saved experience/)).toBeTruthy();
});
it('denied, stale or inaccurate fixes never reach the API',async()=>{
 for(const value of [{...fix(),granted:false},{...fix(),observedAtMs:Date.now()-180000},{...fix(),accuracyMeters:1001}]){const send=transport();gps.mockResolvedValue(value);await render(<LayoverCurrentPositionCard sessionId="session" recs={recs} timezone="UTC" enabled/>);await fireEvent.press(screen.getByTestId('check-from-location'));expect(send).not.toHaveBeenCalled();expect(screen.getByText(/current, accurate location was unavailable/)).toBeTruthy();await cleanup();}
});
it('copied request identity and expired responses never render usable preview terms',async()=>{
 for(const over of [{requestId:'22222222-2222-4222-8222-222222222222'},{expiresAt:new Date(Date.now()-1000).toISOString()}]){transport(over);await render(<LayoverCurrentPositionCard sessionId="session" recs={recs} timezone="UTC" enabled/>);await fireEvent.press(screen.getByTestId('check-from-location'));expect(screen.queryByTestId('current-position-preview')).toBeNull();expect(screen.getByText(/could not be checked from your location/)).toBeTruthy();await cleanup();}
});
it('a late fix from the previous session is discarded without sending location',async()=>{
 // The session changes while the fix is outstanding: the switch is made from inside the location request and the fix lands a task later, so the press is awaited whole and no act() overlaps.
 let switchSession!:(id:string)=>void;
 function Host(){const [sid,setSid]=React.useState('session');switchSession=setSid;return <LayoverCurrentPositionCard sessionId={sid} recs={recs} timezone="UTC" enabled/>;}
 gps.mockImplementation(async()=>{switchSession('other-session');await new Promise(r=>setTimeout(r,0));return fix();});const send=transport();await render(<Host/>);
 await fireEvent.press(screen.getByTestId('check-from-location'));expect(gps).toHaveBeenCalledTimes(1);expect(send).not.toHaveBeenCalled();expect(screen.queryByTestId('current-position-preview')).toBeNull();
});
it('a measured "not enough time from here" refusal says so, distinct from an unavailable check',async()=>{
 for(const [reason,copy] of [['return_deadline_exceeded',/not enough measured time/],['confidence_insufficient',/not enough measured time/],['PROVIDER_UNAVAILABLE',/could not be checked from your location/]] as const){
  global.fetch=jest.fn(async()=>({ok:false,status:409,json:async()=>({ok:false,reason})}) as unknown as Response) as typeof fetch;
  await render(<LayoverCurrentPositionCard sessionId="session" recs={recs} timezone="UTC" enabled/>);await fireEvent.press(screen.getByTestId('check-from-location'));
  expect(screen.getByText(copy)).toBeTruthy();expect(screen.queryByTestId('current-position-preview')).toBeNull();await cleanup();
 }
});
