import{createTripNearbyRun}from'../tripNearbyRun.ts';
import{NEARBY_CHARACTERISTIC,parseNearbyResult,nearbyRssiBucket}from'../tripNearby.ts';
// NOTE: isolated external native/auth/network seam; this fixture supplies exactly the exports used by the mounted card or controller.
jest.mock('../tripNearbyNative.ts',()=>({tripNearbyNative:null}));
// NOTE: isolated external native/auth/network seam; this fixture supplies exactly the exports used by the mounted card or controller.
jest.mock('../ownedApiRequest.ts',()=>({fetchOwnedApi:jest.fn()}));
const trip='11111111-1111-4111-8111-111111111111',session='22222222-2222-4222-8222-222222222222';
const NOW=Date.parse('2026-11-05T14:00:00Z');
function fixture(sharedNative?:any){
 let current=true;const listeners:Record<string,(v:any)=>void>={};
 const native=sharedNative??{start:jest.fn(async(_options:any)=>{}),stop:jest.fn(async()=>{}),capabilities:jest.fn(),addListener:jest.fn((name:string,fn:(v:any)=>void)=>{listeners[name]=fn;return{remove:jest.fn(()=>delete listeners[name])};})};
 const active=()=>({state:'active',sessionId:session,expiresAt:new Date(NOW+300000).toISOString(),serverNow:new Date(Date.now()).toISOString(),peers:[],lease:{serviceUuid:trip,characteristicUuid:NEARBY_CHARACTERISTIC,token:'a'.repeat(64),expiresAt:new Date(Date.now()+59000).toISOString()}});
 const command=jest.fn<Promise<any>,[string,string,any?,any?]>(async(_trip:string,action:string)=>action==='stop'?{state:'stopped'}:action==='observe'?{state:'active',accepted:true}:active());
 const states=jest.fn(),peers=jest.fn();const run=createTripNearbyRun({tripId:trip,sessionId:session,durationMinutes:5,owner:{ownerId:'owner',sessionId:'auth',isCurrent:()=>current,invalidate:()=>{current=false;}},onState:states,onPeers:peers},native as any,command as any);
 return{run,native,command,listeners,states,peers,active,replaceOwner:()=>{current=false;}};
}
beforeEach(()=>{jest.useFakeTimers();jest.setSystemTime(NOW);});afterEach(()=>{jest.useRealTimers();});
test('radio starts only with a bounded consent response and reports coarse tokens, never coordinates',async()=>{
 const f=fixture();expect(f.native.start).not.toHaveBeenCalled();await f.run.start();
 expect(f.command).toHaveBeenCalledWith(trip,'start',{sessionId:session,consentVersion:'trip-nearby-v1',durationMinutes:5},expect.any(Object));
 expect(f.native.start.mock.calls[0][0]).toMatchObject({token:'a'.repeat(64),expiresAtMs:NOW+58500});
 f.listeners.onCheckpoint({token:'b'.repeat(64),rssi:-63,observedAtMs:NOW});await Promise.resolve();
 const observation=f.command.mock.calls.find(c=>c[1]==='observe')![2];expect(Object.keys(observation).sort()).toEqual(['observedAt','proximity','sessionId','token']);expect(observation.proximity).toBe('nearby');await f.run.stop();
});
test('stop fences a late server grant before native startup and revokes the known operation',async()=>{
 const f=fixture();let resolve!:(v:any)=>void;f.command.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 const starting=f.run.start();await Promise.resolve();await f.run.stop();resolve(f.active());await starting;
 expect(f.native.start).not.toHaveBeenCalled();expect(f.command).toHaveBeenCalledWith(trip,'stop',{sessionId:session},expect.any(Object));
});
test('replaced account suppresses radio events and stops at the next heartbeat',async()=>{
 const f=fixture();await f.run.start();f.replaceOwner();f.listeners.onCheckpoint({token:'b'.repeat(64),rssi:-50,observedAtMs:NOW});
 await jest.advanceTimersByTimeAsync(5000);expect(f.command.mock.calls.some(c=>c[1]==='observe')).toBe(false);expect(f.native.stop).toHaveBeenCalled();expect(f.states).toHaveBeenLastCalledWith('stopped',undefined);
});
test('failed current consent/read check stops native activity and clears peers',async()=>{
 const f=fixture();await f.run.start();f.command.mockImplementation(async(_t,a)=>{if(a==='read')throw Error('offline');return{state:'stopped'};});
 await jest.advanceTimersByTimeAsync(5000);expect(f.native.stop).toHaveBeenCalled();expect(f.peers).toHaveBeenLastCalledWith([]);expect(f.states).toHaveBeenLastCalledWith('unavailable',expect.stringContaining('connection'));await f.run.stop();
});
test('an unavailable server or oversized lease never starts the radio',async()=>{
 const f=fixture();f.command.mockResolvedValueOnce({state:'disabled'});await f.run.start();expect(f.native.start).not.toHaveBeenCalled();
 const invalid=f.active();invalid.lease.expiresAt=new Date(NOW+61000).toISOString();expect(()=>parseNearbyResult(invalid)).toThrow('radio lease');await f.run.stop();
});
test('radio strength is a coarse nullable observation',()=>{expect(nearbyRssiBucket(-50)).toBe('very_close');expect(nearbyRssiBucket(-80)).toBe('within_area');for(const n of[0,NaN,-200])expect(nearbyRssiBucket(n)).toBeNull();});
test('displayed peer expires locally even between server refreshes',async()=>{
 const f=fixture();f.command.mockResolvedValueOnce({...f.active(),peers:[{userId:trip,handle:'peer',proximity:'nearby',observedAt:new Date(NOW).toISOString(),expiresAt:new Date(NOW+2000).toISOString()}]});
 await f.run.start();expect(f.peers).toHaveBeenLastCalledWith([expect.objectContaining({handle:'peer'})]);await jest.advanceTimersByTimeAsync(2000);expect(f.peers).toHaveBeenLastCalledWith([]);await f.run.stop();
});

test.each(['resolve','reject'])('late native start %s from a replaced controller cannot stop the new radio owner',async(terminal)=>{
 const first=fixture();let release!:()=>void;let reject!:(error:Error)=>void;
 first.native.start.mockImplementationOnce(()=>new Promise<void>((yes,no)=>{release=yes;reject=no;}));
 const starting=first.run.start();for(let i=0;i<4;i++)await Promise.resolve();
 const second=fixture(first.native);await second.run.start();
 expect(first.native.start).toHaveBeenCalledTimes(2);
 const stopCount=first.native.stop.mock.calls.length;
 if(terminal==='resolve')release();else reject(Error('old permission cancelled'));
 await starting;
 expect(first.native.stop).toHaveBeenCalledTimes(stopCount);
 expect(second.states).toHaveBeenLastCalledWith('active');await second.run.stop();
});
test('competing acquisitions during an old stop allow only the newest controller to start',async()=>{
 const old=fixture();await old.run.start();let finishStop!:()=>void;
 old.native.stop.mockImplementationOnce(()=>new Promise<void>(resolve=>{finishStop=resolve;}));
 const stale=fixture(old.native);const pending=stale.run.start();await Promise.resolve();
 const newest=fixture(old.native);const newestStarting=newest.run.start();for(let i=0;i<4;i++)await Promise.resolve();
 expect(old.native.start).toHaveBeenCalledTimes(1);finishStop();await newestStarting;await pending;
 expect(stale.command.mock.calls.some((call:any[])=>call[1]==='start')).toBe(false);
 expect(newest.states).toHaveBeenLastCalledWith('active');expect(old.native.start).toHaveBeenCalledTimes(2);
 await newest.run.stop();
});
