// NOTE: SDK events are controlled; real owner snapshots, token transport,
// observation accumulator, hook and HTTP sender run without mocks.
jest.mock('../../lib/supabase.ts',()=>{const listeners=new Set();return {isSupabaseConfigured:true,supabase:{auth:{listeners,onAuthStateChange:(listener:unknown)=>{listeners.add(listener);return{data:{subscription:{unsubscribe:()=>listeners.delete(listener)}}};}}}};});
const mockFlags={enabled:true};
// NOTE: the single existing ranking flag is the policy input under test.
jest.mock('../../context/FeatureFlagsContext.tsx',()=>({useFeatureFlags:()=>({isEnabled:()=>mockFlags.enabled})}));
import { renderHook, act } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { useWatchViewReporting } from '../useWatchViewReporting.ts';
import { WatchViewObservation } from '../../services/watchViewObservation.ts';
import { _setTestSupabase, _resetTestSupabase } from '../../services/apiToken.ts';
import { seedObservedOwnerSession,disposeObservedOwnerSession,observedOwnerAccessToken,emitObservedAuthEvent,observedOwnerSession } from '../../services/__tests__/observedOwnerSessionFixture.ts';
import { setDiscoveryViewerFromSession } from '../../services/discoveryViewerScope.ts';

const mediaId='11111111-0000-4000-8000-000000000001';
const sessionId='22222222-0000-4000-8000-000000000001';
const originalFetch=globalThis.fetch, originalBase=process.env.EXPO_PUBLIC_API_BASE_URL;
const fetchMock=jest.fn();
const sample=(positionMillis:number,extra={})=>({isLoaded:true,isPlaying:true,isBuffering:false,positionMillis,durationMillis:12000,rate:1,...extra});
function sdk(getSession=async()=>({data:{session:{access_token:observedOwnerAccessToken('owner-a','auth-a'),expires_at:Date.now()/1000+3600}}})){
  _setTestSupabase({auth:{getSession}} as any);
}
async function settle(){await act(async()=>{for(let i=0;i<30;i++)await Promise.resolve();});}
beforeEach(()=>{
  jest.useFakeTimers();jest.setSystemTime(10000);mockFlags.enabled=true;
  Object.defineProperty(AppState,'currentState',{configurable:true,value:'active',writable:true});
  setDiscoveryViewerFromSession('owner-a');seedObservedOwnerSession('owner-a','auth-a');sdk();
  process.env.EXPO_PUBLIC_API_BASE_URL='https://api.test';globalThis.fetch=fetchMock;
  fetchMock.mockReset();fetchMock.mockResolvedValue({ok:true,status:200,json:async()=>({counted:true,stored:true,duplicate:false})});
});
afterEach(()=>{disposeObservedOwnerSession();setDiscoveryViewerFromSession(null);_resetTestSupabase();jest.useRealTimers();globalThis.fetch=originalFetch;
  if(originalBase===undefined)delete process.env.EXPO_PUBLIC_API_BASE_URL;else process.env.EXPO_PUBLIC_API_BASE_URL=originalBase;
});

it('emits observed impression and qualified view with UUID identity, never a preload',async()=>{
  const h=await renderHook(()=>useWatchViewReporting({mediaId,sessionId,visible:true,eligible:true}));
  await act(async()=>h.result.current(sample(0,{isPlaying:false})));expect(fetchMock).not.toHaveBeenCalled();
  await act(async()=>h.result.current(sample(0)));
  for(let position=500;position<=3500;position+=500){jest.setSystemTime(10000+position);await act(async()=>h.result.current(sample(position)));}
  await settle();
  const bodies=fetchMock.mock.calls.map(([,init])=>JSON.parse(init.body));
  expect(bodies.map(body=>body.type)).toEqual(['impression','qualified_view']);
  for(const body of bodies){expect(body.sessionId).toBe(sessionId);expect(body.eventId).toMatch(/^[a-f0-9-]{36}$/i);expect(Object.keys(body).sort()).toEqual(['eventId','sessionId','type','watchedMs']);}
});
it('suppresses background, buffering, paused, scrub, stale source and disabled callbacks',async()=>{
  const h=await renderHook((props:{id:string;eligible:boolean})=>useWatchViewReporting({mediaId:props.id,sessionId,visible:true,eligible:props.eligible}),{initialProps:{id:mediaId,eligible:true}});
  const old=h.result.current;
  await act(async()=>old(sample(0)));AppState.currentState='background';jest.setSystemTime(10500);
  await act(async()=>old(sample(500)));expect(fetchMock).not.toHaveBeenCalled();AppState.currentState='active';
  await h.rerender({id:mediaId,eligible:false});await act(async()=>h.result.current(sample(1000)));expect(fetchMock).not.toHaveBeenCalled();
  await h.rerender({id:sessionId,eligible:true});jest.setSystemTime(11000);await act(async()=>old(sample(1500)));expect(fetchMock).not.toHaveBeenCalled();
  mockFlags.enabled=false;await h.rerender({id:sessionId,eligible:true});await act(async()=>h.result.current(sample(2000)));expect(fetchMock).not.toHaveBeenCalled();
});
it('drops the initiating account event when token acquisition resolves after an account switch',async()=>{
  let resolve!: (value:any)=>void;sdk(()=>new Promise(done=>{resolve=done;}));
  const h=await renderHook(()=>useWatchViewReporting({mediaId,sessionId,visible:true,eligible:true}));
  await act(async()=>h.result.current(sample(0)));jest.setSystemTime(10500);await act(async()=>h.result.current(sample(500)));
  emitObservedAuthEvent('SIGNED_IN',observedOwnerSession('owner-b','auth-b'));setDiscoveryViewerFromSession('owner-b');
  resolve({data:{session:{access_token:observedOwnerAccessToken('owner-b','auth-b'),expires_at:Date.now()/1000+3600}}});await settle();expect(fetchMock).not.toHaveBeenCalled();
});
it('accumulator ignores seeks and long gaps; counts bounded completion and replay from observed playback',()=>{
  const tracker=new WatchViewObservation();const out:string[]=[];
  tracker.sample(sample(0),true,0);tracker.sample(sample(11000),true,500); // seek, no duration credited
  tracker.pause();tracker.sample(sample(0),true,1000);
  for(let position=500;position<=12000;position+=500)out.push(...tracker.sample(sample(position,{didJustFinish:position===12000}),true,1000+position).map(e=>e.type));
  tracker.sample(sample(0),true,13500);
  for(let position=500;position<=3500;position+=500)out.push(...tracker.sample(sample(position),true,13500+position).map(e=>e.type));
  expect(out).toEqual(['impression','qualified_view','completion','rewatch']);
  tracker.reset();tracker.sample(sample(0),true,0);expect(tracker.sample(sample(60000),true,60000)).toEqual([]);
});
