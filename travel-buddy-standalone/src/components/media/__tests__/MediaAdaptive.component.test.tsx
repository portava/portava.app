import React from 'react';
import { Platform, Pressable, Text } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useAdaptivePlayback } from '../../../hooks/useAdaptivePlayback.ts';
import { resolveAdaptivePlayback } from '../../../services/media/adaptive.ts';

let mockEnabled = true;
let mockUserId: string | null = 'viewer';
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({ ...jest.requireActual('../../../context/FeatureFlagsContext.tsx'), useFeatureFlags: () => ({ isEnabled: () => mockEnabled }) }));
jest.mock('../../../context/SessionContext.tsx', () => ({ ...jest.requireActual('../../../context/SessionContext.tsx'), useSession: () => ({ userId: mockUserId }) }));
jest.mock('../../../services/apiToken.ts', () => ({ ...jest.requireActual('../../../services/apiToken.ts'), freshToken: async () => 'synthetic-token' }));

const originalFetch = global.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const assetId = '11111111-1111-4111-8111-111111111111';
const manifest = `https://api.example.test/api/media/adaptive/${assetId}/4/master.m3u8`;
const response = (value: unknown, ok = true) => ({ ok, json: async () => value }) as Response;
const descriptor = { assetId, sourceVersion: 4, protocol: 'hls', manifestUrl: manifest };

function Harness({ original = 'post-media/viewer/video.mp4', active = true }: { original?: string; active?: boolean }) {
  const playback = useAdaptivePlayback(original, 'https://storage.example.test/progressive.mp4', active);
  return <><Text testID="playback-source">{JSON.stringify(playback.source)}</Text><Pressable accessibilityLabel="Simulate decode failure" onPress={playback.rejectAdaptive}><Text>Fail</Text></Pressable></>;
}

beforeEach(() => {
  mockEnabled = true;
  mockUserId = 'viewer';
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test';
  Object.defineProperty(Platform, 'OS', { get: () => 'ios', configurable: true });
  global.fetch = jest.fn().mockResolvedValue(response(descriptor));
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

it('uses the protected manifest with an authorization header and Android format hint', async () => {
  const result = await resolveAdaptivePlayback('post-media/viewer/video.mp4', new AbortController().signal);
  expect(result).toEqual({ uri: manifest, headers: { Authorization: 'Bearer synthetic-token' }, overrideFileExtensionAndroid: 'm3u8' });
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/media/adaptive/source?source='), expect.objectContaining({ cache: 'no-store' }));
});

it('rejects third-party manifests, wrong generations, query credentials and unavailable results', async () => {
  for (const value of [{ ...descriptor, manifestUrl: 'https://external.example.test/media.m3u8' },
    { ...descriptor, sourceVersion: 5 }, { ...descriptor, manifestUrl: `${manifest}?token=private` }, { ...descriptor, protocol: 'dash' }]) {
    global.fetch = jest.fn().mockResolvedValue(response(value));
    expect(await resolveAdaptivePlayback('post-media/viewer/video.mp4', new AbortController().signal)).toBeNull();
  }
  global.fetch = jest.fn().mockResolvedValue(response({}, false));
  expect(await resolveAdaptivePlayback('video', new AbortController().signal)).toBeNull();
});

it('off, signed-out, inactive and web playback never requests adaptive media', async () => {
  for (const mode of ['off', 'signed-out', 'inactive', 'web']) {
    mockEnabled = mode !== 'off';
    mockUserId = mode === 'signed-out' ? null : 'viewer';
    Object.defineProperty(Platform, 'OS', { get: () => mode === 'web' ? 'web' : 'ios', configurable: true });
    const mounted = await render(<Harness active={mode !== 'inactive'} />);
    expect(screen.getByTestId('playback-source').props.children).toContain('progressive.mp4');
    await mounted.unmount();
  }
  expect(global.fetch).not.toHaveBeenCalled();
});

it('an HLS decoding failure falls back once without blocking the original video', async () => {
  await render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('playback-source').props.children).toContain('master.m3u8'));
  await fireEvent.press(screen.getByLabelText('Simulate decode failure'));
  await waitFor(() => expect(screen.getByTestId('playback-source').props.children).toContain('progressive.mp4'));
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

it('source or account replacement discards an old in-flight manifest', async () => {
  let finish: ((value: Response) => void) | undefined;
  global.fetch = jest.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
    .mockResolvedValue(response({}, false));
  const mounted = await render(<Harness />);
  await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
  mockUserId = 'other-viewer';
  await mounted.rerender(<Harness original="post-media/other/new.mp4" />);
  await act(async () => finish?.(response(descriptor)));
  expect(screen.getByTestId('playback-source').props.children).not.toContain('master.m3u8');
});

it('network failures and missing API configuration preserve progressive playback', async () => {
  global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
  const mounted = await render(<Harness />);
  await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId('playback-source').props.children).toContain('progressive.mp4');
  await mounted.unmount();
  delete process.env.EXPO_PUBLIC_API_BASE_URL;
  global.fetch = jest.fn();
  expect(await resolveAdaptivePlayback('video', new AbortController().signal)).toBeNull();
  expect(global.fetch).not.toHaveBeenCalled();
});
