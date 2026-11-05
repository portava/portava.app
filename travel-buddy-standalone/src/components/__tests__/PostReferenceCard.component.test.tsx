import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PostReferenceCard } from '../PostReferenceCard.tsx';
import * as api from '../../services/postDestinations.ts';
import { router } from 'expo-router';
let mockUser='me';let mockCurrent=true;const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// NOTE: the account and route boundaries are controlled; the card lifecycle and content are real.
jest.mock('../../context/SessionContext.tsx',()=>({useSession:()=>({userId:mockUser})}));
// NOTE: source reads cannot use live auth/network in this isolated renderer test.
jest.mock('../../services/postDestinations.ts',()=>({...jest.requireActual('../../services/postDestinations.ts'),capturePostDestinationOwner:()=>({ownerId:mockUser,sessionId:'session',isCurrent:()=>mockCurrent,invalidate:()=>{}}),readPostReference:jest.fn()}));
// NOTE: router focus is simulated without mounting the whole navigation container.
jest.mock('expo-router',()=>({router:{push:jest.fn()},useFocusEffect:()=>{}}));
const props={mediaType:'application/vnd.portava.post-reference+json',uri:`portava-post-reference:${id}`};
beforeEach(()=>{jest.clearAllMocks();mockUser='me';mockCurrent=true;jest.mocked(api.readPostReference).mockResolvedValue({ok:true,data:{available:true,postId:id,author:'@traveler',text:'Original text'}});});
it('shows the live source and opens its canonical post route',async()=>{
 await render(<PostReferenceCard {...props}/>);await waitFor(()=>expect(screen.getByText('Original text')).toBeTruthy());await fireEvent.press(screen.getByLabelText('Open original post'));expect(router.push).toHaveBeenCalledWith(`/post/${id}`);
});
it('shows an explicit unavailable card with no open action',async()=>{
 jest.mocked(api.readPostReference).mockResolvedValue({ok:true,data:{available:false}});await render(<PostReferenceCard {...props}/>);
 await waitFor(()=>expect(screen.getByText('This post is no longer available to you.')).toBeTruthy());expect(screen.queryByLabelText('Open original post')).toBeNull();
});
it('preserves read failure and supports retry',async()=>{
 jest.mocked(api.readPostReference).mockResolvedValueOnce({ok:false,message:'Could not check post'});await render(<PostReferenceCard {...props}/>);
 await waitFor(()=>expect(screen.getByText('Could not check post')).toBeTruthy());await fireEvent.press(screen.getByText('Retry'));await waitFor(()=>expect(screen.getByText('Original text')).toBeTruthy());
});
it('does not display another account’s late source read',async()=>{
 let resolve!:(value:any)=>void;jest.mocked(api.readPostReference).mockReturnValueOnce(new Promise(done=>{resolve=done;}));
 await render(<PostReferenceCard {...props}/>);mockCurrent=false;await act(async()=>resolve({ok:true,data:{available:true,postId:id,author:'Old owner',text:'Private old source'}}));expect(screen.queryByText('Private old source')).toBeNull();
});
it('delegates modal dismissal before opening a source when supplied',async()=>{
 const open=jest.fn();await render(<PostReferenceCard {...props} onOpen={open}/>);await waitFor(()=>expect(screen.getByText('Original text')).toBeTruthy());await fireEvent.press(screen.getByLabelText('Open original post'));expect(open).toHaveBeenCalledWith(id);expect(router.push).not.toHaveBeenCalled();
});
