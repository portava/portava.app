import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import { MediaCaptionControls } from '../MediaCaptionControls.tsx';
import * as captions from '../../../services/media/captions.ts';

let mockPreferredLanguage: string | null = 'fr';
let mockViewer = 'viewer';
const mockUpdateLanguage = jest.fn();
jest.mock('../../../context/LanguagePreferenceContext.tsx', () => ({ ...jest.requireActual('../../../context/LanguagePreferenceContext.tsx'), useLanguagePreference: () => ({ preferredLanguage: mockPreferredLanguage, updateLanguage: mockUpdateLanguage, loading: false }) }));
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({ ...jest.requireActual('../../../context/FeatureFlagsContext.tsx'), useFeatureFlags: () => ({ isEnabled: () => true }) }));
jest.mock('../../../context/SessionContext.tsx', () => ({ ...jest.requireActual('../../../context/SessionContext.tsx'), useSession: () => ({ userId: mockViewer }) }));
jest.mock('../../../services/media/captions.ts', () => ({ ...jest.requireActual('../../../services/media/captions.ts'), resolveCaptionSource: jest.fn(), readCaptionTrack: jest.fn(), saveCaptionTrack: jest.fn(), requestCaptionAsr: jest.fn() }));

const descriptor = { assetId: 'asset', version: 2, revisionKey: 'a'.repeat(64), durationMs: 3000, canEdit: false };
const playback = { isLoaded: true, positionMillis: 500 };
function track(language?: string): captions.CaptionTrackResult {
  const chosen = language === 'fr' || language === 'es' ? language : 'en';
  return { ...descriptor, cues: [{ startMs: 0, endMs: 1000, text: `${chosen} caption` }], vtt: null, language: chosen,
    availableLanguages: ['fr', 'en', 'es'], sourceKind: chosen === 'en' ? 'manual' : 'translation', aiLabel: chosen === 'en' ? null : 'AI translation' };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPreferredLanguage = 'fr';
  mockViewer = 'viewer';
  jest.mocked(captions.resolveCaptionSource).mockResolvedValue(descriptor);
  jest.mocked(captions.readCaptionTrack).mockImplementation(async (_source, _signal, language) => track(language));
});

afterEach(() => {
  expect(mockUpdateLanguage).not.toHaveBeenCalled();
  expect(captions.saveCaptionTrack).not.toHaveBeenCalled();
  expect(captions.requestCaptionAsr).not.toHaveBeenCalled();
});

it('keeps CC OFF until clicked, then shows the saved preferred track and its AI label', async () => {
  await render(<MediaCaptionControls source="video" status={playback} />);
  const toggle = await screen.findByLabelText('Show timed captions');
  expect(captions.readCaptionTrack).not.toHaveBeenCalled();
  expect(screen.queryByTestId('timed-caption')).toBeNull();
  await fireEvent.press(toggle);
  await screen.findByText('fr caption');
  expect(screen.getByText('AI translation')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Hide timed captions'));
  expect(screen.queryByTestId('timed-caption')).toBeNull();
  expect(screen.queryByText('AI translation')).toBeNull();
});

it('keeps a manual language override across preference changes and CC toggles', async () => {
  const mounted = await render(<MediaCaptionControls source="video" status={playback} />);
  await fireEvent.press(await screen.findByLabelText('Show timed captions'));
  await fireEvent.press(await screen.findByLabelText('Caption language: fr. Change language'));
  await screen.findByText('en caption');
  mockPreferredLanguage = 'es';
  await mounted.rerender(<MediaCaptionControls source="video" status={playback} />);
  expect(screen.getByText('en caption')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Hide timed captions'));
  await fireEvent.press(screen.getByLabelText('Show timed captions'));
  await screen.findByText('en caption');
  expect(captions.readCaptionTrack).toHaveBeenLastCalledWith(descriptor, expect.anything(), 'en');
});

it('Original explicitly requests the server original and stays selected rather than reapplying preferences', async () => {
  const mounted = await render(<MediaCaptionControls source="video" status={playback} />);
  await fireEvent.press(await screen.findByLabelText('Show timed captions'));
  await screen.findByText('fr caption');
  await fireEvent.press(screen.getByLabelText('Use original captions'));
  await screen.findByText('en caption');
  expect(screen.queryByText('AI translation')).toBeNull();
  expect(screen.getByLabelText('Use original captions').props.accessibilityState.selected).toBe(true);
  mockPreferredLanguage = 'es';
  await mounted.rerender(<MediaCaptionControls source="video" status={playback} />);
  await fireEvent.press(screen.getByLabelText('Hide timed captions'));
  await fireEvent.press(screen.getByLabelText('Show timed captions'));
  await screen.findByText('en caption');
  expect(captions.readCaptionTrack).toHaveBeenLastCalledWith(descriptor, expect.anything(), undefined);
});

it('follows a newly loaded preference before manual override, refusing late prior-track responses', async () => {
  let finish!: (value: captions.CaptionTrackResult) => void;
  mockPreferredLanguage = null;
  jest.mocked(captions.readCaptionTrack).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const mounted = await render(<MediaCaptionControls source="video" status={playback} />);
  await fireEvent.press(await screen.findByLabelText('Show timed captions'));
  await waitFor(() => expect(captions.readCaptionTrack).toHaveBeenCalledTimes(1));
  const pendingSignal = jest.mocked(captions.readCaptionTrack).mock.calls[0][1];
  mockPreferredLanguage = 'fr';
  await mounted.rerender(<MediaCaptionControls source="video" status={playback} />);
  await screen.findByText('fr caption');
  expect(pendingSignal?.aborted).toBe(true);
  await act(async () => finish(track()));
  expect(screen.queryByText('en caption')).toBeNull();
  expect(screen.getByText('fr caption')).toBeTruthy();
});

it('shows the server original fallback for an unavailable preference without requesting inference', async () => {
  mockPreferredLanguage = 'de';
  await render(<MediaCaptionControls source="video" status={playback} />);
  await fireEvent.press(await screen.findByLabelText('Show timed captions'));
  await screen.findByText('en caption');
  expect(captions.readCaptionTrack).toHaveBeenLastCalledWith(descriptor, expect.anything(), 'de');
  expect(screen.queryByText('AI translation')).toBeNull();
});

it('new source/account resets a manual override and requires CC again', async () => {
  const mounted = await render(<MediaCaptionControls source="first" status={playback} />);
  await fireEvent.press(await screen.findByLabelText('Show timed captions'));
  await screen.findByText('fr caption');
  await fireEvent.press(screen.getByLabelText('Use original captions'));
  await screen.findByText('en caption');
  mockPreferredLanguage = 'es';
  mockViewer = 'other-viewer';
  await mounted.rerender(<MediaCaptionControls source="second" status={playback} />);
  const toggle = await screen.findByLabelText('Show timed captions');
  expect(screen.queryByTestId('timed-caption')).toBeNull();
  await fireEvent.press(toggle);
  await screen.findByText('es caption');
});
