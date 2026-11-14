import './composerDraftTestRuntime.ts';
import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert } from 'react-native';
import { emitObservedAuthEvent, observedOwnerSession } from '../../services/__tests__/observedOwnerSessionFixture.ts';
import { setDiscoveryViewerFromSession } from '../../services/discoveryViewerScope.ts';
const mockCreate = jest.fn(async (..._args: unknown[]) => ({ ok: false, data: null, message: 'Could not publish' }));
const mockPickMedia = jest.fn(async (): Promise<unknown> => null);
// NOTE: transport boundary. Real composer draft persistence and owner guard run.
jest.mock('../../hooks/usePosts.ts', () => ({ usePostActions: () => ({ create: (...args: unknown[]) => mockCreate(...args), submitting: false }) }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../ui/KeyboardSafeView.tsx', () => ({ KeyboardSafeScrollView: ({ children }: any) => children, KeyboardSafeView: ({ children }: any) => children }));
jest.mock('../MentionInput.tsx', () => { const R = require('react'), { TextInput } = require('react-native'); return { MentionInput: R.forwardRef((p: any, _ref: unknown) => R.createElement(TextInput, { testID: 'draft-text', value: p.value, onChangeText: p.onChangeText })) }; });
// NOTE: unrelated suggestion rendering does not participate in draft storage.
jest.mock('../MentionSuggestionList.tsx', () => ({ MentionSuggestionList: () => null }));
// NOTE: unrelated place picker modal is not opened by these text-only tests.
jest.mock('../selectors/GlobalPlacePicker.tsx', () => ({ GlobalPlacePicker: () => null }));
// NOTE: the dedicated highlight composer is a separate flow.
jest.mock('../HighlightComposer.tsx', () => ({ HighlightComposer: () => null }));
// NOTE: native media editor is not opened by text-only recovery tests.
jest.mock('../MediaFilterEditor.tsx', () => ({ MediaFilterEditor: () => null }));
// NOTE: native media selection is not exercised in these text-only tests.
jest.mock('../../hooks/useMediaPicker.ts', () => ({ useMediaPicker: () => ({ pickMedia: mockPickMedia }) }));
jest.mock('@react-native-community/datetimepicker', () => () => null);
// NOTE: upload transport is unreachable without a selected file.
jest.mock('../../services/media.ts', () => ({ uploadMedia: jest.fn(), validateMedia: jest.fn(() => ({ ok: true })) }));
// NOTE: HTTP boundary. Cleanup authorization/outcome interpretation remains real.
jest.mock('../../services/ownedApiRequest.ts', () => ({ fetchOwnedApi: jest.fn() }));
import { fetchOwnedApi } from '../../services/ownedApiRequest.ts';
import { uploadMedia } from '../../services/media.ts';
import { UnifiedPostComposer } from '../PulseCreate.tsx';
import * as draftAssets from '../../services/composerDraftAsset.ts';
beforeEach(() => { mockPickMedia.mockReset(); mockPickMedia.mockResolvedValue(null); mockCreate.mockClear(); mockCreate.mockImplementation(async () => ({ ok: false, data: null, message: 'Could not publish' })); });
async function typeDraft() { const v = await render(<UnifiedPostComposer onClose={jest.fn()}/>); await act(async () => { fireEvent.press(v.getByText('Post Update')); }); await act(async () => { fireEvent.changeText(v.getByTestId('draft-text'), 'Unsent private thought'); }); return v; }
it('closing and restarting restores text; a failed publication also retains it', async () => {
    const first = await typeDraft();
    await act(async () => { fireEvent.press(first.getByTestId('post-composer-close-btn')); });
    await first.unmount();
    expect(await AsyncStorage.getAllKeys()).toContain('rumazi.composer-draft.v1:draft-owner:post%3A%3A%3A');
    expect(JSON.parse((await AsyncStorage.getItem('rumazi.composer-draft.v1:draft-owner:post%3A%3A%3A'))!)).toMatchObject({ text: 'Unsent private thought', selectedType: 'post_update' });
    const second = await render(<UnifiedPostComposer onClose={jest.fn()}/>);
    await waitFor(() => expect(second.getByTestId('draft-text').props.value).toBe('Unsent private thought'));
    await act(async () => { fireEvent.press(second.getAllByText('Post Update').slice(-1)[0]!); });
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(second.getByTestId('draft-text').props.value).toBe('Unsent private thought');
    await second.unmount();
    const third = await render(<UnifiedPostComposer onClose={jest.fn()}/>);
    expect(third.getByTestId('draft-text').props.value).toBe('Unsent private thought');
});
it('explicit discard and acknowledged publication clear the local draft', async () => {
    const first = await typeDraft();
    await act(async () => { fireEvent.press(first.getByLabelText('Discard post draft')); });
    await first.unmount();
    expect((await AsyncStorage.getAllKeys()).filter(k => k.startsWith('rumazi.composer-draft.'))).toEqual([]);
    const second = await typeDraft();
    mockCreate.mockResolvedValueOnce({ ok: true, data: { id: 'post' } as any, message: '' });
    await act(async () => { fireEvent.press(second.getAllByText('Post Update').slice(-1)[0]!); });
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect((await AsyncStorage.getAllKeys()).filter(k => k.startsWith('rumazi.composer-draft.'))).toEqual([]);
});
it('a session replacement cannot send the previous composer draft', async () => {
    const view = await typeDraft();
    await act(async () => { setDiscoveryViewerFromSession('other-owner'); emitObservedAuthEvent('SIGNED_IN', observedOwnerSession('other-owner', 'other-session')); });
    // The old surface was remounted; even a stale callback can no longer publish.
    expect(mockCreate).not.toHaveBeenCalled();
    const value = view.queryByTestId('draft-text');
    if (value) {
        await act(async () => { fireEvent.press(view.getAllByText('Post Update').slice(-1)[0]!); });
    }
    expect(mockCreate).not.toHaveBeenCalled();
});
it('a restored upload receipt retries only publication and clears the acknowledged draft', async () => {
    const key = 'rumazi.composer-draft.v1:draft-owner:post%3A%3A%3A';
    await AsyncStorage.setItem(key, JSON.stringify({ selectedType: 'post_update', selectedCategory: 'activity', text: 'Saved after upload', placeName: '', media: { uri: 'file:///private/synthetic.jpg', recoveryUri: 'file:///private/synthetic.jpg', type: 'image', mimeType: 'image/jpeg' }, vis: 'public', selectedPlace: null, addToPassport: false, filterId: 'original', filterIntensity: 100, locationPrivacyMode: 'none', scheduledTime: null, uploadOperation: '10000000-0000-4000-8000-000000000001', publicationOperation: '20000000-0000-4000-8000-000000000001', uploadCompleted: true, uploadedMedia: { url: 'post-media/draft-owner/composer-drafts/upload.jpg', thumbnailUrl: null, mediaType: 'image' } }));
    mockCreate.mockResolvedValueOnce({ ok: true, data: { id: 'post' } as any, message: '' });
    const view = await render(<UnifiedPostComposer onClose={jest.fn()}/>);
    await waitFor(() => expect(view.getByTestId('draft-text').props.value).toBe('Saved after upload'));
    await act(async () => { fireEvent.press(view.getAllByText('Post Update').slice(-1)[0]!); });
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(mockCreate.mock.calls[0]![0]).toMatchObject({ composerUploadOperationId: '10000000-0000-4000-8000-000000000001', mediaUrls: ['post-media/draft-owner/composer-drafts/upload.jpg'] });
    expect(await AsyncStorage.getItem(key)).toBeNull();
});

it('a local media copy completing after discard is removed and cannot restore the discarded draft', async () => {
    let finish!: (uri: string) => void;
    const copy = jest.mocked(draftAssets.preserveDraftAsset).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const remove = jest.mocked(draftAssets.discardDraftAsset);
    copy.mockClear(); remove.mockClear();
    try {
        const view = await typeDraft();
        mockPickMedia.mockResolvedValueOnce([{ uri: 'file:///picked.mp4', type: 'video', mimeType: 'video/mp4', fileSize: 100, duration: 1000 }]);
        await act(async () => { fireEvent.press(view.getByText('Photo or video')); });
        await waitFor(() => expect(copy).toHaveBeenCalled());
        await act(async () => { fireEvent.press(view.getByLabelText('Discard post draft')); });
        await act(async () => { finish('file:///owned/durable.mp4'); });
        expect(remove).toHaveBeenCalledWith('file:///owned/durable.mp4', 'draft-owner');
        expect((await AsyncStorage.getAllKeys()).filter(key => key.startsWith('rumazi.composer-draft.'))).toEqual([]);
    } finally { copy.mockClear(); remove.mockClear(); }
});

it('discard after a lost publication acknowledgement reports the published post instead of discarded', async()=>{
 const key='rumazi.composer-draft.v1:draft-owner:post%3A%3A%3A';
 await AsyncStorage.setItem(key,JSON.stringify({selectedType:'post_update',selectedCategory:'activity',text:'Acknowledgement lost',placeName:'',media:null,vis:'public',selectedPlace:null,addToPassport:false,filterId:'original',filterIntensity:100,locationPrivacyMode:'none',scheduledTime:null,uploadOperation:'10000000-0000-4000-8000-000000000001',publicationOperation:'20000000-0000-4000-8000-000000000001',uploadCompleted:true}));
 jest.mocked(fetchOwnedApi).mockResolvedValueOnce({ok:false,status:409,json:async()=>({error:'already_published'})} as Response);
 const alert=jest.spyOn(Alert,'alert'),success=jest.fn();
 try {
  const view=await render(<UnifiedPostComposer onClose={jest.fn()} onSuccess={success}/>);
  await waitFor(()=>expect(view.getByTestId('draft-text').props.value).toBe('Acknowledgement lost'));
  await act(async()=>{fireEvent.press(view.getByLabelText('Discard post draft'));});
  expect(alert).toHaveBeenCalledWith('Post already published',expect.stringContaining('server confirmed'));
  expect(success).toHaveBeenCalledTimes(1);expect(await AsyncStorage.getItem(key)).toBeNull();
 }finally{alert.mockRestore();}
});

it('an unrecognized conflict keeps the draft rather than claiming it was published or discarded',async()=>{
 const key='rumazi.composer-draft.v1:draft-owner:post%3A%3A%3A';
 await AsyncStorage.setItem(key,JSON.stringify({selectedType:'post_update',selectedCategory:'activity',text:'Unconfirmed server result',placeName:'',media:null,vis:'public',selectedPlace:null,addToPassport:false,filterId:'original',filterIntensity:100,locationPrivacyMode:'none',scheduledTime:null,uploadOperation:'10000000-0000-4000-8000-000000000001',uploadCompleted:true}));
 jest.mocked(fetchOwnedApi).mockResolvedValueOnce({ok:false,status:409,json:async()=>({error:'unrelated_conflict'})} as Response);
 const close=jest.fn(),success=jest.fn();
 const view=await render(<UnifiedPostComposer onClose={close} onSuccess={success}/>);
 await waitFor(()=>expect(view.getByTestId('draft-text').props.value).toBe('Unconfirmed server result'));
 await act(async()=>{fireEvent.press(view.getByLabelText('Discard post draft'));});
 expect(view.getByText(/Could not confirm whether this upload/)).toBeTruthy();expect(close).not.toHaveBeenCalled();expect(success).not.toHaveBeenCalled();expect(await AsyncStorage.getItem(key)).not.toBeNull();
});
