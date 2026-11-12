import { getThreadMessages, resumeThreadMessages } from '../messaging.ts';
import { realCryptoPort } from '../../lib/e2ee/realPort.ts';
import { seedObservedOwnerSession, disposeObservedOwnerSession, observedOwnerAccessToken } from './observedOwnerSessionFixture.ts';
import { setDiscoveryViewerFromSession } from '../discoveryViewerScope.ts';
jest.mock('../../lib/supabase.ts', () => {
  const listeners = new Set();
  return { isSupabaseConfigured: true, supabase: { auth: { listeners, onAuthStateChange: (listener: unknown) => { listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } }; } } } };
});
// NOTE: only the token transport is synthetic; owner observation remains real.
jest.mock('../apiToken.ts', () => ({ freshToken: async () => require('./observedOwnerSessionFixture.ts').observedOwnerAccessToken('owner-a', 'session-a'), isCurrentSessionToken: async () => true }));
// NOTE: native operations are suspended here to test the real request/owner fences; SQLCipher has its own integration suite.
jest.mock('../../lib/e2ee/realPort.ts', () => ({ realCryptoPort: {
  isNative: () => true, hasGroupSession: jest.fn(), decryptFromThread: jest.fn(), reconcileMessage: jest.fn(),
} }));
const port=jest.mocked(realCryptoPort), originalFetch=global.fetch;
const row={id:'one',threadId:'thread',msgType:'text',subtype:null,ciphertext:'opaque',body:'unsafe fallback',displayBody:'old translation',originalBody:'old original',deleted:false};
beforeEach(()=>{
 setDiscoveryViewerFromSession('owner-a');seedObservedOwnerSession('owner-a','session-a');
 process.env.EXPO_PUBLIC_API_BASE_URL='https://api.test';
 port.hasGroupSession.mockReset().mockResolvedValue(true);port.decryptFromThread.mockReset().mockResolvedValue('decrypted');port.reconcileMessage.mockReset().mockResolvedValue(undefined);
 global.fetch=jest.fn(async()=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({threadId:'thread',messages:[row]})} as unknown as Response));
});
afterEach(()=>{global.fetch=originalFetch;disposeObservedOwnerSession();setDiscoveryViewerFromSession(null);});
it('hydrates only the authorized row and replaces every stale plaintext display field',async()=>{
 const response=await getThreadMessages('thread');expect(response.ok).toBe(true);
 expect(response.data?.messages[0]).toMatchObject({body:'decrypted',displayBody:'decrypted',originalBody:'decrypted',e2eeFailed:false});
 expect(port.reconcileMessage).toHaveBeenCalledWith('thread','one','opaque',false,expect.objectContaining({ownerId:'owner-a',sessionId:'session-a'}));
});
it.each(['history','resume'])('discards late %s decryption after an account switch',async(surface)=>{
 let release!:(value:string)=>void;port.decryptFromThread.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
 const work=surface==='history'?getThreadMessages('thread'):resumeThreadMessages('thread',0);
 for(let i=0;i<300&&!release;i++)await Promise.resolve();expect(release).toBeDefined();
 setDiscoveryViewerFromSession('owner-b');seedObservedOwnerSession('owner-b','session-b');release('private from old account');
 expect(await work).toMatchObject({ok:false,data:null,errorKind:'unauthenticated'});
});
it('native key/storage failure renders an unreadable row without server fallback text',async()=>{
 port.hasGroupSession.mockRejectedValue(new Error('native storage unavailable'));
 const response=await getThreadMessages('thread');
 expect(response.data?.messages[0]).toMatchObject({body:'',displayBody:'',originalBody:'',e2eeFailed:true});
 expect(port.decryptFromThread).not.toHaveBeenCalled();
});
it('canonical tombstones erase cached bodies even when the server omits ciphertext',async()=>{
 global.fetch=jest.fn(async()=>({ok:true,status:200,json:async()=>({threadId:'thread',messages:[{...row,deleted:true,ciphertext:null}]})} as unknown as Response));
 const response=await getThreadMessages('thread');expect(response.data?.messages[0]).toMatchObject({deleted:true,body:'',displayBody:'',originalBody:''});
 expect(port.reconcileMessage).toHaveBeenCalledWith('thread','one',null,true,expect.objectContaining({ownerId:'owner-a'}));
 expect(port.decryptFromThread).not.toHaveBeenCalled();
});
