import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { HighlightComposer } from '../HighlightComposer.tsx';
import { uploadMedia } from '../../services/media.ts';
import { createHighlight } from '../../services/highlights.ts';

let mockPick: ((asset: unknown) => void) | undefined;
let mockCurrent = true;
const mockOwner = { ownerId: 'me', sessionId: 'session', isCurrent: () => mockCurrent, invalidate: jest.fn() };
// NOTE: the test mounts the full draft and controls only the device picker and network/session boundaries.
jest.mock('../../context/SessionContext.tsx', () => ({ useSession: () => ({ userId: 'me' }) }));
jest.mock('../../hooks/usePrivateSurfaceKey.ts', () => ({ usePrivateSurfaceKey: () => 'me:session' }));
jest.mock('../../services/messagingOwnerRequest.ts', () => ({ ...jest.requireActual('../../services/messagingOwnerRequest.ts'), captureMessagingOwnerRequest: () => mockOwner }));
jest.mock('../../services/media.ts', () => ({ ...jest.requireActual('../../services/media.ts'), uploadMedia: jest.fn() }));
jest.mock('../../services/highlights.ts', () => ({ ...jest.requireActual('../../services/highlights.ts'), createHighlight: jest.fn() }));
jest.mock('../ui/MediaPickerButton.tsx', () => ({ MediaPickerButton: ({ composer }: any) => { mockPick = composer.onPickResult; return null; } }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../../features/highlights/HighlightLifetimePicker.tsx', () => ({ HighlightLifetimePicker: () => null }));
const receipt = { ok: true, url: 'post-media/me/video.mov', mediaType: 'video/quicktime', thumbnailUrl: 'post-media/me/video.poster.jpg', durationSeconds: 7 };
const asset = { uri: 'file:///video.mov', type: 'video', mimeType: 'video/quicktime', duration: null, fileSize: 100 };
beforeEach(() => { jest.clearAllMocks(); mockCurrent = true; mockPick = undefined; });
async function pick() { await act(async () => mockPick!(asset)); }
it('publishes with verified duration and poster and retries the same publish without uploading the file again', async () => {
 const saved = jest.fn();
 jest.mocked(uploadMedia).mockResolvedValue(receipt);
 jest.mocked(createHighlight).mockResolvedValueOnce({ ok: false, data: null, errorKind: 'network_unreachable' })
  .mockResolvedValueOnce({ ok: true, data: { id: 'highlight' } as any });
 await render(<HighlightComposer visible onClose={jest.fn()} onSuccess={saved} />);
 await pick(); await fireEvent.press(screen.getByText('Share Highlight'));
 await screen.findByText(/Upload complete. Couldn’t publish/);
 await fireEvent.press(screen.getByText('Share Highlight'));
 await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
 const calls = jest.mocked(createHighlight).mock.calls;
 expect(calls[0][0]).toMatchObject({ mediaUrl: receipt.url, mediaThumbnailUrl: receipt.thumbnailUrl, videoDurationSeconds: 7, mediaDurationSeconds: 7, operationId: expect.any(String) });
 expect(calls[1][0]).toEqual(calls[0][0]); expect(calls[0][1]).toBe(mockOwner);
 expect(uploadMedia).toHaveBeenCalledTimes(1);
});
it('never publishes after the picker owner is replaced during an upload', async () => {
 jest.mocked(uploadMedia).mockImplementationOnce(async () => { mockCurrent = false; return receipt; });
 await render(<HighlightComposer visible onClose={jest.fn()} />); await pick();
 await fireEvent.press(screen.getByText('Share Highlight'));
 expect(createHighlight).not.toHaveBeenCalled();
});
