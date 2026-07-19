/**
 * callPermissions — mic denial blocks calling with an explanation; camera
 * denial downgrades video to voice with explicit consent (never blocks voice).
 * (.tsx name keeps this jest-only file out of the node:test runner.)
 */
import { Alert } from 'react-native';

const mockMic = jest.fn();
const mockCam = jest.fn();

// NOTE: exhaustive by design — only Audio.requestPermissionsAsync is exercised; the real module needs native ExponentAV.
jest.mock('expo-av', () => ({
  Audio: { requestPermissionsAsync: (...a: any[]) => mockMic(...a) },
}));
// NOTE: exhaustive by design — only requestCameraPermissionsAsync is exercised.
jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: (...a: any[]) => mockCam(...a),
}));

import { ensureCallMediaPermissions } from '../callPermissions.ts';

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

test('voice call with mic granted proceeds without touching the camera', async () => {
  mockMic.mockResolvedValue({ granted: true, canAskAgain: true });
  await expect(ensureCallMediaPermissions('voice')).resolves.toBe('voice');
  expect(mockCam).not.toHaveBeenCalled();
});

test('mic denied blocks the call and explains why', async () => {
  mockMic.mockResolvedValue({ granted: false, canAskAgain: false });
  await expect(ensureCallMediaPermissions('voice')).resolves.toBeNull();
  expect(Alert.alert).toHaveBeenCalledWith(
    'Microphone needed',
    expect.stringContaining('microphone'),
    expect.any(Array),
  );
});

test('video call with both permissions granted stays video', async () => {
  mockMic.mockResolvedValue({ granted: true, canAskAgain: true });
  mockCam.mockResolvedValue({ granted: true, canAskAgain: true });
  await expect(ensureCallMediaPermissions('video')).resolves.toBe('video');
});

test('camera denied still allows voice-only calling with consent', async () => {
  mockMic.mockResolvedValue({ granted: true, canAskAgain: true });
  mockCam.mockResolvedValue({ granted: false, canAskAgain: false });
  const promise = ensureCallMediaPermissions('video');
  // The consent dialog offers "Call without video" — simulate accepting it.
  await new Promise((r) => setTimeout(r, 0));
  const call = (Alert.alert as jest.Mock).mock.calls.find((c) => c[0] === 'Camera unavailable');
  expect(call).toBeTruthy();
  const voiceBtn = call[2].find((b: any) => b.text === 'Call without video');
  voiceBtn.onPress();
  await expect(promise).resolves.toBe('voice');
});

test('camera-denied dialog cancel aborts the call attempt', async () => {
  mockMic.mockResolvedValue({ granted: true, canAskAgain: true });
  mockCam.mockResolvedValue({ granted: false, canAskAgain: false });
  const promise = ensureCallMediaPermissions('video');
  await new Promise((r) => setTimeout(r, 0));
  const call = (Alert.alert as jest.Mock).mock.calls.find((c) => c[0] === 'Camera unavailable');
  const cancelBtn = call[2].find((b: any) => b.text === 'Cancel');
  cancelBtn.onPress();
  await expect(promise).resolves.toBeNull();
});
