import React from 'react';
import {act,fireEvent,render,screen} from '@testing-library/react-native';
import {MemoryMediaBindingsPanel} from '../MemoryMediaBindingsPanel.tsx';
import * as service from '../../../services/adminMedia.ts';

let mockUserId:string|null='admin-a';
jest.mock('../../../context/SessionContext.tsx',()=>({
 ...jest.requireActual('../../../context/SessionContext.tsx'),useSession:()=>({userId:mockUserId}),
}));
jest.mock('../../../services/adminMedia.ts',()=>({
 ...jest.requireActual('../../../services/adminMedia.ts'),getMemoryMediaBindings:jest.fn(),reconcileMemoryMediaReference:jest.fn(),
}));
const api=service as jest.Mocked<typeof service>;
const item:service.MemoryMediaBindingReview={itemId:'item-a',memoryId:'memory-a',memoryTitle:'Summer trip',reviewedUrlHash:'a'.repeat(64),status:'candidate',source:{bucket:'post-media',path:'owner/photo.jpg'},assetId:'asset-a'};
const page=(items=[item],nextCursor:string|null=null)=>({ok:true as const,data:{items,nextCursor}});
beforeEach(()=>{jest.clearAllMocks();mockUserId='admin-a';api.getMemoryMediaBindings.mockResolvedValue(page());});

it('shows failed reads as errors, never as an empty review',async()=>{
 api.getMemoryMediaBindings.mockResolvedValue({ok:false,error:'Unavailable'});
 await render(<MemoryMediaBindingsPanel/>);await screen.findByTestId('memory-bindings-error');
 expect(screen.queryByTestId('memory-bindings-empty')).toBeNull();expect(api.reconcileMemoryMediaReference).not.toHaveBeenCalled();
});
it('requires a reason and confirms the exact receipt before removing the reviewed item',async()=>{
 api.reconcileMemoryMediaReference.mockResolvedValue({ok:true,data:{ok:true,itemId:item.itemId,assetId:item.assetId!,alreadyBound:false}});
 await render(<MemoryMediaBindingsPanel/>);await screen.findByText('Summer trip');
 await fireEvent.press(screen.getByLabelText('Link original for item-a'));expect(api.reconcileMemoryMediaReference).not.toHaveBeenCalled();
 await fireEvent.changeText(screen.getByLabelText('Reason for item-a'),'  Reviewed source  ');
 await fireEvent.press(screen.getByLabelText('Link original for item-a'));
 await screen.findByText('Original linked. The Memory’s visibility is unchanged.');
 expect(api.reconcileMemoryMediaReference).toHaveBeenCalledTimes(1);expect(api.reconcileMemoryMediaReference).toHaveBeenCalledWith(item,'Reviewed source');
 expect(screen.queryByText('Summer trip')).toBeNull();
});
it('uncertain writes disable further actions until a fresh review, without automatically retrying',async()=>{
 api.reconcileMemoryMediaReference.mockResolvedValue({ok:false,error:'Acknowledgement unavailable'});
 await render(<MemoryMediaBindingsPanel/>);await screen.findByText('Summer trip');
 await fireEvent.changeText(screen.getByLabelText('Reason for item-a'),'Reviewed');await fireEvent.press(screen.getByLabelText('Link original for item-a'));
 await screen.findByTestId('memory-bindings-error');await fireEvent.press(screen.getByLabelText('Link original for item-a'));
 expect(api.reconcileMemoryMediaReference).toHaveBeenCalledTimes(1);
 await fireEvent.press(screen.getByLabelText('Refresh Memory references'));await act(async()=>{});
 expect(api.getMemoryMediaBindings).toHaveBeenCalledTimes(2);expect(api.reconcileMemoryMediaReference).toHaveBeenCalledTimes(1);
});
it('duplicate presses dispatch only one reconciliation',async()=>{
 let resolve!:(value:Awaited<ReturnType<typeof service.reconcileMemoryMediaReference>>)=>void;
 api.reconcileMemoryMediaReference.mockImplementation(()=>new Promise(done=>{resolve=done;}));
 await render(<MemoryMediaBindingsPanel/>);await screen.findByText('Summer trip');
 await fireEvent.changeText(screen.getByLabelText('Reason for item-a'),'Reviewed');
 const button=screen.getByLabelText('Link original for item-a');await fireEvent.press(button);await fireEvent.press(button);expect(api.reconcileMemoryMediaReference).toHaveBeenCalledTimes(1);
 await act(async()=>resolve({ok:false,error:'Unconfirmed'}));
});
it('a mismatched success response is not accepted as a completed repair',async()=>{
 api.reconcileMemoryMediaReference.mockResolvedValue({ok:true,data:{ok:true,itemId:'different-item',assetId:item.assetId!,alreadyBound:false}});
 await render(<MemoryMediaBindingsPanel/>);await screen.findByText('Summer trip');await fireEvent.changeText(screen.getByLabelText('Reason for item-a'),'Reviewed');await fireEvent.press(screen.getByLabelText('Link original for item-a'));
 await screen.findByTestId('memory-bindings-error');expect(screen.getByText('Summer trip')).toBeTruthy();expect(screen.queryByText('Original linked. The Memory’s visibility is unchanged.')).toBeNull();
});
it('unresolved rows have no repair action and pagination uses the server cursor',async()=>{
 api.getMemoryMediaBindings.mockResolvedValueOnce(page([{...item,status:'owner_mismatch',assetId:null}], 'cursor-a')).mockResolvedValueOnce(page([],null));
 await render(<MemoryMediaBindingsPanel/>);await screen.findByText('Ownership does not match');expect(screen.queryByLabelText('Link original for item-a')).toBeNull();
 await fireEvent.press(screen.getByText('Next page'));await screen.findByTestId('memory-bindings-empty');expect(api.getMemoryMediaBindings).toHaveBeenLastCalledWith('cursor-a');
});
it('ignores a previous account response after the admin session changes',async()=>{
 let resolve!:(value:Awaited<ReturnType<typeof service.getMemoryMediaBindings>>)=>void;
 api.getMemoryMediaBindings.mockImplementationOnce(()=>new Promise(done=>{resolve=done;})).mockResolvedValueOnce(page([],null));
 const view=await render(<MemoryMediaBindingsPanel/>);mockUserId='admin-b';await view.rerender(<MemoryMediaBindingsPanel/>);
 await screen.findByTestId('memory-bindings-empty');await act(async()=>resolve(page()));expect(screen.queryByText('Summer trip')).toBeNull();
});
