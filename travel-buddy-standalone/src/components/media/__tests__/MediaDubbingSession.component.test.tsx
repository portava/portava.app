import React from 'react';
import { Text } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import { useMediaDubbingSession } from '../MediaDubbingSession.tsx';
import { getDubbingOptions } from '../../../services/media/dubbing.ts';
import { resolveCaptionSource } from '../../../services/media/captions.ts';
import type { DubbingPlaybackOptions } from '../../../hooks/useDubbingPlayback.ts';

let mockEnabled = true;
let mockActor = '11111111-1111-4111-8111-111111111111';
let mockAppListener: (state: string) => void;
let mockPlaybackOptions: DubbingPlaybackOptions;
const mockPlayback = { status: 'original', language: null, muteOriginal: false, selectOriginal: jest.fn(), selectDubbed: jest.fn(), onSourceStatus: jest.fn() };
jest.mock('../../../context/SessionContext.tsx', () => ({ ...jest.requireActual('../../../context/SessionContext.tsx'), useSession: () => ({ userId: mockActor, isAuthed: !!mockActor }) }));
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({ ...jest.requireActual('../../../context/FeatureFlagsContext.tsx'), useFeatureFlags: () => ({ isEnabled: () => mockEnabled }) }));
jest.mock('../../../hooks/useDubbingPlayback.ts', () => ({
  ...jest.requireActual('../../../hooks/useDubbingPlayback.ts'),
  useDubbingPlayback: (options: DubbingPlaybackOptions) => { mockPlaybackOptions = options; return mockPlayback; },
}));
jest.mock('../../../services/media/dubbing.ts', () => ({ ...jest.requireActual('../../../services/media/dubbing.ts'), getDubbingOptions: jest.fn() }));
jest.mock('../../../services/media/captions.ts', () => ({ ...jest.requireActual('../../../services/media/captions.ts'), resolveCaptionSource: jest.fn() }));
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, { get(target, key) {
    if (key === 'AppState') return { currentState: 'active', addEventListener: (_event: string, listener: (state: string) => void) => { mockAppListener = listener; return { remove: jest.fn() }; } };
    return Reflect.get(target, key);
  } });
});
const assetId = '22222222-2222-4222-8222-222222222222';
const descriptor = { assetId, sourceVersion: 1, sourceKey: 'a'.repeat(64), canEdit: true, enabled: true,
  languages: [{ code: 'en', label: 'English', ready: true }, { code: 'fr', label: 'French', ready: false }] };
let session: ReturnType<typeof useMediaDubbingSession>;
function Mounted({ source = 'original-a', active = true }: { source?: string; active?: boolean }) {
  session = useMediaDubbingSession({ source, active, controller: null, controlSource: { shouldPlay: true, isMuted: false, rate: 1, volume: 1 } });
  return <Text>{session.options?.sourceKey ?? 'original'}</Text>;
}
beforeEach(() => {
  jest.clearAllMocks(); mockEnabled = true; mockActor = '11111111-1111-4111-8111-111111111111';
  jest.mocked(resolveCaptionSource).mockResolvedValue({ assetId, version: 1, revisionKey: 'b'.repeat(64), durationMs: 2000, canEdit: true });
  jest.mocked(getDubbingOptions).mockResolvedValue(descriptor);
});

it('uses only current authorized ready languages without automatic selection or synthesis', async () => {
  await render(<Mounted />);
  await waitFor(() => expect(session.options).toEqual(descriptor));
  expect(mockPlaybackOptions.languages).toEqual(['en']);
  expect(mockPlaybackOptions.controlSource.isMuted).toBe(false);
  expect(mockPlaybackOptions.automaticPreference).toBeUndefined();
  expect(mockPlayback.selectDubbed).not.toHaveBeenCalled();
});

it('OFF and inactive sessions do not resolve or request any media', async () => {
  mockEnabled = false;
  const rendered = await render(<Mounted />);
  expect(resolveCaptionSource).not.toHaveBeenCalled();
  expect(getDubbingOptions).not.toHaveBeenCalled();
  expect(mockPlaybackOptions.enabled).toBe(false);
  mockEnabled = true;
  await rendered.rerender(<Mounted active={false} />);
  expect(resolveCaptionSource).not.toHaveBeenCalled();
});

it('generation mismatch and provider failure preserve original audio', async () => {
  jest.mocked(getDubbingOptions).mockResolvedValue({ ...descriptor, sourceVersion: 2 });
  const rendered = await render(<Mounted />);
  await waitFor(() => expect(getDubbingOptions).toHaveBeenCalled());
  expect(session.options).toBeNull();
  expect(mockPlaybackOptions.enabled).toBe(false);
  jest.mocked(getDubbingOptions).mockRejectedValue(new Error('unavailable'));
  await rendered.rerender(<Mounted source="original-b" />);
  expect(session.options).toBeNull();
});

it('source and account changes discard late descriptors', async () => {
  let complete!: (value: typeof descriptor) => void;
  jest.mocked(getDubbingOptions).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const rendered = await render(<Mounted />);
  await waitFor(() => expect(complete).toBeDefined());
  mockActor = '33333333-3333-4333-8333-333333333333';
  await rendered.rerender(<Mounted source="original-b" />);
  await waitFor(() => expect(session.options?.sourceKey).toBe(descriptor.sourceKey));
  await act(async () => { complete({ ...descriptor, sourceKey: 'c'.repeat(64) }); });
  expect(session.options?.sourceKey).toBe(descriptor.sourceKey);
});

it('backgrounding and explicit caption invalidation immediately disable dubbed playback', async () => {
  await render(<Mounted />);
  await waitFor(() => expect(session.options).not.toBeNull());
  await act(async () => { mockAppListener('background'); });
  expect(session.options).toBeNull();
  expect(mockPlaybackOptions.active).toBe(false);
  await act(async () => { mockAppListener('active'); });
  await waitFor(() => expect(session.options).not.toBeNull());
  jest.mocked(resolveCaptionSource).mockImplementation(() => new Promise(() => {}));
  await act(async () => { session.invalidate(); });
  expect(session.options).toBeNull();
  expect(mockPlaybackOptions.enabled).toBe(false);
});
