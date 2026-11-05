let mockCurrent = true;
let mockToken: string | null = 'token';
// NOTE: auth/session boundary is controlled without constructing the native auth client.
jest.mock('../messagingOwnerRequest.ts', () => ({ captureMessagingOwnerRequest: jest.fn(), messagingOwnerToken: async () => mockToken }));
import { postReferenceId, POST_REFERENCE_MEDIA_TYPE, savePostToDestination, readPostReference } from '../postDestinations.ts';
const owner = { ownerId: 'owner', sessionId: 'session', isCurrent: () => mockCurrent, invalidate: jest.fn() };
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const realFetch=globalThis.fetch;
const response=(data:unknown,status=200)=>({ok:status<300,status,json:async()=>data}) as Response;
beforeEach(()=>{mockCurrent=true;mockToken='token';});
afterEach(()=>{globalThis.fetch=realFetch;});
it('requires explicit reference type and a valid opaque identifier',()=>{
 expect(postReferenceId(POST_REFERENCE_MEDIA_TYPE,`portava-post-reference:${id}`)).toBe(id);
 expect(postReferenceId('image/jpeg',`portava-post-reference:${id}`)).toBeNull();
 expect(postReferenceId(POST_REFERENCE_MEDIA_TYPE,'https://example.com/a.jpg')).toBeNull();
 expect(postReferenceId(POST_REFERENCE_MEDIA_TYPE,`portava-post-reference:${id}/extra`)).toBeNull();
});
it('refuses a superseded account before making any request',async()=>{
 mockCurrent=false;globalThis.fetch=jest.fn();
 expect((await savePostToDestination(id,{operationId:id,destination:'memory'},owner)).ok).toBe(false);
 expect(globalThis.fetch).not.toHaveBeenCalled();
});
it('rejects a successful answer arriving after account replacement',async()=>{
 globalThis.fetch=jest.fn(async()=>{mockCurrent=false;return response({referenceId:id,memoryId:id,highlightId:null});});
 expect((await savePostToDestination(id,{operationId:id,destination:'memory'},owner)).ok).toBe(false);
});
it('does not report malformed receipts as a completed save',async()=>{
 globalThis.fetch=jest.fn(async()=>response({referenceId:id,memoryId:null,highlightId:id}));
 expect((await savePostToDestination(id,{operationId:id,destination:'memory'},owner)).ok).toBe(false);
});
it('preserves the exact operation through transport retry and never adds an actor id',async()=>{
 globalThis.fetch=jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response({referenceId:id,memoryId:id,highlightId:null}));
 const intent={operationId:id,destination:'memory' as const,title:'Kyoto',visibility:'only_me' as const};
 await savePostToDestination(id,intent,owner);expect((await savePostToDestination(id,intent,owner)).ok).toBe(true);
 const calls=jest.mocked(globalThis.fetch).mock.calls;
 expect(calls[0][1]?.body).toBe(calls[1][1]?.body);expect(JSON.parse(String(calls[0][1]?.body))).toEqual(intent);
});
it('accepts unavailable cards but refuses malformed source projections',async()=>{
 globalThis.fetch=jest.fn().mockResolvedValueOnce(response({available:false})).mockResolvedValueOnce(response({available:true,postId:'../elsewhere',author:'A',text:'B'}));
 expect(await readPostReference(id,owner)).toEqual({ok:true,data:{available:false}});
 expect((await readPostReference(id,owner)).ok).toBe(false);
});
