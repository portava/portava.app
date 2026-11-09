import React from 'react';
import { render, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { StoryComposer } from '../../../components/StoryComposer.tsx';
import { UnifiedPostComposer } from '../../../components/PulseCreate.tsx';
import { bindCameraRecording, issueRecordingStamp } from '../recordingStamp.ts';
import { uploadMedia } from '../../../services/media.ts';
import { createStory, uploadStoryMedia } from '../../../services/stories.ts';

let mockAsset: any;
const mockPostCreate = jest.fn();
const mockOwner = { ownerId: 'creator', sessionId: 's', isCurrent: () => true, invalidate: jest.fn() };
// NOTE: these are the device picker, auth and publication boundaries. Both actual composers run the publication and retry logic.
jest.mock('../../../hooks/usePrivateSurfaceKey.ts', () => ({ usePrivateSurfaceKey: () => 'creator:s' }));
jest.mock('../../../hooks/useMediaPicker.ts', () => ({ useMediaPicker: () => ({ pickMedia: async () => [mockAsset] }) }));
jest.mock('../../../hooks/usePosts.ts', () => ({ ...jest.requireActual('../../../hooks/usePosts.ts'), usePostActions: () => ({ create: mockPostCreate, submitting: false }) }));
jest.mock('../../../components/ui/MediaPickerButton.tsx', () => ({
  MediaPickerButton: ({ composer }: any) => require('react').createElement(require('react-native').Pressable, {
    testID: 'test-device-picker', onPress: () => composer.onPickResult(mockAsset) }),
}));
jest.mock('../../../components/ui/SharedVideoPlayer.tsx', () => ({ ...jest.requireActual('../../../components/ui/SharedVideoPlayer.tsx'), SharedVideoPlayer: () => null }));
jest.mock('../../../services/media.ts', () => ({ ...jest.requireActual('../../../services/media.ts'), uploadMedia: jest.fn() }));
jest.mock('../../../services/stories.ts', () => ({ ...jest.requireActual('../../../services/stories.ts'), createStory: jest.fn(), uploadStoryMedia: jest.fn() }));
jest.mock('../recordingStamp.ts', () => ({ ...jest.requireActual('../recordingStamp.ts'), issueRecordingStamp: jest.fn() }));
jest.mock('../../../services/storyRetentionPolicy.ts', () => ({ ...jest.requireActual('../../../services/storyRetentionPolicy.ts'),
  fetchStoryRetentionPolicy: async () => ({ status: 'ok', policy: {} }), composerRetentionLine: () => 'Story retention available' }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
const stamp = { kind: 'portava_recording' as const, code: 'PV-UNIQUE', id: 'stamp', issuedAt: new Date().toISOString(), targetType: 'post' as const, targetId: 'post' };
beforeEach(() => {
  jest.clearAllMocks(); mockAsset = { uri: 'file:///clip.mov', type: 'video', mimeType: 'video/quicktime', duration: 4000, fileSize: 400 };
  jest.mocked(uploadMedia).mockResolvedValue({ ok: true, url: 'post-media/creator/clip.mov', mediaType: 'video/quicktime', captureAccepted: true });
  mockPostCreate.mockResolvedValue({ ok: true, data: { id: 'post' } });
  jest.mocked(createStory).mockResolvedValue({ ok: true, story: { id: 'story' } as any });
  jest.mocked(issueRecordingStamp).mockResolvedValue(stamp);
});
function tagCameraResult() {
  bindCameraRecording({ captureToken: 'opaque', expiresAt: new Date(Date.now() + 60000).toISOString(), owner: mockOwner }, mockAsset, mockAsset);
}
it('offers the creator an optional stamp for a camera Story and issues only after an accepted upload and publication', async () => {
 tagCameraResult();
 const posted = jest.fn();
 await render(<StoryComposer visible onPosted={posted} onClose={jest.fn()} />);
 await fireEvent.press(screen.getByTestId('test-device-picker'));
 const option = screen.getByRole('checkbox');
 expect(option.props.accessibilityState.checked).toBe(false);
 await fireEvent.press(option);
 await fireEvent.press(screen.getByText('Share'));
 await waitFor(() => expect(posted).toHaveBeenCalledTimes(1));
 expect(uploadMedia).toHaveBeenCalledWith(expect.objectContaining({ uri: mockAsset.uri }), expect.objectContaining({ recording: expect.objectContaining({ uri: mockAsset.uri }) }), mockOwner);
 expect(createStory).toHaveBeenCalledWith(expect.objectContaining({ mediaUrl: 'post-media/creator/clip.mov' }), mockOwner);
 expect(issueRecordingStamp).toHaveBeenCalledWith(expect.any(Object), 'story', 'story');
 expect(uploadStoryMedia).not.toHaveBeenCalled();
});
it('keeps gallery videos eligible for ordinary sharing without offering a recording stamp', async () => {
 jest.mocked(uploadStoryMedia).mockResolvedValue('post-media/creator/gallery.mov');
 await render(<StoryComposer visible onClose={jest.fn()} />);
 await fireEvent.press(screen.getByTestId('test-device-picker'));
 expect(screen.queryByRole('checkbox')).toBeNull();
 await fireEvent.press(screen.getByText('Share'));
 await waitFor(() => expect(createStory).toHaveBeenCalled());
 expect(issueRecordingStamp).not.toHaveBeenCalled();
});
it('retries only stamp issuance after the Media post has been published', async () => {
 tagCameraResult(); jest.mocked(issueRecordingStamp).mockRejectedValueOnce(new Error('offline'));
 const done = jest.fn();
 await render(<UnifiedPostComposer onClose={done} initialText="Portava trip" />);
 await fireEvent.press(screen.getByText('Camera · Library'));
 await fireEvent.press(screen.getByRole('checkbox'));
 await fireEvent.press(screen.getAllByText('Post Update').slice(-1)[0]!);
 await screen.findByText(/Published. Recording stamp not confirmed/);
 expect(done).not.toHaveBeenCalled();
 await fireEvent.press(screen.getByText('Retry recording stamp'));
 await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
 expect(uploadMedia).toHaveBeenCalledTimes(1);
 expect(mockPostCreate).toHaveBeenCalledTimes(1);
 expect(issueRecordingStamp).toHaveBeenCalledTimes(2);
 expect(issueRecordingStamp).toHaveBeenLastCalledWith(expect.any(Object), 'post', 'post');
});
