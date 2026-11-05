import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { OwnMemoryAlbums } from '../OwnMemoryAlbums.tsx';
import { listPostDestinationMemories } from '../../../../services/postDestinations.ts';
let mockUser:string|null='me';let mockFocus:()=>void;let mockBlur:(()=>void)|undefined;
// NOTE: account state is controlled to exercise real owner replacement behavior.
jest.mock('../../../../context/SessionContext.tsx',()=>({useSession:()=>({userId:mockUser})}));
// NOTE: focus is driven explicitly without a full native navigation container.
jest.mock('expo-router',()=>({router:{push:jest.fn()},useFocusEffect:(callback:()=>void|(()=>void))=>{
 const R=jest.requireActual('react') as typeof import('react');
 R.useEffect(()=>{mockFocus=()=>{mockBlur?.();mockBlur=callback()||undefined;};mockFocus();return()=>mockBlur?.();},[callback]);
}}));
// NOTE: transport is isolated; owner requests retain their own revocable lifetime.
jest.mock('../../../../services/postDestinations.ts',()=>({...jest.requireActual('../../../../services/postDestinations.ts'),
 capturePostDestinationOwner:()=>{let current=true;return {ownerId:mockUser,sessionId:'session',isCurrent:()=>current,invalidate:()=>{current=false;}};},listPostDestinationMemories:jest.fn()}));
// NOTE: native image loading is outside album reachability and owner-lifetime verification.
jest.mock('../../../../components/CachedImage.tsx',()=>({CachedImage:()=>null}));
const album=(id:string,title:string)=>({id,ownerId:mockUser,title,locationCity:null,locationCountry:null,cover:null,items:[],visibility:'only_me',state:'published'} as any);
beforeEach(()=>{jest.clearAllMocks();mockUser='me';mockBlur=undefined;jest.mocked(listPostDestinationMemories).mockResolvedValue({ok:true,data:{memories:[album('first','Saved post album')],nextCursor:null}});});
it('reads canonical owner albums when the Memories area becomes visible',async()=>{
 await render(<OwnMemoryAlbums/>);await waitFor(()=>expect(screen.getByText('Saved post album')).toBeTruthy());expect(listPostDestinationMemories).toHaveBeenCalledWith(expect.objectContaining({ownerId:'me'}),null);
});
it('refreshes authoritative albums on returning from a save',async()=>{
 await render(<OwnMemoryAlbums/>);await waitFor(()=>expect(screen.getByText('Saved post album')).toBeTruthy());
 jest.mocked(listPostDestinationMemories).mockResolvedValue({ok:true,data:{memories:[album('new','Newly shared post')],nextCursor:null}});
 await act(async()=>mockFocus());await waitFor(()=>expect(screen.getByText('Newly shared post')).toBeTruthy());expect(screen.queryByText('Saved post album')).toBeNull();
});
it('drops the first owner’s late response after replacement',async()=>{
 let resolve!:(value:any)=>void;jest.mocked(listPostDestinationMemories).mockReturnValueOnce(new Promise(done=>{resolve=done;}));
 const view=await render(<OwnMemoryAlbums/>);mockUser='other';jest.mocked(listPostDestinationMemories).mockResolvedValue({ok:true,data:{memories:[album('other','Other account album')],nextCursor:null}});
 await view.rerender(<OwnMemoryAlbums/>);await act(async()=>resolve({ok:true,data:{memories:[album('old','Old private album')],nextCursor:null}}));
 await waitFor(()=>expect(screen.getByText('Other account album')).toBeTruthy());expect(screen.queryByText('Old private album')).toBeNull();
});
it('does not load or display an owner library while signed out',async()=>{
 mockUser=null;await render(<OwnMemoryAlbums/>);expect(listPostDestinationMemories).not.toHaveBeenCalled();expect(screen.queryByTestId('profile-memory-albums')).toBeNull();
});
