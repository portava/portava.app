import React from 'react';
import { Text } from 'react-native';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';
import { CaptionTranslationSheet } from '../CaptionTranslationSheet.tsx';
import { MediaCaptionControls } from '../MediaCaptionControls.tsx';
import * as translation from '../../../services/media/captionTranslation.ts';
import * as captions from '../../../services/media/captions.ts';

jest.mock('../../../services/media/captionTranslation.ts', () => ({ ...jest.requireActual('../../../services/media/captionTranslation.ts'), getCaptionTranslationStatus: jest.fn(), requestCaptionTranslation: jest.fn(), revokeCaptionTranslation: jest.fn(), readCaptionTranslationDraft: jest.fn(), publishCaptionTranslation: jest.fn() }));
jest.mock('../../../services/media/captions.ts', () => ({ ...jest.requireActual('../../../services/media/captions.ts'), resolveCaptionSource: jest.fn(), publishCaptionDraft: jest.fn() }));
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({ ...jest.requireActual('../../../context/FeatureFlagsContext.tsx'), useFeatureFlags: () => ({ isEnabled: () => true }) }));
jest.mock('../../../context/SessionContext.tsx', () => ({ ...jest.requireActual('../../../context/SessionContext.tsx'), useSession: () => ({ userId: 'owner' }) }));

const source = { assetId: '20000000-0000-4000-a000-000000000001', version: 2, revisionKey: 'a'.repeat(64), durationMs: 3000, canEdit: true };
const status: translation.CaptionTranslationStatus = { enabled: true, allowedPairs: [{ source: 'en', target: 'fr' }, { source: 'en', target: 'es' }], sourceVersion: 2, revisionKey: source.revisionKey, consentEpoch: 7, state: 'not_requested', canRevoke: false, current: true, cleanupPending: false };
const draft: translation.CaptionTranslationDraftDto = { draftId: 'd'.repeat(64), version: 2, revisionKey: source.revisionKey, vtt: 'WEBVTT\n\n00:00.000 --> 00:01.000\nBonjour', language: 'fr', sourceLanguage: 'en', aiLabel: 'AI translation · needs creator review', modelVersion: 'synthetic-fixture' };
const published: translation.CaptionTranslationPublishResponse = { assetId: source.assetId, version: 2, revisionKey: 'b'.repeat(64), language: 'fr', sourceKind: 'translation', aiLabel: 'AI translation · creator reviewed', availableLanguages: ['en', 'fr'], cleanupPending: false };
const permission = 'I have permission to translate these captions locally';
const review = 'I reviewed these captions and have permission to publish them';
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(translation.getCaptionTranslationStatus).mockResolvedValue(status);
  jest.mocked(translation.requestCaptionTranslation).mockResolvedValue({ ...status, state: 'pending', canRevoke: true, jobId: '30000000-0000-4000-a000-000000000001' });
  jest.mocked(translation.readCaptionTranslationDraft).mockResolvedValue(draft);
  jest.mocked(translation.publishCaptionTranslation).mockResolvedValue(published);
  jest.mocked(translation.revokeCaptionTranslation).mockResolvedValue({ revoked: true, consentEpoch: 8, cleanupPending: true });
  jest.mocked(captions.resolveCaptionSource).mockResolvedValue(source);
});
afterEach(() => { expect(captions.publishCaptionDraft).not.toHaveBeenCalled(); });

it('never auto-consents or auto-publishes and submits the exact captured translation epoch after permission', async () => {
  await render(<CaptionTranslationSheet source={source} onClose={jest.fn()} onPublished={jest.fn()} onRevoked={jest.fn()} />);
  await screen.findByText('Translation: not requested');
  await fireEvent.press(screen.getByLabelText('Request subtitle translation draft'));
  expect(translation.requestCaptionTranslation).not.toHaveBeenCalled();
  expect(translation.readCaptionTranslationDraft).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText(permission));
  await fireEvent.press(screen.getByLabelText('Request subtitle translation draft'));
  await screen.findByText(/Translation: pending.*Nothing is published/);
  expect(translation.requestCaptionTranslation).toHaveBeenCalledWith(source, 'en', 'fr', true, 7, expect.anything());
  expect(screen.getByLabelText(permission).props.accessibilityState.checked).toBe(false);
  expect(translation.publishCaptionTranslation).not.toHaveBeenCalled();
});

it('language-pair changes reset processing consent and offer only the advertised pairs', async () => {
  await render(<CaptionTranslationSheet source={source} onClose={jest.fn()} onPublished={jest.fn()} onRevoked={jest.fn()} />);
  await screen.findByText('Translation: not requested');
  await fireEvent.press(screen.getByLabelText(permission));
  await fireEvent.press(screen.getByLabelText('Translation language pair: en to fr'));
  expect(screen.getByLabelText(permission).props.accessibilityState.checked).toBe(false);
  await fireEvent.press(screen.getByLabelText('Request subtitle translation draft'));
  expect(translation.requestCaptionTranslation).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText(permission));
  await fireEvent.press(screen.getByLabelText('Request subtitle translation draft'));
  expect(translation.requestCaptionTranslation).toHaveBeenCalledWith(source, 'en', 'es', true, 7, expect.anything());
});

it('requires separate review, resets it on edits, and publishes translated WebVTT only after explicit review', async () => {
  jest.mocked(translation.getCaptionTranslationStatus).mockResolvedValue({ ...status, state: 'completed' });
  const saved = jest.fn();
  await render(<CaptionTranslationSheet source={source} onClose={jest.fn()} onPublished={saved} onRevoked={jest.fn()} />);
  await screen.findByText('Translation: completed');
  expect(translation.publishCaptionTranslation).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('Review translation draft'));
  await screen.findByText(draft.aiLabel);
  expect(screen.getByText(/Publishing replaces any existing fr.*original en/)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Publish reviewed translation'));
  expect(translation.publishCaptionTranslation).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText(review));
  await fireEvent.changeText(screen.getByLabelText('Translated WebVTT captions'), 'Reviewed timed captions');
  expect(screen.getByLabelText(review).props.accessibilityState.checked).toBe(false);
  await fireEvent.press(screen.getByLabelText('Publish reviewed translation'));
  expect(translation.publishCaptionTranslation).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText(review));
  await fireEvent.press(screen.getByLabelText('Publish reviewed translation'));
  await waitFor(() => expect(saved).toHaveBeenCalledWith(published));
  expect(translation.publishCaptionTranslation).toHaveBeenCalledWith(source, draft, 'Reviewed timed captions', true, expect.anything());
  expect(screen.queryByLabelText('Translated WebVTT captions')).toBeNull();
});

it('allows confirmed withdrawal while OFF and keeps cleanup debt visible without claiming complete erasure', async () => {
  jest.mocked(translation.getCaptionTranslationStatus).mockResolvedValue({ ...status, enabled: false, cleanupPending: true });
  const revoked = jest.fn();
  await render(<CaptionTranslationSheet source={source} onClose={jest.fn()} onPublished={jest.fn()} onRevoked={revoked} />);
  await screen.findByText(/unavailable until its model/);
  await fireEvent.press(screen.getByLabelText(permission));
  await fireEvent.press(screen.getByLabelText('Request subtitle translation draft'));
  expect(translation.requestCaptionTranslation).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('Revoke translation and erase drafts'));
  expect(translation.revokeCaptionTranslation).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('Confirm revoke translation and erase drafts'));
  await screen.findByText(/Translation permission revoked.*storage cleanup needs retry/);
  expect(revoked).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText(permission).props.accessibilityState.checked).toBe(false);
});

it('withdrawal clears the draft and requires fresh status plus deliberate re-consent', async () => {
  let refreshed!: (value: translation.CaptionTranslationStatus) => void;
  jest.mocked(translation.getCaptionTranslationStatus).mockResolvedValueOnce({ ...status, state: 'completed' }).mockImplementationOnce(() => new Promise((resolve) => { refreshed = resolve; }));
  await render(<CaptionTranslationSheet source={source} onClose={jest.fn()} onPublished={jest.fn()} onRevoked={jest.fn()} />);
  await screen.findByText('Translation: completed');
  await fireEvent.press(screen.getByLabelText('Review translation draft'));
  await screen.findByLabelText('Translated WebVTT captions');
  await fireEvent.press(screen.getByLabelText(review));
  await fireEvent.press(screen.getByLabelText('Revoke translation and erase drafts'));
  await fireEvent.press(screen.getByLabelText('Confirm revoke translation and erase drafts'));
  await screen.findByText(/Translation permission revoked/);
  expect(screen.queryByLabelText('Translated WebVTT captions')).toBeNull();
  await fireEvent.press(screen.getByLabelText('Request subtitle translation draft'));
  expect(translation.requestCaptionTranslation).not.toHaveBeenCalled();
  await act(async () => refreshed({ ...status, consentEpoch: 8 }));
  await fireEvent.press(screen.getByLabelText('Request subtitle translation draft'));
  expect(translation.requestCaptionTranslation).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText(permission));
  await fireEvent.press(screen.getByLabelText('Request subtitle translation draft'));
  expect(translation.requestCaptionTranslation).toHaveBeenCalledWith(source, 'en', 'fr', true, 8, expect.anything());
});

it('stale caption snapshots are not silently rebased into a fresh request or review', async () => {
  jest.mocked(translation.getCaptionTranslationStatus).mockResolvedValue({ ...status, revisionKey: 'f'.repeat(64), state: 'completed' });
  await render(<CaptionTranslationSheet source={source} onClose={jest.fn()} onPublished={jest.fn()} onRevoked={jest.fn()} />);
  await screen.findByText(/The video or captions changed/);
  await fireEvent.press(screen.getByLabelText(permission));
  await fireEvent.press(screen.getByLabelText('Request subtitle translation draft'));
  await fireEvent.press(screen.getByLabelText('Review translation draft'));
  expect(translation.requestCaptionTranslation).not.toHaveBeenCalled();
  expect(translation.readCaptionTranslationDraft).not.toHaveBeenCalled();
});

it('failed publication discards checked review and requires authoritative refresh rather than automatic retry', async () => {
  jest.mocked(translation.getCaptionTranslationStatus).mockResolvedValue({ ...status, state: 'completed' });
  jest.mocked(translation.publishCaptionTranslation).mockRejectedValueOnce(new Error('ambiguous response'));
  const publishedCallback = jest.fn();
  await render(<CaptionTranslationSheet source={source} onClose={jest.fn()} onPublished={publishedCallback} onRevoked={jest.fn()} />);
  await screen.findByText('Translation: completed');
  await fireEvent.press(screen.getByLabelText('Review translation draft'));
  await screen.findByLabelText('Translated WebVTT captions');
  await fireEvent.press(screen.getByLabelText(review));
  await fireEvent.press(screen.getByLabelText('Publish reviewed translation'));
  await screen.findByText(/Publication could not be confirmed.*authoritative captions/);
  expect(screen.queryByLabelText('Publish reviewed translation')).toBeNull();
  expect(translation.publishCaptionTranslation).toHaveBeenCalledTimes(1);
  expect(publishedCallback).not.toHaveBeenCalled();
});

it('deduplicates taps and discards late responses and permissions after a source generation change', async () => {
  let finish!: (value: Awaited<ReturnType<typeof translation.requestCaptionTranslation>>) => void;
  jest.mocked(translation.requestCaptionTranslation).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const mounted = await render(<CaptionTranslationSheet source={source} onClose={jest.fn()} onPublished={jest.fn()} onRevoked={jest.fn()} />);
  await screen.findByText('Translation: not requested');
  await fireEvent.press(screen.getByLabelText(permission));
  await fireEvent.press(screen.getByLabelText('Request subtitle translation draft'));
  await fireEvent.press(screen.getByLabelText('Request subtitle translation draft'));
  expect(translation.requestCaptionTranslation).toHaveBeenCalledTimes(1);
  jest.mocked(translation.getCaptionTranslationStatus).mockResolvedValue({ ...status, sourceVersion: 3 });
  await mounted.rerender(<CaptionTranslationSheet source={{ ...source, version: 3 }} onClose={jest.fn()} onPublished={jest.fn()} onRevoked={jest.fn()} />);
  await screen.findByText('Translation: not requested');
  await act(async () => finish({ ...status, state: 'pending', jobId: 'old' }));
  expect(screen.queryByText(/Translation: pending/)).toBeNull();
  expect(screen.getByLabelText(permission).props.accessibilityState.checked).toBe(false);
});

function ControlsHarness() {
  const [invalidated, setInvalidated] = React.useState(false);
  return <><Text>{invalidated ? 'Playback source invalidated' : 'Playback source unchanged'}</Text><MediaCaptionControls source="video" status={null} onSourceChanged={() => setInvalidated(true)} /></>;
}

it('integrated creator controls publish through the translation sheet and immediately invalidate playback', async () => {
  jest.mocked(translation.getCaptionTranslationStatus).mockResolvedValue({ ...status, state: 'completed' });
  await render(<ControlsHarness />);
  await fireEvent.press(await screen.findByLabelText('Manage subtitle translation'));
  await screen.findByText('Translation: completed');
  await fireEvent.press(screen.getByLabelText('Review translation draft'));
  await screen.findByLabelText('Translated WebVTT captions');
  await fireEvent.press(screen.getByLabelText(review));
  await fireEvent.press(screen.getByLabelText('Publish reviewed translation'));
  await screen.findByText('Playback source invalidated');
  expect(screen.queryByLabelText('Translated WebVTT captions')).toBeNull();
  expect(translation.publishCaptionTranslation).toHaveBeenCalledTimes(1);
});

it('noncreators have no translation management entry or sheet requests', async () => {
  jest.mocked(captions.resolveCaptionSource).mockResolvedValue({ ...source, canEdit: false });
  await render(<ControlsHarness />);
  await screen.findByLabelText('Show timed captions');
  expect(screen.queryByLabelText('Manage subtitle translation')).toBeNull();
  expect(translation.getCaptionTranslationStatus).not.toHaveBeenCalled();
});
