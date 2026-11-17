import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { MemoryPeopleView } from '../MemoryPeopleView.tsx';
import { loadPassportPeople, setPassportMemorySource } from '../../../services/passportMemoryPeople.ts';
import { listPostDestinationMemories } from '../../../services/postDestinations.ts';
let mockUser:string|null='owner';let mockFocus:()=>void;let mockBlur:(()=>void)|undefined;
// NOTE: account and navigation lifetimes are driven explicitly; the actual
// component handles cancellation and renders both grouping and source choices.
jest.mock('../../../context/SessionContext.tsx',()=>({useSession:()=>({userId:mockUser})}));
jest.mock('expo-router',()=>({useRouter:()=>({push:jest.fn()}),useFocusEffect:(cb:()=>void|(()=>void))=>{
 const R=jest.requireActual('react') as typeof import('react');R.useEffect(()=>{mockFocus=()=>{mockBlur?.();mockBlur=cb()||undefined;};mockFocus();return()=>mockBlur?.();},[cb]);
}}));
// NOTE: network results are controlled; privacy derivation itself has actual
// database acceptance tests and parsing has a separate transport regression.
jest.mock('../../../services/passportMemoryPeople.ts',()=>({loadPassportPeople:jest.fn(),setPassportMemorySource:jest.fn()}));
jest.mock('../../../services/postDestinations.ts',()=>({capturePostDestinationOwner:()=>{let active=true;return {ownerId:mockUser,isCurrent:()=>active,invalidate:()=>{active=false;}};},listPostDestinationMemories:jest.fn()}));
const row=(people:any,title='Kyoto')=>({id:'scrapbook',title,people});
const ready={state:'ready',sourceId:'source',resolvedSourceId:'source',anonymousCount:0,participants:[{userId:'person',name:null,handle:'traveller',rung:'PROFILE_LINKED'}]};
beforeEach(()=>{jest.clearAllMocks();mockUser='owner';mockBlur=undefined;jest.mocked(loadPassportPeople).mockResolvedValue({ok:true,data:[row(ready)]});jest.mocked(listPostDestinationMemories).mockResolvedValue({ok:true,data:{memories:[{id:'album',ownerId:'owner',title:'My album'} as any],nextCursor:null}});jest.mocked(setPassportMemorySource).mockResolvedValue({ok:true,data:null});});
it('groups actual permitted people and removes the old result on returning after revocation',async()=>{
 await render(<MemoryPeopleView/>);await waitFor(()=>expect(screen.getByText('traveller')).toBeTruthy());
 jest.mocked(loadPassportPeople).mockResolvedValue({ok:true,data:[row({...ready,participants:[]})]});
 await act(async()=>mockFocus());await waitFor(()=>expect(screen.queryByText('traveller')).toBeNull());
});
it('unlinked and unreadable sources remain distinct and never assert an empty participant list',async()=>{
 jest.mocked(loadPassportPeople).mockResolvedValue({ok:true,data:[row({state:'unlinked'}),row({state:'unavailable'},'Osaka')].map((r,i)=>({...r,id:String(i)}))});
 await render(<MemoryPeopleView/>);await waitFor(()=>expect(screen.getByText('No album linked.')).toBeTruthy());expect(screen.getByText('People are unavailable for this memory.')).toBeTruthy();expect(screen.queryByText('No visible people in your linked albums.')).toBeNull();
});
it('only an explicit owner choice links an existing album, then rereads the result',async()=>{
 jest.mocked(loadPassportPeople).mockResolvedValue({ok:true,data:[row({state:'unlinked'})]});
 await render(<MemoryPeopleView/>);await waitFor(()=>expect(screen.getByText('Link an album')).toBeTruthy());
 fireEvent.press(screen.getByLabelText('Choose album for Kyoto'));await waitFor(()=>expect(screen.getByText('My album')).toBeTruthy());
 expect(setPassportMemorySource).not.toHaveBeenCalled();fireEvent.press(screen.getByText('My album'));
 await waitFor(()=>expect(setPassportMemorySource).toHaveBeenCalledWith(expect.objectContaining({ownerId:'owner'}),'scrapbook','album',null));
 await waitFor(()=>expect(loadPassportPeople).toHaveBeenCalledTimes(2));
});
it('an uncertain save disables another write until closing rereads the actual association',async()=>{
 jest.mocked(setPassportMemorySource).mockResolvedValue({ok:false,message:'Unconfirmed. Refresh first.'});
 await render(<MemoryPeopleView/>);await waitFor(()=>expect(screen.getByText('traveller')).toBeTruthy());
 fireEvent.press(screen.getByLabelText('Choose album for Kyoto'));await waitFor(()=>expect(screen.getByText('My album')).toBeTruthy());fireEvent.press(screen.getByText('My album'));
 await waitFor(()=>expect(screen.getByText('Unconfirmed. Refresh first.')).toBeTruthy());fireEvent.press(screen.getByText('My album'));expect(setPassportMemorySource).toHaveBeenCalledTimes(1);
 fireEvent.press(screen.getByText('Close'));await waitFor(()=>expect(loadPassportPeople).toHaveBeenCalledTimes(2));
});
it('late responses from the previous account cannot restore private people',async()=>{
 let finish!:(v:any)=>void;jest.mocked(loadPassportPeople).mockReturnValueOnce(new Promise(done=>{finish=done;}));
 const view=await render(<MemoryPeopleView/>);mockUser='next';jest.mocked(loadPassportPeople).mockResolvedValue({ok:true,data:[]});await view.rerender(<MemoryPeopleView/>);
 await act(async()=>finish({ok:true,data:[row(ready)]}));expect(screen.queryByText('traveller')).toBeNull();
});
