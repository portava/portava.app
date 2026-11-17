// NOTE: SDK events and network responses are controlled; actual feed hook,
// request ownership, response mapping and session generation run.
jest.mock('../../lib/supabase.ts',()=>{const listeners=new Set();return {isSupabaseConfigured:true,supabase:{auth:{listeners,onAuthStateChange:(listener:unknown)=>{listeners.add(listener);return {data:{subscription:{unsubscribe:()=>listeners.delete(listener)}}};}}}};});
import { renderHook, act } from '@testing-library/react-native';
import { useWatchFeed } from '../useWatchFeed.ts';
import { _setTestSupabase, _resetTestSupabase } from '../../services/apiToken.ts';
import { seedObservedOwnerSession,disposeObservedOwnerSession,observedOwnerAccessToken,emitObservedAuthEvent,observedOwnerSession } from '../../services/__tests__/observedOwnerSessionFixture.ts';
import { setDiscoveryViewerFromSession } from '../../services/discoveryViewerScope.ts';

const originalFetch=globalThis.fetch,originalBase=process.env.EXPO_PUBLIC_API_BASE_URL;
const fetchMock=jest.fn();
function sdk(getSession=async()=>({data:{session:{access_token:observedOwnerAccessToken('owner-a','auth-a'),expires_at:Date.now()/1000+3600}}})){
  _setTestSupabase({auth:{getSession}} as any);
}
const response=(sessionId:string,nextCursor:string|null=null)=>({ok:true,status:200,json:async()=>({items:[],sessionId,nextCursor})});
async function settle(){await act(async()=>{for(let i=0;i<30;i++)await Promise.resolve();});}
beforeEach(()=>{setDiscoveryViewerFromSession('owner-a');seedObservedOwnerSession('owner-a','auth-a');sdk();
  process.env.EXPO_PUBLIC_API_BASE_URL='https://api.test';fetchMock.mockReset();globalThis.fetch=fetchMock;
});
afterEach(()=>{disposeObservedOwnerSession();setDiscoveryViewerFromSession(null);_resetTestSupabase();globalThis.fetch=originalFetch;
  if(originalBase===undefined)delete process.env.EXPO_PUBLIC_API_BASE_URL;else process.env.EXPO_PUBLIC_API_BASE_URL=originalBase;
});
it('sends UUID sessions and ignores an older refresh response after a newer refresh commits',async()=>{
  let finishOld!:(value:any)=>void;
  fetchMock.mockImplementationOnce(()=>new Promise(resolve=>{finishOld=resolve;})).mockImplementationOnce(async(url:string)=>response(new URL(url).searchParams.get('sessionId')!));
  const h=await renderHook(()=>useWatchFeed());let first!:Promise<void>;
  await act(async()=>{first=h.result.current.loadFeed();});await settle();
  expect(h.result.current.error).toBeNull();
  const oldSession=new URL(fetchMock.mock.calls[0][0]).searchParams.get('sessionId')!;
  expect(oldSession).toMatch(/^[0-9a-f-]{36}$/i);
  await act(async()=>{await h.result.current.loadFeed();});
  const latest=h.result.current.sessionId;expect(latest).not.toBe(oldSession);
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  finishOld(response(oldSession,'stale-cursor'));await act(async()=>{await first;});
  expect(h.result.current.sessionId).toBe(latest);expect(h.result.current.loading).toBe(false);
  await act(async()=>{await h.result.current.loadMore();});expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('never sends old feed work with the next account token',async()=>{
  let resolve!:(value:any)=>void;sdk(()=>new Promise(done=>{resolve=done;}));
  const h=await renderHook(()=>useWatchFeed());let pending!:Promise<void>;
  await act(async()=>{pending=h.result.current.loadFeed();});await settle();
  emitObservedAuthEvent('SIGNED_IN',observedOwnerSession('owner-b','auth-b'));setDiscoveryViewerFromSession('owner-b');
  resolve({data:{session:{access_token:observedOwnerAccessToken('owner-b','auth-b'),expires_at:Date.now()/1000+3600}}});
  await act(async()=>{await pending;});expect(fetchMock).not.toHaveBeenCalled();expect(h.result.current.items).toEqual([]);
});
it('unmount aborts pending response decoding and prevents stale feed adoption',async()=>{
  let decode!:(value:any)=>void;fetchMock.mockResolvedValue({ok:true,status:200,json:()=>new Promise(resolve=>{decode=resolve;})});
  const h=await renderHook(()=>useWatchFeed());let pending!:Promise<void>;
  await act(async()=>{pending=h.result.current.loadFeed();});await settle();await h.unmount();
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  decode({items:[],sessionId:'stale',nextCursor:'stale'});await act(async()=>{await pending;});
});
