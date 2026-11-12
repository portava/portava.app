import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PostSaveDestinationPanel } from '../PostSaveDestinationPanel.tsx';
import * as api from '../../services/postDestinations.ts';
let mockCurrent=true;const mockOwner={ownerId:'me',sessionId:'session',isCurrent:()=>mockCurrent,invalidate:()=>{}};
// NOTE: real account construction and network are external boundaries for this panel fixture.
jest.mock('../../context/SessionContext.tsx',()=>({useSession:()=>({userId:'me'})}));
// NOTE: only the controlled transport and owner lifecycle are replaced; the panel behavior is real.
jest.mock('../../services/postDestinations.ts',()=>({capturePostDestinationOwner:()=>mockOwner,listPostDestinationMemories:jest.fn(),savePostToDestination:jest.fn(),newPostDestinationOperation:jest.fn(()=> 'op-1')}));
const saved={referenceId:'reference',memoryId:'memory',highlightId:null};
const onSaved=jest.fn(),onCancel=jest.fn();
// NOTE: the live source card and its permissions are exercised by PostReferenceCard.component.test.
jest.mock('../PostReferenceCard.tsx', () => ({ PostSharePreview: (props: any) => require('react').createElement(require('react-native').View, { testID: 'draft-preview', ...props }) }));
const props={postId:'post',active:true,onSaved,onCancel,destination:'memory' as const};
beforeEach(()=>{jest.clearAllMocks();mockCurrent=true;jest.mocked(api.listPostDestinationMemories).mockResolvedValue({ok:true,data:{memories:[],nextCursor:null}});jest.mocked(api.savePostToDestination).mockResolvedValue({ok:true,data:saved});});
it('creates a named private Memory and reports its real destination id',async()=>{
 await render(<PostSaveDestinationPanel {...props}/>);await fireEvent.changeText(screen.getByLabelText('Memory name'),'Japan');
 await fireEvent.press(screen.getByLabelText('Save post to Memory'));
 await waitFor(()=>expect(onSaved).toHaveBeenCalledWith(saved));
 expect(api.savePostToDestination).toHaveBeenCalledWith('post',expect.objectContaining({title:'Japan',visibility:'only_me',operationId:'op-1',memoryId:null}),mockOwner);
});
it('requires a name before saving a new Memory',async()=>{
 await render(<PostSaveDestinationPanel {...props}/>);await fireEvent.press(screen.getByLabelText('Save post to Memory'));
 expect(screen.getByText('Name your new Memory first.')).toBeTruthy();expect(api.savePostToDestination).not.toHaveBeenCalled();
});
it('selects an existing Memory and communicates its unchanged audience',async()=>{
 jest.mocked(api.listPostDestinationMemories).mockResolvedValue({ok:true,data:{memories:[{id:'existing',ownerId:'me',title:'Food',state:'published',visibility:'friends_only'} as any],nextCursor:null}});
 await render(<PostSaveDestinationPanel {...props}/>);await waitFor(()=>expect(screen.getByText('Food')).toBeTruthy());await fireEvent.press(screen.getByText('Food'));
 expect(screen.getByText('Uses this Memory’s existing audience: friends only.')).toBeTruthy();await fireEvent.press(screen.getByLabelText('Save post to Memory'));
 expect(api.savePostToDestination).toHaveBeenCalledWith('post',expect.objectContaining({memoryId:'existing',title:null}),mockOwner);
});
it('shows read failure and retries without claiming there are no Memories',async()=>{
 jest.mocked(api.listPostDestinationMemories).mockResolvedValueOnce({ok:false,message:'Memories unavailable'});
 await render(<PostSaveDestinationPanel {...props}/>);await waitFor(()=>expect(screen.getByText('Memories unavailable')).toBeTruthy());await fireEvent.press(screen.getByText('Retry Memories'));
 await waitFor(()=>expect(api.listPostDestinationMemories).toHaveBeenCalledTimes(2));
});
it('retains the same exact retry operation and disables duplicate taps',async()=>{
 let resolve!:(value:any)=>void;jest.mocked(api.savePostToDestination).mockReturnValueOnce(new Promise(done=>{resolve=done;}));
 await render(<PostSaveDestinationPanel {...props}/>);await fireEvent.changeText(screen.getByLabelText('Memory name'),'Japan');
 await act(async()=>{await fireEvent.press(screen.getByLabelText('Save post to Memory'));await fireEvent.press(screen.getByLabelText('Save post to Memory'));});
 expect(api.savePostToDestination).toHaveBeenCalledTimes(1);await act(async()=>resolve({ok:false,message:'Try again'}));await fireEvent.press(screen.getByLabelText('Save post to Memory'));
 expect(jest.mocked(api.savePostToDestination).mock.calls[0][1]).toEqual(jest.mocked(api.savePostToDestination).mock.calls[1][1]);
});
it('cannot publish or navigate after account replacement',async()=>{
 let resolve!:(value:any)=>void;jest.mocked(api.savePostToDestination).mockReturnValueOnce(new Promise(done=>{resolve=done;}));
 await render(<PostSaveDestinationPanel {...props} destination="highlight"/>);await fireEvent.press(screen.getByLabelText('Publish Highlight'));mockCurrent=false;
 await act(async()=>resolve({ok:true,data:saved}));expect(onSaved).not.toHaveBeenCalled();
});
it('publishes a Highlight with an explicit private choice and 24-hour explanation',async()=>{
 await render(<PostSaveDestinationPanel {...props} destination="highlight"/>);
 expect(screen.getByText(/This Highlight lasts 24 hours/)).toBeTruthy();await fireEvent.press(screen.getByText('Only me'));await fireEvent.press(screen.getByLabelText('Publish Highlight'));
 expect(api.savePostToDestination).toHaveBeenCalledWith('post',expect.objectContaining({destination:'highlight',visibility:'private'}),mockOwner);
});

it('publishes a profile repost with an original preview, a note, and the chosen audience', async () => {
 await render(<PostSaveDestinationPanel {...props} destination="profile" />);
 expect(screen.getByTestId('draft-preview').props.target).toEqual({ legacyPostId: 'post' });
 await fireEvent.changeText(screen.getByLabelText('Add a note'), 'Our trip');
 await fireEvent.press(screen.getByText('Only me'));
 await fireEvent.press(screen.getByLabelText('Publish repost'));
 expect(api.savePostToDestination).toHaveBeenCalledWith('post', expect.objectContaining({ destination: 'profile', note: 'Our trip', visibility: 'private' }), mockOwner);
 expect(api.listPostDestinationMemories).not.toHaveBeenCalled();
});
