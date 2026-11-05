import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
const mockPush=jest.fn();
let mockCurrent=true;
let mockScope='a';
// NOTE: intentionally exhaustive — this screen only uses the router object.
jest.mock('expo-router',()=>({router:{push:(...args:unknown[])=>mockPush(...args),back:jest.fn()}}));
jest.mock('react-native-safe-area-context',()=>({...jest.requireActual('react-native-safe-area-context'),useSafeAreaInsets:()=>({top:0,bottom:0,left:0,right:0})}));
jest.mock('../../../services/messagingOwnerRequest.ts',()=>({...jest.requireActual('../../../services/messagingOwnerRequest.ts'),captureMessagingOwnerRequest:()=>({isCurrent:()=>mockCurrent})}));
jest.mock('../../../hooks/usePrivateSurfaceKey.ts',()=>({usePrivateSurfaceKey:()=>mockScope}));
jest.mock('../memory/memoryApi.ts',()=>({...jest.requireActual('../memory/memoryApi.ts'),fetchRecapChoices:jest.fn(),fetchRecapPreview:jest.fn(),fetchMemoryMessageSource:jest.fn(),saveMessageAsMemoryDraft:jest.fn()}));
import { RecapCurationScreen } from '../memory/RecapCurationScreen.tsx';
import { MessageSourcePreview } from '../memory/MessageSourcePreview.tsx';
import { fetchRecapChoices, fetchRecapPreview, fetchMemoryMessageSource, saveMessageAsMemoryDraft } from '../memory/memoryApi.ts';
const choices=jest.mocked(fetchRecapChoices),preview=jest.mocked(fetchRecapPreview),source=jest.mocked(fetchMemoryMessageSource),save=jest.mocked(saveMessageAsMemoryDraft);
const data={recap:null,headline:'',choices:{mode:'memory' as const,items:[{messageId:'m1',kind:'photo',label:'Photo',createdAt:'2026-11-05T12:00Z'}],people:[],truncated:false,memoryEnabled:true,sharingEnabled:true}};
const draft={id:'d1',ownerId:'a',state:'draft',visibility:'only_me',title:'Saved photo',occurredAt:null,fromMessageId:'m1',source:'media'};
beforeEach(()=>{jest.clearAllMocks();mockCurrent=true;mockScope='a';choices.mockResolvedValue({ok:true,data});preview.mockResolvedValue({ok:true,data});source.mockResolvedValue({ok:true,data:{source:null}});save.mockResolvedValue({ok:true,data:{draft}});});
it('opening and selecting create nothing; one explicit action creates one private draft',async()=>{
  await render(<RecapCurationScreen threadId="t" mode="memory" />);
  await waitFor(()=>expect(screen.getByLabelText('Photo 1')).toBeTruthy());expect(save).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('Photo 1'));expect(save).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('Create private draft'));
  await waitFor(()=>expect(screen.getByLabelText('Open draft')).toBeTruthy());
  expect(save).toHaveBeenCalledTimes(1);expect(save.mock.calls[0][0]).toBe('m1');
  await fireEvent.press(screen.getByLabelText('Open draft'));expect(mockPush).toHaveBeenCalledWith({pathname:'/memory/[id]',params:{id:'d1'}});
});
it('a failed save offers retry and never claims the draft was saved',async()=>{
  save.mockResolvedValue({ok:false,error:'unavailable',message:'Try again later'});
  await render(<RecapCurationScreen threadId="t" mode="memory" />);await waitFor(()=>expect(screen.getByLabelText('Photo 1')).toBeTruthy());
  await fireEvent.press(screen.getByLabelText('Photo 1'));await fireEvent.press(screen.getByLabelText('Create private draft'));
  await waitFor(()=>expect(screen.getByText('Try again later')).toBeTruthy());expect(screen.queryByLabelText('Open draft')).toBeNull();
});
it('sharing selects one source and opens recipient selection without sending',async()=>{
  await render(<RecapCurationScreen threadId="t" mode="photos" />);await waitFor(()=>expect(screen.getByLabelText('Photo 1')).toBeTruthy());
  expect(screen.getByLabelText('Choose a conversation').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(screen.getByLabelText('Photo 1'));await fireEvent.press(screen.getByLabelText('Choose a conversation'));
  expect(mockPush).toHaveBeenCalledWith({pathname:'/messages/conversation-tools',params:{threadId:'t',messageId:'m1',mode:'forward'}});expect(save).not.toHaveBeenCalled();
});
it('people open their existing relationship-aware profile; no automatic follow is made',async()=>{
  choices.mockResolvedValue({ok:true,data:{...data,choices:{...data.choices,mode:'people',items:[],people:[{userId:'b',label:'Bob',deepLink:'/u/b'}]}}});
  await render(<RecapCurationScreen threadId="t" mode="people" />);await waitFor(()=>expect(screen.getByLabelText("View Bob's profile")).toBeTruthy());
  await fireEvent.press(screen.getByLabelText("View Bob's profile"));expect(mockPush).toHaveBeenCalledWith({pathname:'/u/[id]',params:{id:'b'}});
});
it('a late save response after account change cannot open or display the previous draft',async()=>{
  let finish:(result:Awaited<ReturnType<typeof saveMessageAsMemoryDraft>>)=>void=()=>{};
  save.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  await render(<RecapCurationScreen threadId="t" mode="memory" />);await waitFor(()=>expect(screen.getByLabelText('Photo 1')).toBeTruthy());
  await fireEvent.press(screen.getByLabelText('Photo 1'));await fireEvent.press(screen.getByLabelText('Create private draft'));
  mockCurrent=false;await act(async()=>finish({ok:true,data:{draft}}));expect(screen.queryByLabelText('Open draft')).toBeNull();expect(mockPush).not.toHaveBeenCalled();
});
it('the source panel clears the previous owner when the private surface changes',async()=>{
  source.mockResolvedValue({ok:true,data:{source:{messageId:'m',threadId:'t',createdAt:'now',body:'private old-owner text',media:[],label:'Saved message'}}});
  const view=await render(<MessageSourcePreview memoryId="d" />);await waitFor(()=>expect(screen.getByText('private old-owner text')).toBeTruthy());
  mockScope='b';source.mockResolvedValue({ok:true,data:{source:null}});await view.rerender(<MessageSourcePreview memoryId="d" />);
  expect(screen.queryByText('private old-owner text')).toBeNull();await waitFor(()=>expect(screen.getByText('This source is no longer available.')).toBeTruthy());
});
it('a disabled Memory writer offers no successful draft action',async()=>{
  choices.mockResolvedValue({ok:true,data:{...data,choices:{...data.choices,memoryEnabled:false}}});
  await render(<RecapCurationScreen threadId="t" mode="memory" />);await waitFor(()=>expect(screen.getByLabelText('Photo 1')).toBeTruthy());
  await fireEvent.press(screen.getByLabelText('Photo 1'));expect(screen.getByLabelText('Create private draft').props.accessibilityState.disabled).toBe(true);expect(save).not.toHaveBeenCalled();
});
