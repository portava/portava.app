import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { MediaDubbingControls } from '../MediaDubbingControls.tsx';
import * as service from '../../../services/media/dubbing.ts';

const mockUserId = '11111111-1111-4111-8111-111111111111';
jest.mock('../../../context/SessionContext.tsx', () => { return { useSession: () => ({ userId: mockUserId, isAuthed: true }) }; });
jest.mock('../../../context/LanguagePreferenceContext.tsx', () => { return { useLanguagePreference: () => ({ preferredLanguage: 'fr' }) }; });
jest.mock('../../../services/media/dubbing.ts', () => {
  return { DUBBING_LABEL: 'AI-generated translated audio', DUBBING_DISCLOSURE_VERSION: 'synthetic-dubbing-v1', getDubbingConsent: jest.fn(), requestDubbing: jest.fn(), revokeDubbing: jest.fn(), DubbingRequestError: class extends Error { code: string; constructor(code: string) { super(code); this.code = code; } } };
});
const props = () => ({ assetId: '22222222-2222-4222-8222-222222222222', sourceKey: 'v1', ownerId: mockUserId, enabled: true, languages: [{ code: 'en-US', label: 'English', ready: true }, { code: 'fr', label: 'French', ready: true }], disclosure: { version: 'synthetic-dubbing-v1' as const, text: 'Synthetic fixture approval text; not approved production copy.', approved: true as const }, playback: { status: 'original' as const, language: null, muteOriginal: false, selectOriginal: jest.fn(async () => {}), selectDubbed: jest.fn(async () => {}), onSourceStatus: jest.fn() } });
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(service.getDubbingConsent).mockResolvedValue({ consentRevision: 'a'.repeat(64), optedIn: false, label: 'AI-generated translated audio', disclosureVersion: 'synthetic-dubbing-v1' });
  jest.mocked(service.requestDubbing).mockResolvedValue({ jobId: '33333333-3333-4333-8333-333333333333', status: 'queued', label: 'AI-generated translated audio', originalPreserved: true });
  jest.mocked(service.revokeDubbing).mockResolvedValue(undefined);
});

it('mounts creator controls with preferred language but no implicit synthesis consent or playback', async () => {
  const input = props(); await render(<MediaDubbingControls {...input} />);
  await waitFor(() => expect(service.getDubbingConsent).toHaveBeenCalled());
  expect(screen.getByLabelText('French').props.accessibilityState.selected).toBe(true);
  expect(screen.getByLabelText('I agree to generate AI audio').props.accessibilityState.checked).toBe(false);
  expect(service.requestDubbing).not.toHaveBeenCalled(); expect(input.playback.selectDubbed).not.toHaveBeenCalled();
  expect(screen.getByText(/background music is not mixed/i)).toBeTruthy();
});

it('requires an explicit checkbox and current language-bound receipt before queueing', async () => {
  await render(<MediaDubbingControls {...props()} />);
  await waitFor(() => expect(screen.getByLabelText('I agree to generate AI audio')).toBeTruthy());
  await act(async () => { fireEvent.press(screen.getByLabelText('Generate AI audio')); });
  expect(service.requestDubbing).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(screen.getByLabelText('I agree to generate AI audio')); });
  await act(async () => { fireEvent.press(screen.getByLabelText('Generate AI audio')); });
  await waitFor(() => expect(screen.getByText('AI audio requested. It is not ready to play yet.')).toBeTruthy());
  expect(service.requestDubbing).toHaveBeenCalledWith(expect.objectContaining({ userId: mockUserId }), 'fr', 'a'.repeat(64), true, expect.anything());
});

it('language and source changes reset consent; late responses cannot reauthorize another source', async () => {
  const input = props(); const mounted = await render(<MediaDubbingControls {...input} />);
  await waitFor(() => expect(screen.getByLabelText('I agree to generate AI audio')).toBeTruthy());
  await act(async () => { fireEvent.press(screen.getByLabelText('I agree to generate AI audio')); fireEvent.press(screen.getByLabelText('English')); });
  await waitFor(() => expect(service.getDubbingConsent).toHaveBeenLastCalledWith(expect.anything(), 'en-US', expect.anything()));
  expect(screen.getByLabelText('I agree to generate AI audio').props.accessibilityState.checked).toBe(false);
  await mounted.rerender(<MediaDubbingControls {...input} sourceKey="v2" />);
  expect(screen.getByLabelText('I agree to generate AI audio').props.accessibilityState.checked).toBe(false);
});

it('viewers only select original or labelled existing AI audio and explicit auto setting is separate', async () => {
  const input = props(); const automatic = jest.fn();
  await render(<MediaDubbingControls {...input} ownerId="different-owner" onAutomaticPreferenceChange={automatic} />);
  expect(service.getDubbingConsent).not.toHaveBeenCalled(); expect(screen.queryByLabelText('Generate AI audio')).toBeNull();
  await act(async () => { fireEvent.press(screen.getByLabelText('Play AI audio')); fireEvent.press(screen.getByLabelText('Original audio')); });
  expect(input.playback.selectDubbed).toHaveBeenCalledWith('fr'); expect(input.playback.selectOriginal).toHaveBeenCalled();
  expect(automatic).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(screen.getByLabelText('Automatically use AI audio in my preferred language')); });
  expect(automatic).toHaveBeenCalledWith({ userId: mockUserId, enabled: true });
});

it('withdrawal stays available while OFF, immediately selects original and reports cleanup retry honestly', async () => {
  const input = props();
  jest.mocked(service.revokeDubbing).mockRejectedValue(new service.DubbingRequestError('cleanup_failed'));
  await render(<MediaDubbingControls {...input} enabled={false} />);
  expect(service.getDubbingConsent).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(screen.getByLabelText('Remove AI audio')); });
  await waitFor(() => expect(screen.getByText('Permission withdrawn. Audio cleanup needs another attempt.')).toBeTruthy());
  expect(input.playback.selectOriginal).toHaveBeenCalled();
  expect(service.revokeDubbing).toHaveBeenCalled(); expect(service.requestDubbing).not.toHaveBeenCalled();
  expect(service.getDubbingConsent).not.toHaveBeenCalled();
});

it('missing approved disclosure blocks generation without removing withdrawal', async () => {
  await render(<MediaDubbingControls {...props()} disclosure={undefined} />);
  expect(screen.queryByLabelText('I agree to generate AI audio')).toBeNull();
  expect(screen.getByLabelText('Generate AI audio').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByLabelText('Remove AI audio')).toBeTruthy();
});

it('changed disclosure wording clears the previous acceptance', async () => {
  const input = props(); const mounted = await render(<MediaDubbingControls {...input} />);
  await act(async () => { fireEvent.press(screen.getByLabelText('I agree to generate AI audio')); });
  expect(screen.getByLabelText('I agree to generate AI audio').props.accessibilityState.checked).toBe(true);
  await mounted.rerender(<MediaDubbingControls {...input} disclosure={{ ...input.disclosure, text: 'Changed synthetic test disclosure.' }} />);
  expect(screen.getByLabelText('I agree to generate AI audio').props.accessibilityState.checked).toBe(false);
  expect(service.requestDubbing).not.toHaveBeenCalled();
});

it('withdrawal supersedes pending generation and ignores its late success', async () => {
  let finishRequest!: (value: Awaited<ReturnType<typeof service.requestDubbing>>) => void;
  jest.mocked(service.requestDubbing).mockImplementationOnce(() => new Promise((resolve) => { finishRequest = resolve; }));
  await render(<MediaDubbingControls {...props()} />);
  await act(async () => { fireEvent.press(screen.getByLabelText('I agree to generate AI audio')); });
  await act(async () => { fireEvent.press(screen.getByLabelText('Generate AI audio')); });
  await waitFor(() => expect(finishRequest).toBeDefined());
  const requestSignal = jest.mocked(service.requestDubbing).mock.calls[0][4]!;
  await act(async () => { fireEvent.press(screen.getByLabelText('Remove AI audio')); });
  expect(requestSignal.aborted).toBe(true);
  await act(async () => { finishRequest({ status: 'queued', jobId: '33333333-3333-4333-8333-333333333333', label: 'AI-generated translated audio', originalPreserved: true }); });
  expect(screen.getByText('AI audio permission withdrawn.')).toBeTruthy();
  expect(screen.queryByText('AI audio requested. It is not ready to play yet.')).toBeNull();
});

it('requestable but unready audio cannot play while explicit generation remains available', async () => {
  const input = props(); input.languages[1].ready = false;
  await render(<MediaDubbingControls {...input} />);
  await waitFor(() => expect(service.getDubbingConsent).toHaveBeenCalled());
  expect(screen.getByLabelText('Play AI audio').props.accessibilityState.disabled).toBe(true);
  await act(async () => { fireEvent.press(screen.getByLabelText('Play AI audio')); });
  expect(input.playback.selectDubbed).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(screen.getByLabelText('I agree to generate AI audio')); });
  expect(screen.getByLabelText('Generate AI audio').props.accessibilityState.disabled).toBe(false);
  expect(service.requestDubbing).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(screen.getByLabelText('English')); });
  await act(async () => { fireEvent.press(screen.getByLabelText('Play AI audio')); });
  expect(input.playback.selectDubbed).toHaveBeenCalledWith('en-US');
});

it('losing readiness immediately disables an already selected language without playing another', async () => {
  const input = props();
  const mounted = await render(<MediaDubbingControls {...input} ownerId="different-owner" />);
  expect(screen.getByLabelText('Play AI audio').props.accessibilityState.disabled).toBe(false);
  await mounted.rerender(<MediaDubbingControls {...input} ownerId="different-owner" languages={input.languages.map(item => ({ ...item, ready: false }))} />);
  expect(screen.getByLabelText('Play AI audio').props.accessibilityState.disabled).toBe(true);
  await act(async () => { fireEvent.press(screen.getByLabelText('Play AI audio')); });
  expect(input.playback.selectDubbed).not.toHaveBeenCalled();
});

it('waits for persisted preference hydration and prevents enabling while the feature is OFF', async () => {
  const input = props(); const automatic = jest.fn();
  const mounted = await render(<MediaDubbingControls {...input} ownerId="another-owner" automaticPreferenceLoading onAutomaticPreferenceChange={automatic} />);
  const label = 'Automatically use AI audio in my preferred language';
  expect(screen.getByLabelText(label).props.accessibilityState).toMatchObject({ checked: false, disabled: true, busy: true });
  await fireEvent.press(screen.getByLabelText(label));
  await mounted.rerender(<MediaDubbingControls {...input} ownerId="another-owner" enabled={false} onAutomaticPreferenceChange={automatic} />);
  await fireEvent.press(screen.getByLabelText(label));
  expect(automatic).not.toHaveBeenCalled();
  expect(service.requestDubbing).not.toHaveBeenCalled();
});

it('allows explicit opt-out while OFF without treating the setting as creator consent', async () => {
  const input = props(); const automatic = jest.fn();
  await render(<MediaDubbingControls {...input} enabled={false} automaticPreference={{ userId: mockUserId, enabled: true }} onAutomaticPreferenceChange={automatic} />);
  const label = 'Automatically use AI audio in my preferred language';
  expect(screen.getByLabelText(label).props.accessibilityState).toMatchObject({ checked: true, disabled: false });
  await fireEvent.press(screen.getByLabelText(label));
  expect(automatic).toHaveBeenCalledWith({ userId: mockUserId, enabled: false });
  expect(service.requestDubbing).not.toHaveBeenCalled();
  expect(service.getDubbingConsent).not.toHaveBeenCalled();
  expect(input.playback.selectDubbed).not.toHaveBeenCalled();
  expect(screen.getByLabelText('I agree to generate AI audio').props.accessibilityState.checked).toBe(false);
});

it('reports failed persistence without checking the preference or implying consent', async () => {
  const input = props(); const automatic = jest.fn(async () => { throw new Error('disk unavailable'); });
  await render(<MediaDubbingControls {...input} ownerId="another-owner" onAutomaticPreferenceChange={automatic} />);
  const label = 'Automatically use AI audio in my preferred language';
  await fireEvent.press(screen.getByLabelText(label));
  await screen.findByText('Automatic audio preference was not saved.');
  expect(screen.getByLabelText(label).props.accessibilityState.checked).toBe(false);
  expect(service.requestDubbing).not.toHaveBeenCalled();
  expect(input.playback.selectDubbed).not.toHaveBeenCalled();
});
