import { beginCaptureSession, bindCameraRecording, captureCanUpload, recordedAsset, issueRecordingStamp, readRecordingStamp } from '../recordingStamp.ts';
const mockOwner = { ownerId: 'creator', sessionId: 's1', isCurrent: () => mockCurrent, invalidate: jest.fn() };
let mockCurrent = true;
// NOTE: these tests control auth and the HTTP boundary while exercising real capture binding and receipt validation.
jest.mock('../../../services/messagingOwnerRequest.ts', () => ({ captureMessagingOwnerRequest: () => mockOwner, messagingOwnerToken: async () => 'bearer' }));
const originalFetch = globalThis.fetch;
const token = 'opaque-test-token';
const expiresAt = new Date(Date.now() + 3600000).toISOString();
const descriptor = { id: 'issued', code: 'PV-7MA923', targetType: 'post', targetId: 'post-1', kind: 'portava_recording', issuedAt: new Date().toISOString() };
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
beforeEach(() => { mockCurrent = true; process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; globalThis.fetch = jest.fn(); });
afterEach(() => { globalThis.fetch = originalFetch; delete process.env.EXPO_PUBLIC_API_BASE_URL; });
it('binds only the original result of a camera session, never a copied object, editor replacement or other URI', async () => {
 jest.mocked(fetch).mockResolvedValue(response({ captureToken: token, expiresAt }));
 const session = await beginCaptureSession();
 const raw = { uri: 'file:///camera.mov', type: 'video' };
 const normalized = { ...raw, mimeType: 'video/quicktime' };
 bindCameraRecording(session, raw, normalized);
 const capture = recordedAsset(normalized)!;
 expect(captureCanUpload(capture, raw.uri)).toBe(true);
 expect(recordedAsset({ ...normalized })).toBeNull();
 expect(captureCanUpload({ ...capture }, raw.uri)).toBe(false);
 expect(captureCanUpload(capture, 'file:///gallery.mov')).toBe(false);
 bindCameraRecording(session, raw, { ...raw, uri: 'file:///edited.mov' });
 mockCurrent = false; expect(captureCanUpload(capture, raw.uri)).toBe(false);
});
it('uses a live actor-scoped receipt for the exact post/story and refuses a mismatched target', async () => {
 jest.mocked(fetch).mockResolvedValueOnce(response({ captureToken: token, expiresAt }))
   .mockResolvedValueOnce(response({ stamp: descriptor })).mockResolvedValueOnce(response({ stamp: descriptor }));
 const session = await beginCaptureSession();
 const recording = { uri: 'file:///new.mp4', type: 'video' };
 bindCameraRecording(session, recording, recording);
 expect(await issueRecordingStamp(recordedAsset(recording)!, 'post', 'post-1')).toEqual(descriptor);
 const issue = jest.mocked(fetch).mock.calls[1];
 expect(String(issue[0])).toBe('https://api.test/api/capture-stamps/issue');
 expect(JSON.parse(String(issue[1]?.body))).toEqual({ captureToken: token, targetType: 'post', targetId: 'post-1' });
 expect(await readRecordingStamp(mockOwner, 'story', 'post-1')).toBeNull();
});
it('leaves ordinary capture available when the issuance service is unavailable', async () => {
 jest.mocked(fetch).mockRejectedValue(new Error('offline'));
 expect(await beginCaptureSession()).toBeNull();
});
