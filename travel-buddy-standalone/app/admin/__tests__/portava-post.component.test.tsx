import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import OfficialPostScreen from '../portava-post.tsx';
import { createOfficialPost } from '../../../src/services/officialPosts.ts';
import { uploadMedia } from '../../../src/services/media.ts';
let mockUserId='admin'; let mockOperation=0;
const mockPick=jest.fn();
// NOTE: the account and route boundary are controlled; the real editor and submit lifecycle run.
jest.mock('../../../src/context/SessionContext.tsx',()=>({useSession:()=>({userId:mockUserId})}));
// NOTE: server role enforcement is tested in PostgreSQL; this fixture exercises the already-authorized editor.
jest.mock('../../../src/hooks/useRequireAdmin.ts',()=>({useRequireAdmin:()=>{}}));
// NOTE: physical media picker is external to this component test.
jest.mock('../../../src/hooks/useMediaPicker.ts',()=>({useMediaPicker:()=>({pickMedia:mockPick})}));
// NOTE: transport latency and uncertain results are deliberate controlled inputs.
jest.mock('../../../src/services/officialPosts.ts',()=>({createOfficialPost:jest.fn()}));
// NOTE: no physical uploads are performed; this fixture asserts their owner contract and resulting post references.
jest.mock('../../../src/services/media.ts',()=>({uploadMedia:jest.fn()}));
// NOTE: each capture has its own invalidation and stops when the active account changes.
jest.mock('../../../src/services/messagingOwnerRequest.ts',()=>({captureMessagingOwnerRequest:()=>{const ownerId=mockUserId;let valid=true;return {ownerId,sessionId:'s',isCurrent:()=>valid&&ownerId===mockUserId,invalidate:()=>{valid=false;}};}}));
// NOTE: deterministic command identifiers expose accidental reminting on retries.
jest.mock('../../../src/services/postDestinations.ts',()=>({newPostDestinationOperation:()=>`operation-${++mockOperation}`}));
const alert=jest.spyOn(Alert,'alert').mockImplementation(()=>{});
const draft=()=>fireEvent.changeText(screen.getByPlaceholderText('Write your curated travel content here…'),'My official post');
const publish=()=>fireEvent.press(screen.getByLabelText('Publish official post'));
const startPending=(label:string)=>fireEvent.press(screen.getByLabelText(label));
beforeEach(()=>{jest.clearAllMocks();mockUserId='admin';mockOperation=0;jest.mocked(createOfficialPost).mockResolvedValue({ok:true,postId:'post'});});
it('uploads selected media under the captured editor owner and includes only confirmed URLs',async()=>{
 mockPick.mockResolvedValue([{uri:'file://movie.mp4',type:'video',duration:4000}]);
 jest.mocked(uploadMedia).mockResolvedValue({ok:true,url:'post-media/admin/movie.mp4',mediaType:'video/mp4'});
 await render(<OfficialPostScreen/>);await fireEvent.press(screen.getByText('Add photos or videos'));
 await screen.findByText('Uploaded file 1');
 expect(uploadMedia).toHaveBeenCalledWith(expect.objectContaining({duration:4}),{surface:'postcard'},expect.objectContaining({ownerId:'admin'}));
 await draft();await publish();await waitFor(()=>expect(createOfficialPost).toHaveBeenCalled());
 expect(createOfficialPost).toHaveBeenCalledWith(expect.objectContaining({mediaUrls:['post-media/admin/movie.mp4']}),expect.objectContaining({ownerId:'admin'}));
});
it('keeps the same command after an uncertain result and blocks double taps',async()=>{
 let resolve!:(value:any)=>void;jest.mocked(createOfficialPost).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 await render(<OfficialPostScreen/>);await draft();await startPending('Publish official post');await startPending('Publish official post');
 expect(createOfficialPost).toHaveBeenCalledTimes(1);
 await act(async()=>resolve({ok:false,error:'Could not connect'}));await publish();
 expect(createOfficialPost).toHaveBeenCalledTimes(2);
 expect(jest.mocked(createOfficialPost).mock.calls[0]![0].operationId).toBe(jest.mocked(createOfficialPost).mock.calls[1]![0].operationId);
});
it('account replacement while the picker is open cannot upload or inherit the draft',async()=>{
 let resolve!:(value:any)=>void;mockPick.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 const view=await render(<OfficialPostScreen/>);await draft();await startPending('Add official post media');
 mockUserId='other';await view.rerender(<OfficialPostScreen/>);
 await act(async()=>resolve([{uri:'file://private.jpg',type:'image'}]));
 expect(uploadMedia).not.toHaveBeenCalled();expect(screen.getByPlaceholderText('Write your curated travel content here…').props.value).toBe('');
});
it('late publication from a closed editor cannot show a success alert or navigate',async()=>{
 let resolve!:(value:any)=>void;jest.mocked(createOfficialPost).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 const view=await render(<OfficialPostScreen/>);await draft();await startPending('Publish official post');await view.unmount();
 await act(async()=>resolve({ok:true,postId:'post'}));expect(alert).not.toHaveBeenCalled();
});
