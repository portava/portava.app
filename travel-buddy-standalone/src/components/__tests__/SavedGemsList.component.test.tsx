import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SavedGemsList } from '../SavedGemsList.tsx';
import { getMySavedGems } from '../../services/collections.ts';
let mockScope='a';
// NOTE: intentional narrow lifecycle seam; service ownership is tested separately.
jest.mock('../../hooks/usePrivateSurfaceKey.ts',()=>({usePrivateSurfaceKey:()=>mockScope}));
jest.mock('expo-router',()=>{const React=require('react');return {...jest.requireActual('expo-router'),router:{push:jest.fn()},useFocusEffect:(cb:()=>void)=>React.useEffect(cb,[cb])};});
jest.mock('../../services/collections.ts',()=>({...jest.requireActual('../../services/collections.ts'),getMySavedGems:jest.fn()}));
const read=jest.mocked(getMySavedGems);
beforeEach(()=>{jest.clearAllMocks();mockScope='a';});
const row=(id:string,title:string|null)=>({id,title,savedAt:'2026-11-05'});
it('opens readable gems, withholds unavailable previews, files existing bookmarks and pages without losing rows',async()=>{
 read.mockResolvedValueOnce({ok:true,gems:[row('g1','Beach'),row('g2',null)],nextCursor:'g2'}).mockResolvedValueOnce({ok:true,gems:[row('g3','Cafe')],nextCursor:null});
 const organize=jest.fn();const view=await render(<SavedGemsList onBack={()=>{}} onOrganize={organize}/>);
 await fireEvent.press(await view.findByText('Beach'));expect(router.push).toHaveBeenCalledWith('/gems/g1');
 expect(view.getByText('Gem unavailable')).toBeTruthy();
 await fireEvent.press(view.getByLabelText('Manage Beach collections'));expect(organize).toHaveBeenCalledWith('g1');
 await fireEvent.press(view.getByText('Load more gems'));await view.findByText('Cafe');expect(view.getByText('Beach')).toBeTruthy();expect(read).toHaveBeenLastCalledWith('g2');
});
it('failed reads show retry instead of an empty saved list',async()=>{
 read.mockResolvedValueOnce({ok:false,gems:[],nextCursor:null}).mockResolvedValueOnce({ok:true,gems:[row('g1','Beach')],nextCursor:null});
 const view=await render(<SavedGemsList onBack={()=>{}}/>);await fireEvent.press(await view.findByText("Couldn't load saved gems. Tap to retry."));await view.findByText('Beach');
});
it('account replacement clears rows and ignores late previous-owner responses',async()=>{
 let resolve!:(value:Awaited<ReturnType<typeof getMySavedGems>>)=>void;
 read.mockImplementationOnce(()=>new Promise(r=>{resolve=r;})).mockResolvedValueOnce({ok:true,gems:[row('b1','New account')],nextCursor:null});
 const view=await render(<SavedGemsList onBack={()=>{}}/>);mockScope='b';await view.rerender(<SavedGemsList onBack={()=>{}}/>);await view.findByText('New account');
 await act(async()=>resolve({ok:true,gems:[row('a1','Private old account')],nextCursor:null}));expect(view.queryByText('Private old account')).toBeNull();
});
