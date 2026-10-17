import React from 'react';
import { Text } from 'react-native';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import { TimedCaptionOverlay } from '../TimedCaptionOverlay.tsx';
import { MediaCaptionControls } from '../MediaCaptionControls.tsx';
import { CaptionAuthoringSheet } from '../CaptionAuthoringSheet.tsx';
import { SharedVideoPlayer } from '../../ui/SharedVideoPlayer.tsx';
import { WatchVideoCell } from '../WatchVideoCell.tsx';
import * as captions from '../../../services/media/captions.ts';

let mockEnabled = true;
let mockViewer: string | null = 'owner';
let mockPlayback: (status: any) => void;
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({ ...jest.requireActual('../../../context/FeatureFlagsContext.tsx'), useFeatureFlags: () => ({ isEnabled: () => mockEnabled }) }));
jest.mock('../../../context/SessionContext.tsx', () => ({ ...jest.requireActual('../../../context/SessionContext.tsx'), useSession: () => ({ userId: mockViewer }) }));
jest.mock('../../../services/media/captions.ts', () => ({ ...jest.requireActual('../../../services/media/captions.ts'), resolveCaptionSource: jest.fn(), readCaptionTrack: jest.fn(), saveCaptionTrack: jest.fn(), deleteCaptionTrack: jest.fn(), readCaptionDraft: jest.fn(), publishCaptionDraft: jest.fn(), getCaptionAsrStatus: jest.fn(), revokeCaptionAsr: jest.fn() }));
jest.mock('../../../services/mediaUrl.ts', () => ({ ...jest.requireActual('../../../services/mediaUrl.ts'), useHydratedMedia: () => ({ resolved: {} }) }));
jest.mock('../../../hooks/useSmartVideoFit.ts', () => ({ ...jest.requireActual('../../../hooks/useSmartVideoFit.ts'), useSmartVideoFit: () => ({ resizeMode: 'cover', needsLetterbox: false, onReadyForDisplay: jest.fn() }) }));
jest.mock('../../ui/VideoBlurBackdrop.tsx', () => ({ ...jest.requireActual('../../ui/VideoBlurBackdrop.tsx'), VideoBlurBackdrop: () => null }));
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({ ...jest.requireActual('../../ui/DisplayMediaImage.tsx'), DisplayMediaImage: () => null }));
jest.mock('../../CachedImage.tsx', () => ({ ...jest.requireActual('../../CachedImage.tsx'), CachedImage: () => null }));
jest.mock('expo-av', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { Video: React.forwardRef(({ onPlaybackStatusUpdate }: any, ref: any) => {
    mockPlayback = onPlaybackStatusUpdate;
    React.useImperativeHandle(ref, () => ({ playAsync: async () => {}, pauseAsync: async () => {}, setPositionAsync: async () => {} }), []);
    return <View testID="caption-video" />;
  }) };
});

const source = { assetId: 'asset', version: 2, revisionKey: '0'.repeat(64), durationMs: 3000, canEdit: true };
const cues = [{ startMs: 0, endMs: 1000, text: 'First cue' }, { startMs: 1000, endMs: 2000, text: 'Second cue' }];
const result = { assetId: 'asset', version: 2, revisionKey: '0'.repeat(64), cues, vtt: 'WEBVTT\n\n00:00.000 --> 00:01.000\nFirst cue' };

beforeEach(() => {
  jest.clearAllMocks();
  mockEnabled = true;
  mockViewer = 'owner';
  jest.mocked(captions.resolveCaptionSource).mockResolvedValue(source);
  jest.mocked(captions.readCaptionTrack).mockResolvedValue(result);
  jest.mocked(captions.saveCaptionTrack).mockResolvedValue({ ...result, revisionKey: 'a'.repeat(64) });
  jest.mocked(captions.deleteCaptionTrack).mockResolvedValue({ ...result, revisionKey: 'a'.repeat(64), cues: [], vtt: null });
  jest.mocked(captions.readCaptionDraft).mockResolvedValue({ ...result, cues: [], sourceKind: 'asr', language: 'en', draftId: 'draft-id', aiLabel: 'AI transcription · needs creator review' });
  jest.mocked(captions.publishCaptionDraft).mockResolvedValue({ ...result, revisionKey: 'a'.repeat(64), sourceKind: 'asr', aiLabel: 'AI transcription · creator reviewed' });
  jest.mocked(captions.getCaptionAsrStatus).mockResolvedValue({ enabled: false, languages: [], sourceVersion: source.version, revisionKey: source.revisionKey, consentEpoch: 'a'.repeat(64), state: 'not_requested', canRevoke: false, current: true });
  jest.mocked(captions.revokeCaptionAsr).mockResolvedValue({ revoked: true, cleanupPending: false });
});

it('renders start-inclusive/end-exclusive cues, overlapping text, backward seek and unloaded silence', async () => {
  const mounted = await render(<TimedCaptionOverlay cues={cues} status={{ isLoaded: true, positionMillis: 0 }} />);
  expect(screen.getByText('First cue')).toBeTruthy();
  await mounted.rerender(<TimedCaptionOverlay cues={cues} status={{ isLoaded: true, positionMillis: 1000 }} />);
  expect(screen.queryByText('First cue')).toBeNull();
  expect(screen.getByText('Second cue')).toBeTruthy();
  await mounted.rerender(<TimedCaptionOverlay cues={cues} status={{ isLoaded: true, positionMillis: 2000 }} />);
  expect(screen.queryByTestId('timed-caption')).toBeNull();
  await mounted.rerender(<TimedCaptionOverlay cues={cues} status={{ isLoaded: true, positionMillis: 500 }} />);
  expect(screen.getByText('First cue')).toBeTruthy();
  await mounted.rerender(<TimedCaptionOverlay cues={[...cues, { startMs: 400, endMs: 800, text: 'Overlap' }]} status={{ isLoaded: true, positionMillis: 500 }} />);
  expect(screen.getByText('First cue\nOverlap')).toBeTruthy();
  await mounted.rerender(<TimedCaptionOverlay cues={cues} status={{ isLoaded: false }} />);
  expect(screen.queryByTestId('timed-caption')).toBeNull();
});

it('keeps paused captions at reported position instead of advancing with wall clock', async () => {
  await render(<TimedCaptionOverlay cues={cues} status={{ isLoaded: true, positionMillis: 500 }} />);
  const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 20_000);
  expect(screen.getByText('First cue')).toBeTruthy();
  now.mockRestore();
});

it('default OFF and signed-out players do not resolve or fetch captions', async () => {
  mockEnabled = false;
  const mounted = await render(<MediaCaptionControls source="video" status={null} />);
  expect(captions.resolveCaptionSource).not.toHaveBeenCalled();
  mockEnabled = true;
  mockViewer = null;
  await mounted.rerender(<MediaCaptionControls source="video" status={null} />);
  expect(captions.resolveCaptionSource).not.toHaveBeenCalled();
});

it('an accessible explicit CC toggle loads cues and hides them when toggled off', async () => {
  await render(<MediaCaptionControls source="video" status={{ isLoaded: true, positionMillis: 500 }} />);
  const button = await screen.findByLabelText('Show timed captions');
  expect(captions.readCaptionTrack).not.toHaveBeenCalled();
  await fireEvent.press(button);
  await screen.findByText('First cue');
  expect(screen.getByLabelText('Hide timed captions').props.accessibilityState.selected).toBe(true);
  await fireEvent.press(screen.getByLabelText('Hide timed captions'));
  expect(screen.queryByTestId('timed-caption')).toBeNull();
});

it('source and account changes discard prior captions and pending source responses', async () => {
  const mounted = await render(<MediaCaptionControls source="first" status={{ isLoaded: true, positionMillis: 500 }} />);
  await fireEvent.press(await screen.findByLabelText('Show timed captions'));
  await screen.findByText('First cue');
  let resolvePending!: (value: typeof source) => void;
  jest.mocked(captions.resolveCaptionSource).mockImplementationOnce(() => new Promise((resolve) => { resolvePending = resolve; }));
  await mounted.rerender(<MediaCaptionControls source="second" status={{ isLoaded: true, positionMillis: 500 }} />);
  expect(screen.queryByText('First cue')).toBeNull();
  mockViewer = 'different';
  await mounted.rerender(<MediaCaptionControls source="third" status={null} />);
  await act(async () => resolvePending({ ...source, assetId: 'stale' }));
  await fireEvent.press(await screen.findByLabelText('Show timed captions'));
  await waitFor(() => expect(captions.readCaptionTrack).toHaveBeenLastCalledWith(source, expect.anything(), undefined));
});

it('reader errors and inactive cells clear text rather than preserving a stale track', async () => {
  const mounted = await render(<MediaCaptionControls source="video" status={{ isLoaded: true, positionMillis: 500 }} />);
  await fireEvent.press(await screen.findByLabelText('Show timed captions'));
  await screen.findByText('First cue');
  await mounted.rerender(<MediaCaptionControls source="video" active={false} status={{ isLoaded: true, positionMillis: 500 }} />);
  expect(screen.queryByText('First cue')).toBeNull();
  jest.mocked(captions.readCaptionTrack).mockRejectedValueOnce(new Error('stale'));
  await mounted.rerender(<MediaCaptionControls source="video" status={{ isLoaded: true, positionMillis: 500 }} />);
  await fireEvent.press(await screen.findByLabelText('Show timed captions'));
  await screen.findByText('Captions unavailable. Close and reopen this video to refresh.');
  expect(screen.queryByText('First cue')).toBeNull();
});

it('owner editor requires explicit consent, submits exact WebVTT and generation, no duplicate save', async () => {
  const onSaved = jest.fn();
  let finishSave!: (value: typeof result) => void;
  jest.mocked(captions.saveCaptionTrack).mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
  await render(<CaptionAuthoringSheet source={source} initialVtt={null} onClose={jest.fn()} onSaved={onSaved} />);
  await fireEvent.changeText(screen.getByLabelText('WebVTT timed captions'), result.vtt);
  await fireEvent.press(screen.getByLabelText('Save timed captions'));
  expect(captions.saveCaptionTrack).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText("I have permission to share these captions with this video's audience"));
  await fireEvent.press(screen.getByLabelText('Save timed captions'));
  await fireEvent.press(screen.getByLabelText('Save timed captions'));
  await act(async () => finishSave({ ...result, version: 3 }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(captions.saveCaptionTrack).toHaveBeenCalledTimes(1);
  expect(captions.saveCaptionTrack).toHaveBeenCalledWith(source, result.vtt, true, 'und');
});

it('delete requires confirmation and reports the cleared state', async () => {
  const onSaved = jest.fn();
  await render(<CaptionAuthoringSheet source={source} initialVtt={result.vtt} onClose={jest.fn()} onSaved={onSaved} />);
  await fireEvent.press(screen.getByLabelText('Delete captions'));
  expect(captions.deleteCaptionTrack).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('Confirm delete captions'));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ cues: [], vtt: null, version: 2, revisionKey: 'a'.repeat(64) })));
});

it('non-owner controls do not expose authoring', async () => {
  jest.mocked(captions.resolveCaptionSource).mockResolvedValueOnce({ ...source, canEdit: false });
  await render(<MediaCaptionControls source="video" status={null} />);
  await screen.findByLabelText('Show timed captions');
  expect(screen.queryByLabelText('Edit timed captions')).toBeNull();
});

for (const player of ['shared', 'watch']) {
  it(`${player} player renders captions from actual playback callbacks including seek/unload`, async () => {
    await render(player === 'shared' ? <SharedVideoPlayer uri="video" /> : <WatchVideoCell id="post" videoUrl="video" posterUrl={null} isActive isMuted onProgress={jest.fn()} />);
    await fireEvent.press(await screen.findByLabelText('Show timed captions'));
    await act(async () => mockPlayback({ isLoaded: true, positionMillis: 1200, durationMillis: 3000, isPlaying: false }));
    await screen.findByText('Second cue');
    await act(async () => mockPlayback({ isLoaded: true, positionMillis: 200, durationMillis: 3000, isPlaying: false }));
    expect(screen.getByText('First cue')).toBeTruthy();
    await act(async () => mockPlayback({ isLoaded: false }));
    expect(screen.queryByTestId('timed-caption')).toBeNull();
  });
}

it('ASR review requires the creator to confirm consent before publishing the edited draft', async () => {
  await render(<MediaCaptionControls source="video" status={null} />);
  await fireEvent.press(await screen.findByLabelText('Review generated caption draft'));
  await screen.findByText('AI transcription — review every cue before publishing. Language and speech accuracy are not guaranteed.');
  await fireEvent.changeText(screen.getByLabelText('WebVTT timed captions'), 'Reviewed WebVTT');
  await fireEvent.press(screen.getByLabelText('Save timed captions'));
  expect(captions.publishCaptionDraft).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText("I have permission to share these captions with this video's audience"));
  await fireEvent.press(screen.getByLabelText('Save timed captions'));
  await waitFor(() => expect(captions.publishCaptionDraft).toHaveBeenCalledWith(source, 'draft-id', 'Reviewed WebVTT', true));
  expect(captions.saveCaptionTrack).not.toHaveBeenCalled();
});

it('caption language control requests a distinct track without mutating the original', async () => {
  jest.mocked(captions.readCaptionTrack).mockResolvedValue({ ...result, language: 'en', availableLanguages: ['en', 'fr'] });
  await render(<MediaCaptionControls source="video" status={{ isLoaded: true, positionMillis: 500 }} />);
  await fireEvent.press(await screen.findByLabelText('Show timed captions'));
  await fireEvent.press(await screen.findByLabelText('Caption language: en. Change language'));
  await waitFor(() => expect(captions.readCaptionTrack).toHaveBeenLastCalledWith(source, expect.anything(), 'fr'));
  expect(captions.saveCaptionTrack).not.toHaveBeenCalled();
});

it('expired authorization clears cues before an unresolved refresh', async () => {
  const original = global.setInterval;
  let expire: (() => void) | undefined;
  const timerSpy = jest.spyOn(global, 'setInterval').mockImplementation(((callback: () => void, interval: number) => {
    if (interval === 10000) expire = callback;
    return original(callback, interval);
  }) as typeof setInterval);
  try {
    await render(<MediaCaptionControls source="video" status={{ isLoaded: true, positionMillis: 500 }} />);
    await fireEvent.press(await screen.findByLabelText('Show timed captions'));
    await screen.findByText('First cue');
    jest.mocked(captions.readCaptionTrack).mockImplementationOnce(() => new Promise(() => {}));
    await act(async () => expire?.());
    expect(screen.queryByText('First cue')).toBeNull();
  } finally { timerSpy.mockRestore(); }
});

it('late playback callbacks from a replaced source cannot render captions on its successor', async () => {
  const mounted = await render(<SharedVideoPlayer uri="first" />);
  const staleCallback = mockPlayback;
  await mounted.rerender(<SharedVideoPlayer uri="second" />);
  await fireEvent.press(await screen.findByLabelText('Show timed captions'));
  await act(async () => staleCallback({ isLoaded: true, positionMillis: 500, isPlaying: false }));
  expect(screen.queryByText('First cue')).toBeNull();
});

function InvalidationHarness() {
  const [invalidations, setInvalidations] = React.useState(0);
  return <><Text>{`Playback invalidations: ${invalidations}`}</Text><MediaCaptionControls source="video" status={null} onSourceChanged={() => setInvalidations((value) => value + 1)} /></>;
}

for (const action of ['save', 'delete', 'draft publish', 'ASR revoke']) {
  it(`immediately invalidates the parent playback descriptor after successful ${action}`, async () => {
    await render(<InvalidationHarness />);
    if (action === 'ASR revoke') {
      await fireEvent.press(await screen.findByLabelText('Manage local transcription'));
      await screen.findByText(/unavailable until its model/);
      await fireEvent.press(screen.getByLabelText('Stop transcription and delete drafts'));
      await fireEvent.press(screen.getByLabelText('Confirm stop transcription and delete drafts'));
    } else {
      await fireEvent.press(await screen.findByLabelText(action === 'draft publish' ? 'Review generated caption draft' : 'Edit timed captions'));
      await screen.findByLabelText('WebVTT timed captions');
      if (action === 'delete') {
        await fireEvent.press(screen.getByLabelText('Delete captions'));
        await fireEvent.press(screen.getByLabelText('Confirm delete captions'));
      } else {
        await fireEvent.press(screen.getByLabelText("I have permission to share these captions with this video's audience"));
        await fireEvent.press(screen.getByLabelText('Save timed captions'));
      }
    }
    await screen.findByText('Playback invalidations: 1');
  });
}

it('does not announce a successful manifest change after a failed caption save', async () => {
  jest.mocked(captions.saveCaptionTrack).mockRejectedValueOnce(new Error('Caption save refused'));
  await render(<InvalidationHarness />);
  await fireEvent.press(await screen.findByLabelText('Edit timed captions'));
  await screen.findByLabelText('WebVTT timed captions');
  await fireEvent.press(screen.getByLabelText("I have permission to share these captions with this video's audience"));
  await fireEvent.press(screen.getByLabelText('Save timed captions'));
  await screen.findByText('Caption save refused');
  expect(screen.getByText('Playback invalidations: 0')).toBeTruthy();
});
