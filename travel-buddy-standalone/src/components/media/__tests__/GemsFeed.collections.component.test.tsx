import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { GemsFeed } from '../GemsFeed.tsx';
import * as collections from '../../../services/collections.ts';
import { seedObservedOwnerSession, disposeObservedOwnerSession } from '../../../services/__tests__/observedOwnerSessionFixture.ts';
import { setDiscoveryViewerFromSession } from '../../../services/discoveryViewerScope.ts';
// NOTE: auth events use the production owner observer with an in-memory SDK seam.
jest.mock('../../../lib/supabase.ts',()=>{const listeners=new Set();return {isSupabaseConfigured:true,supabase:{auth:{listeners,onAuthStateChange:(cb:unknown)=>{listeners.add(cb);return {data:{subscription:{unsubscribe:()=>listeners.delete(cb)}}};}}}};});
jest.mock('../../../services/collections.ts',()=>({...jest.requireActual('../../../services/collections.ts'),readCollections:jest.fn(),checkSaved:jest.fn(),saveItem:jest.fn(),unsaveItem:jest.fn(),createCollection:jest.fn()}));
// NOTE: only the requesting viewer is needed, no network provider in this test.
jest.mock('../../../context/SessionContext.tsx',()=>({useSession:()=>({userId:'owner-a',isAuthed:true})}));
// NOTE: fixed device geometry; no native insets provider is mounted.
jest.mock('react-native-safe-area-context',()=>({useSafeAreaInsets:()=>({top:0,bottom:0,left:0,right:0})}));
const mockItem={id:'media-id',gemId:'gem-id',media:[],viewerState:{hasSaved:false},creator:{id:'creator'}};
// NOTE: one already-loaded gem makes the collection interaction deterministic.
jest.mock('../../../hooks/useGemsFeed.ts',()=>({useGemsFeed:()=>({items:[mockItem],loading:false,loadingMore:false,error:null,errorKind:null,hasMore:false,refresh:jest.fn(),loadMore:jest.fn()})}));
const mockSaved=jest.fn();
// NOTE: records authoritative bookmark synchronization; hook lifecycle has separate tests.
jest.mock('../../../hooks/useMediaSave.ts',()=>({useMediaSave:()=>({seed:jest.fn(),isSaved:()=>false,setSaved:mockSaved})}));
// NOTE: overlay gesture fires the production GemsFeed handler; visual overlay is tested separately.
jest.mock('../GemsItemOverlay.tsx',()=>{const {Pressable,Text}=require('react-native');return {GemsItemOverlay:({item,onSave}:any)=><Pressable onPress={()=>onSave(item)}><Text>Bookmark gem</Text></Pressable>};});
// NOTE: unrelated sheets and filter UI are closed; collection sheet is real.
jest.mock('../GemsFilterBar.tsx',()=>({GemsFilterBar:()=>null}));
// NOTE: unrelated sheet remains closed.
jest.mock('../MediaCommentSheet.tsx',()=>({MediaCommentSheet:()=>null}));
// NOTE: unrelated sheet remains closed.
jest.mock('../MediaMoreMenu.tsx',()=>({MediaMoreMenu:()=>null}));
// NOTE: unrelated sheet remains closed.
jest.mock('../WhyThisSheet.tsx',()=>({WhyThisSheet:()=>null}));
beforeEach(()=>{jest.clearAllMocks();setDiscoveryViewerFromSession('owner-a');seedObservedOwnerSession('owner-a','session-a');
 jest.mocked(collections.readCollections).mockResolvedValue({ok:true,data:[{id:'food',name:'Food',isDefault:false,itemCount:0,position:0,coverUrl:null,createdAt:'',updatedAt:''}]});
 jest.mocked(collections.checkSaved).mockResolvedValue({ok:true,saved:false,collectionIds:[]});
 jest.mocked(collections.saveItem).mockResolvedValue(true);
});
afterEach(()=>{disposeObservedOwnerSession();setDiscoveryViewerFromSession(null);});
it('bookmark opens the real collection chooser, saves the gem identity and updates its media bookmark',async()=>{
 const view=await render(<GemsFeed nearMeEnabled={false}/>);await fireEvent.press(await view.findByText('Bookmark gem'));await fireEvent.press(await view.findByText('Food'));
 await waitFor(()=>expect(collections.saveItem).toHaveBeenCalledWith('gem','gem-id','food'));
 expect(mockSaved).toHaveBeenCalledWith('media-id',true);
});
