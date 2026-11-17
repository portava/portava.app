import { fetchOwnedApi } from '../ownedApiRequest.ts';
import { loadPassportPeople, parseMemoryPeople, setPassportMemorySource } from '../passportMemoryPeople.ts';
// NOTE: intentionally exhaustive — this suite tests response/privacy decoding
// and session-result handling; the shared transport has its own deadline tests.
jest.mock('../ownedApiRequest.ts',()=>({fetchOwnedApi:jest.fn()}));
const id='11111111-1111-4111-8111-111111111111', person='22222222-2222-4222-8222-222222222222';
const ready={state:'ready',sourceId:id,resolvedSourceId:id,anonymousCount:1,participants:[{userId:person,rung:'PROFILE_LINKED',name:'Must not appear',handle:'traveller'}]};
const owner={ownerId:'owner',isCurrent:()=>true} as any;
beforeEach(()=>jest.clearAllMocks());
it('keeps approved identity fields within the stated rung and never carries unknown fields',()=>{
 expect(parseMemoryPeople({...ready,privateContent:'secret'})).toEqual({...ready,participants:[{userId:person,rung:'PROFILE_LINKED',name:null,handle:'traveller'}]});
 expect(parseMemoryPeople({...ready,participants:[{...ready.participants[0],rung:'NAMED'}]})).toEqual({...ready,participants:[{...ready.participants[0],rung:'NAMED'}]});
});
it('malformed or forbidden participant disclosure is unavailable, never an empty successful read',()=>{
 for(const change of [{sourceId:null},{resolvedSourceId:'invalid'},{anonymousCount:-1},{anonymousCount:0.5},{participants:null},
  {participants:[{...ready.participants[0],rung:'HIDDEN'}]},{participants:[{...ready.participants[0],rung:'ANONYMOUS_COUNT'}]},
  {participants:[{...ready.participants[0],userId:'not-an-id'}]}])expect(parseMemoryPeople({...ready,...change})).toEqual({state:'unavailable'});
 expect(parseMemoryPeople(undefined)).toEqual({state:'unavailable'});
 expect(parseMemoryPeople({state:'unlinked',participants:ready.participants})).toEqual({state:'unlinked'});
});
it('a successful body from an old account cannot cross the initiating owner boundary',async()=>{
 let current=true;jest.mocked(fetchOwnedApi).mockResolvedValue({ok:true,status:200,json:async()=>{current=false;return {memories:[{id,title:'Private',people:ready}]};}} as any);
 expect((await loadPassportPeople({...owner,isCurrent:()=>current})).ok).toBe(false);
});
it('writes include the expected source and malformed acknowledgements remain unconfirmed',async()=>{
 jest.mocked(fetchOwnedApi).mockResolvedValue({ok:true,status:200,json:async()=>({memoryId:'different'})} as any);
 expect((await setPassportMemorySource(owner,id,person,null)).ok).toBe(false);
 expect(fetchOwnedApi).toHaveBeenCalledWith(`/api/me/passport/memories/${id}/source`,{owner,method:'POST',body:{memoryId:person,expectedMemoryId:null}});
});
it('failed reads and unrecognized payloads never become an empty People collection',async()=>{
 for(const response of [{ok:false,status:503,json:async()=>({message:'Unavailable'})},{ok:true,status:200,json:async()=>({})}]){
  jest.mocked(fetchOwnedApi).mockResolvedValue(response as any);expect((await loadPassportPeople(owner)).ok).toBe(false);
 }
});
