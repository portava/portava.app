import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';
import { CaptionAsrSheet } from '../CaptionAsrSheet.tsx';
import * as captions from '../../../services/media/captions.ts';

jest.mock('../../../services/media/captions.ts', () => ({ ...jest.requireActual('../../../services/media/captions.ts'), getCaptionAsrStatus: jest.fn(), requestCaptionAsr: jest.fn(), revokeCaptionAsr: jest.fn() }));
const source = { assetId: 'asset', version: 2, revisionKey: '0'.repeat(64), durationMs: 3000, canEdit: true };
const available = { enabled: true, languages: ['en', 'fr'], sourceVersion: 2, revisionKey: source.revisionKey, consentEpoch: 'a'.repeat(64), state: 'not_requested', canRevoke: false, current: true };
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(captions.getCaptionAsrStatus).mockResolvedValue(available);
  jest.mocked(captions.requestCaptionAsr).mockResolvedValue({ ...available, state: 'pending', canRevoke: true });
  jest.mocked(captions.revokeCaptionAsr).mockResolvedValue({ revoked: true, cleanupPending: false });
});

it('never auto-consents or enqueues and sends the original revision only after explicit consent', async () => {
  await render(<CaptionAsrSheet source={source} onClose={jest.fn()} onRevoked={jest.fn()} />);
  await screen.findByText('Transcription: not requested');
  await fireEvent.press(screen.getByLabelText('Request local caption draft'));
  expect(captions.requestCaptionAsr).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText("I have permission to transcribe this video's audio locally"));
  await fireEvent.press(screen.getByLabelText('Request local caption draft'));
  expect(captions.requestCaptionAsr).toHaveBeenCalledWith(source, '', true, available.consentEpoch);
  await screen.findByText(/Transcription: pending.*Review the generated draft/);
  expect(screen.getByRole('checkbox').props.accessibilityState.checked).toBe(false);
});

it('language changes reset consent and select only the advertised language list', async () => {
  await render(<CaptionAsrSheet source={source} onClose={jest.fn()} onRevoked={jest.fn()} />);
  await screen.findByText('Transcription: not requested');
  await fireEvent.press(screen.getByRole('checkbox'));
  await fireEvent.press(screen.getByLabelText('Transcription language: Detect language'));
  expect(screen.getByRole('checkbox').props.accessibilityState.checked).toBe(false);
  await fireEvent.press(screen.getByRole('checkbox'));
  await fireEvent.press(screen.getByLabelText('Request local caption draft'));
  expect(captions.requestCaptionAsr).toHaveBeenCalledWith(source, 'en', true, available.consentEpoch);
});

it('OFF/unavailable runtime refuses requests but permits confirmed revocation and reports pending erasure', async () => {
  jest.mocked(captions.getCaptionAsrStatus).mockResolvedValue({ ...available, enabled: false });
  jest.mocked(captions.revokeCaptionAsr).mockResolvedValue({ revoked: true, cleanupPending: true });
  const revoked = jest.fn();
  await render(<CaptionAsrSheet source={source} onClose={jest.fn()} onRevoked={revoked} />);
  await screen.findByText(/unavailable until its model/);
  await fireEvent.press(screen.getByRole('checkbox'));
  await fireEvent.press(screen.getByLabelText('Request local caption draft'));
  expect(captions.requestCaptionAsr).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('Stop transcription and delete drafts'));
  expect(captions.revokeCaptionAsr).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('Confirm stop transcription and delete drafts'));
  expect(captions.revokeCaptionAsr).toHaveBeenCalledWith(source);
  await screen.findByText(/Draft storage cleanup needs retry/);
  expect(revoked).toHaveBeenCalledTimes(1);
});

it('does not silently rebase an editor onto a newer caption revision', async () => {
  jest.mocked(captions.getCaptionAsrStatus).mockResolvedValue({ ...available, revisionKey: 'f'.repeat(64) });
  await render(<CaptionAsrSheet source={source} onClose={jest.fn()} onRevoked={jest.fn()} />);
  await screen.findByText(/The video or captions changed/);
  await fireEvent.press(screen.getByRole('checkbox'));
  await fireEvent.press(screen.getByLabelText('Request local caption draft'));
  expect(captions.requestCaptionAsr).not.toHaveBeenCalled();
});

it('clears consent after revoke and cannot re-request until a fresh status supplies a new epoch', async () => {
  let refresh!: (value: captions.CaptionAsrStatus) => void;
  jest.mocked(captions.getCaptionAsrStatus).mockResolvedValueOnce(available).mockImplementationOnce(() => new Promise((resolve) => { refresh = resolve; }));
  await render(<CaptionAsrSheet source={source} onClose={jest.fn()} onRevoked={jest.fn()} />);
  await screen.findByText('Transcription: not requested');
  await fireEvent.press(screen.getByRole('checkbox'));
  await fireEvent.press(screen.getByLabelText('Stop transcription and delete drafts'));
  await fireEvent.press(screen.getByLabelText('Confirm stop transcription and delete drafts'));
  await screen.findByText(/Consent revoked/);
  expect(screen.getByRole('checkbox').props.accessibilityState.checked).toBe(false);
  expect(screen.getByLabelText('Request local caption draft').props.accessibilityState.disabled).toBe(true);
  await waitFor(() => expect(captions.getCaptionAsrStatus).toHaveBeenCalledTimes(2));
  const refreshed = { ...available, consentEpoch: 'b'.repeat(64) };
  await act(async () => refresh(refreshed));
  await fireEvent.press(screen.getByLabelText('Request local caption draft'));
  expect(captions.requestCaptionAsr).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('checkbox'));
  await fireEvent.press(screen.getByLabelText('Request local caption draft'));
  expect(captions.requestCaptionAsr).toHaveBeenCalledWith(source, '', true, refreshed.consentEpoch);
});

it('a rejected stale request clears permission and cannot auto-retry with an old epoch', async () => {
  jest.mocked(captions.requestCaptionAsr).mockRejectedValue(new Error('Consent changed. Reopen to refresh.'));
  await render(<CaptionAsrSheet source={source} onClose={jest.fn()} onRevoked={jest.fn()} />);
  await screen.findByText('Transcription: not requested');
  await fireEvent.press(screen.getByRole('checkbox'));
  await fireEvent.press(screen.getByLabelText('Request local caption draft'));
  await screen.findByText(/Consent changed/);
  expect(screen.getByRole('checkbox').props.accessibilityState.checked).toBe(false);
  await fireEvent.press(screen.getByRole('checkbox'));
  await fireEvent.press(screen.getByLabelText('Request local caption draft'));
  expect(captions.requestCaptionAsr).toHaveBeenCalledTimes(1);
});

it('a late initial status cannot overwrite the fresh post-revocation epoch', async () => {
  let initial!: (value: captions.CaptionAsrStatus) => void;
  const refreshed = { ...available, consentEpoch: 'b'.repeat(64) };
  jest.mocked(captions.getCaptionAsrStatus).mockImplementationOnce(() => new Promise((resolve) => { initial = resolve; })).mockResolvedValueOnce(refreshed);
  await render(<CaptionAsrSheet source={source} onClose={jest.fn()} onRevoked={jest.fn()} />);
  await fireEvent.press(screen.getByLabelText('Stop transcription and delete drafts'));
  await fireEvent.press(screen.getByLabelText('Confirm stop transcription and delete drafts'));
  await screen.findByText(/Consent revoked/);
  await waitFor(() => expect(captions.getCaptionAsrStatus).toHaveBeenCalledTimes(2));
  await act(async () => initial(available));
  await fireEvent.press(screen.getByRole('checkbox'));
  await fireEvent.press(screen.getByLabelText('Request local caption draft'));
  expect(captions.requestCaptionAsr).toHaveBeenCalledWith(source, '', true, refreshed.consentEpoch);
});

it('failed status refresh after withdrawal never reuses the pre-revoke epoch', async () => {
  jest.mocked(captions.getCaptionAsrStatus).mockResolvedValueOnce(available).mockRejectedValueOnce(new Error('offline fixture'));
  await render(<CaptionAsrSheet source={source} onClose={jest.fn()} onRevoked={jest.fn()} />);
  await screen.findByText('Transcription: not requested');
  await fireEvent.press(screen.getByLabelText('Stop transcription and delete drafts'));
  await fireEvent.press(screen.getByLabelText('Confirm stop transcription and delete drafts'));
  await screen.findByText(/Reopen to refresh consent status/);
  await fireEvent.press(screen.getByRole('checkbox'));
  await fireEvent.press(screen.getByLabelText('Request local caption draft'));
  expect(captions.requestCaptionAsr).not.toHaveBeenCalled();
});

it('deduplicates in-flight taps and ignores request completion after unmount', async () => {
  let resolve!: (value: captions.CaptionAsrStatus) => void;
  jest.mocked(captions.requestCaptionAsr).mockReturnValue(new Promise((done) => { resolve = done; }));
  const mounted = await render(<CaptionAsrSheet source={source} onClose={jest.fn()} onRevoked={jest.fn()} />);
  await screen.findByText('Transcription: not requested');
  await fireEvent.press(screen.getByRole('checkbox'));
  await fireEvent.press(screen.getByLabelText('Request local caption draft'));
  await fireEvent.press(screen.getByLabelText('Request local caption draft'));
  await waitFor(() => expect(captions.requestCaptionAsr).toHaveBeenCalledTimes(1));
  await mounted.unmount();
  await act(async () => resolve({ ...available, state: 'pending' }));
});

it('does not carry consent or a late request response to another source generation', async () => {
  let resolve!: (value: captions.CaptionAsrStatus) => void;
  jest.mocked(captions.requestCaptionAsr).mockReturnValue(new Promise((done) => { resolve = done; }));
  const mounted = await render(<CaptionAsrSheet source={source} onClose={jest.fn()} onRevoked={jest.fn()} />);
  await screen.findByText('Transcription: not requested');
  await fireEvent.press(screen.getByRole('checkbox'));
  await fireEvent.press(screen.getByLabelText('Request local caption draft'));
  jest.mocked(captions.getCaptionAsrStatus).mockResolvedValue({ ...available, sourceVersion: 3 });
  await mounted.rerender(<CaptionAsrSheet source={{ ...source, version: 3 }} onClose={jest.fn()} onRevoked={jest.fn()} />);
  await screen.findByText('Transcription: not requested');
  expect(screen.getByRole('checkbox').props.accessibilityState.checked).toBe(false);
  await act(async () => resolve({ ...available, state: 'pending' }));
  expect(screen.queryByText(/Review the generated draft before publishing/)).toBeNull();
  expect(screen.queryByText(/The video or captions changed/)).toBeNull();
  await fireEvent.press(screen.getByLabelText('Request local caption draft'));
  expect(captions.requestCaptionAsr).toHaveBeenCalledTimes(1);
});
