import {createOfficialPost} from '../officialPosts.ts';
import {messagingOwnerToken} from '../messagingOwnerRequest.ts';
// NOTE: network authentication is controlled to test token-resolution and response races.
jest.mock('../messagingOwnerRequest.ts',()=>({messagingOwnerToken:jest.fn()}));
let current=true;const owner={ownerId:'admin',sessionId:'session',isCurrent:()=>current,invalidate:()=>{current=false;}};
const originalFetch=globalThis.fetch;
beforeEach(()=>{current=true;jest.clearAllMocks();jest.mocked(messagingOwnerToken).mockResolvedValue('token');globalThis.fetch=jest.fn();});
afterAll(()=>{globalThis.fetch=originalFetch;});
it('sends the exact command with the owner token and validates its receipt',async()=>{
 jest.mocked(fetch).mockResolvedValue({ok:true,json:async()=>({post:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}})} as Response);
 const body={operationId:'op',content:'Post'};expect((await createOfficialPost(body,owner)).ok).toBe(true);
 expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/admin/portava/posts'),expect.objectContaining({body:JSON.stringify(body),headers:expect.objectContaining({Authorization:'Bearer token'})}));
});
it('an account change during token refresh sends nothing',async()=>{
 jest.mocked(messagingOwnerToken).mockImplementation(async()=>{current=false;return 'other-token';});
 expect((await createOfficialPost({content:'Post'},owner)).ok).toBe(false);expect(fetch).not.toHaveBeenCalled();
});
it('an account change while reading the result discards it',async()=>{
 jest.mocked(fetch).mockResolvedValue({ok:true,json:async()=>{current=false;return {post:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}};}} as Response);
 expect((await createOfficialPost({content:'Post'},owner)).ok).toBe(false);
});
it('malformed success is an uncertain result, not an invented post',async()=>{
 jest.mocked(fetch).mockResolvedValue({ok:true,json:async()=>({post:{}})} as Response);
 expect(await createOfficialPost({content:'Post'},owner)).toEqual({ok:false,error:expect.stringContaining('could not be confirmed')});
});
