import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { MediaDubbingManagement } from '../MediaDubbingManagement.tsx';
import * as service from '../../../services/media/dubbing.ts';

const ownerId = '11111111-1111-4111-8111-111111111111';
let mockActor: string | null = ownerId;
let mockAuthChanged: () => void;
let mockAppChanged: (state: string) => void;
const mockUnsubscribe = jest.fn();
jest.mock('../../../context/SessionContext.tsx', () => ({ ...jest.requireActual('../../../context/SessionContext.tsx'), useSession: () => ({ userId: mockActor, isAuthed: !!mockActor }) }));
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({ ...jest.requireActual('../../../context/FeatureFlagsContext.tsx'), useFeatureFlags: () => ({ isEnabled: () => false }) }));
jest.mock('../../../services/media/dubbing.ts', () => ({
  ...jest.requireActual('../../../services/media/dubbing.ts'),
  DUBBING_LABEL: 'AI-generated translated audio',
  getDubbingOptions: jest.fn(), revokeDubbing: jest.fn(), requestDubbing: jest.fn(), getDubbingConsent: jest.fn(), dubbingAudioSource: jest.fn(),
  subscribeDubbingAuth: (listener: () => void) => { mockAuthChanged = listener; return mockUnsubscribe; },
  DubbingRequestError: class extends Error { code: string; constructor(code: string) { super(code); this.code = code; } },
}));
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, { get(target, key) {
    if (key === 'AppState') return { currentState: 'active', addEventListener: (_event: string, listener: (state: string) => void) => { mockAppChanged = listener; return { remove: jest.fn() }; } };
    return Reflect.get(target, key);
  } });
});

const source = { assetId: '22222222-2222-4222-8222-222222222222', version: 4, canEdit: true };
const options: service.DubbingOptions = { assetId: source.assetId, sourceVersion: source.version, sourceKey: 'a'.repeat(64), canEdit: true, enabled: false, languages: [] };
const props = () => ({ source, userId: ownerId, open: true, onClose: jest.fn(), onWithdrawn: jest.fn() });
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(complete => { resolve = complete; });
  return { promise, resolve };
}
beforeEach(() => {
  jest.clearAllMocks(); mockActor = ownerId;
  jest.mocked(service.getDubbingOptions).mockResolvedValue(options);
  jest.mocked(service.revokeDubbing).mockResolvedValue(undefined);
});
afterEach(() => {
  jest.useRealTimers();
  expect(service.requestDubbing).not.toHaveBeenCalled();
  expect(service.getDubbingConsent).not.toHaveBeenCalled();
  expect(service.dubbingAudioSource).not.toHaveBeenCalled();
});

it('closed OFF management performs no metadata or withdrawal IO', async () => {
  await render(<MediaDubbingManagement {...props()} open={false} />);
  expect(service.getDubbingOptions).not.toHaveBeenCalled();
  expect(service.revokeDubbing).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Remove AI audio')).toBeNull();
});

it('explicit owner opening while OFF loads only metadata then withdraws on a separate action', async () => {
  const input = props();
  const mounted = await render(<MediaDubbingManagement {...input} open={false} />);
  await mounted.rerender(<MediaDubbingManagement {...input} />);
  await waitFor(() => expect(screen.getByLabelText('Remove AI audio').props.accessibilityState.disabled).toBe(false));
  expect(service.getDubbingOptions).toHaveBeenCalledTimes(1);
  expect(service.getDubbingOptions).toHaveBeenCalledWith({ assetId: source.assetId, userId: ownerId }, expect.anything());
  expect(service.revokeDubbing).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(screen.getByLabelText('Remove AI audio')); });
  expect(service.revokeDubbing).toHaveBeenCalledWith({ assetId: source.assetId, userId: ownerId }, expect.anything());
  expect(screen.getByText('AI audio permission withdrawn.')).toBeTruthy();
  expect(input.onWithdrawn).toHaveBeenCalledTimes(1);
  expect(service.getDubbingOptions).toHaveBeenCalledTimes(1);
});

it.each(['viewer', 'signed-out', 'other-account'])('refuses %s before any IO', async mode => {
  if (mode === 'signed-out') mockActor = null;
  if (mode === 'other-account') mockActor = '33333333-3333-4333-8333-333333333333';
  await render(<MediaDubbingManagement {...props()} source={{ ...source, canEdit: mode !== 'viewer' }} />);
  expect(service.getDubbingOptions).not.toHaveBeenCalled();
  expect(service.revokeDubbing).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Remove AI audio')).toBeNull();
});

it.each([
  { ...options, canEdit: false },
  { ...options, sourceVersion: source.version + 1 },
  { ...options, assetId: '33333333-3333-4333-8333-333333333333' },
])('requires current server-confirmed owner and exact generation: %j', async descriptor => {
  jest.mocked(service.getDubbingOptions).mockResolvedValueOnce(descriptor);
  await render(<MediaDubbingManagement {...props()} />);
  await waitFor(() => expect(screen.getByText('Owner permission could not be confirmed. Reopen the current video and try again.')).toBeTruthy());
  expect(screen.queryByLabelText('Remove AI audio')).toBeNull();
  expect(service.revokeDubbing).not.toHaveBeenCalled();
});

it('metadata errors require explicit retry, not a background loop or speculative withdrawal', async () => {
  jest.mocked(service.getDubbingOptions).mockRejectedValueOnce(new Error('offline'));
  await render(<MediaDubbingManagement {...props()} />);
  await waitFor(() => expect(screen.getByLabelText('Reload AI audio permissions')).toBeTruthy());
  expect(service.getDubbingOptions).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText('Remove AI audio')).toBeNull();
  await act(async () => { fireEvent.press(screen.getByLabelText('Reload AI audio permissions')); });
  expect(service.getDubbingOptions).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText('Remove AI audio').props.accessibilityState.disabled).toBe(false);
});

it('cleanup failure is not claimed complete and the owner can retry while OFF', async () => {
  const input = props();
  jest.mocked(service.revokeDubbing).mockRejectedValueOnce(new service.DubbingRequestError('cleanup_failed'));
  await render(<MediaDubbingManagement {...input} />);
  await act(async () => { fireEvent.press(screen.getByLabelText('Remove AI audio')); });
  expect(screen.getByText('Permission withdrawn. Audio cleanup needs another attempt.')).toBeTruthy();
  expect(input.onWithdrawn).toHaveBeenCalledTimes(1);
  await act(async () => { fireEvent.press(screen.getByLabelText('Retry audio cleanup')); });
  expect(service.revokeDubbing).toHaveBeenCalledTimes(2);
  expect(screen.getByText('AI audio permission withdrawn.')).toBeTruthy();
});

it('source change aborts and fences late metadata from the previous generation', async () => {
  const pending = deferred<service.DubbingOptions>();
  jest.mocked(service.getDubbingOptions).mockReturnValueOnce(pending.promise);
  jest.mocked(service.getDubbingOptions).mockRejectedValueOnce(new Error('new generation unavailable'));
  const input = props(); const mounted = await render(<MediaDubbingManagement {...input} />);
  const signal = jest.mocked(service.getDubbingOptions).mock.calls[0][1]!;
  await mounted.rerender(<MediaDubbingManagement {...input} source={{ ...source, version: 5 }} />);
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(options); });
  expect(screen.queryByLabelText('Remove AI audio')).toBeNull();
  expect(service.revokeDubbing).not.toHaveBeenCalled();
});

it('close and account changes abort in-flight metadata without reopening or withdrawing', async () => {
  const pending = deferred<service.DubbingOptions>();
  jest.mocked(service.getDubbingOptions).mockReturnValue(pending.promise);
  const input = props(); const mounted = await render(<MediaDubbingManagement {...input} />);
  const firstSignal = jest.mocked(service.getDubbingOptions).mock.calls[0][1]!;
  await mounted.rerender(<MediaDubbingManagement {...input} open={false} />);
  expect(firstSignal.aborted).toBe(true);
  await mounted.rerender(<MediaDubbingManagement {...input} />);
  const secondSignal = jest.mocked(service.getDubbingOptions).mock.calls[1][1]!;
  mockActor = '33333333-3333-4333-8333-333333333333';
  await mounted.rerender(<MediaDubbingManagement {...input} />);
  expect(secondSignal.aborted).toBe(true);
  await act(async () => { pending.resolve(options); });
  expect(screen.queryByLabelText('Remove AI audio')).toBeNull();
});

it('same-account auth changes and backgrounding invalidate permission without automatic refresh', async () => {
  await render(<MediaDubbingManagement {...props()} />);
  expect(screen.getByLabelText('Remove AI audio')).toBeTruthy();
  await act(async () => { mockAuthChanged(); });
  expect(screen.queryByLabelText('Remove AI audio')).toBeNull();
  expect(service.getDubbingOptions).toHaveBeenCalledTimes(1);
  await act(async () => { fireEvent.press(screen.getByLabelText('Reload AI audio permissions')); });
  expect(screen.getByLabelText('Remove AI audio')).toBeTruthy();
  await act(async () => { mockAppChanged('background'); mockAppChanged('active'); });
  expect(screen.queryByLabelText('Remove AI audio')).toBeNull();
  expect(service.getDubbingOptions).toHaveBeenCalledTimes(2);
});

it('bounds metadata waits and ignores late success after the deadline', async () => {
  jest.useFakeTimers();
  const pending = deferred<service.DubbingOptions>();
  jest.mocked(service.getDubbingOptions).mockReturnValueOnce(pending.promise);
  await render(<MediaDubbingManagement {...props()} />);
  const signal = jest.mocked(service.getDubbingOptions).mock.calls[0][1]!;
  await act(async () => { jest.advanceTimersByTime(15_000); });
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(options); });
  expect(screen.queryByLabelText('Remove AI audio')).toBeNull();
  expect(screen.getByLabelText('Reload AI audio permissions')).toBeTruthy();
});

it('duplicate withdrawal is blocked and closing fences late success callbacks', async () => {
  const pending = deferred<void>();
  jest.mocked(service.revokeDubbing).mockReturnValueOnce(pending.promise);
  const input = props(); const mounted = await render(<MediaDubbingManagement {...input} />);
  await act(async () => { fireEvent.press(screen.getByLabelText('Remove AI audio')); fireEvent.press(screen.getByLabelText('Remove AI audio')); });
  expect(service.revokeDubbing).toHaveBeenCalledTimes(1);
  const signal = jest.mocked(service.revokeDubbing).mock.calls[0][1]!;
  await mounted.rerender(<MediaDubbingManagement {...input} open={false} />);
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(undefined); });
  expect(input.onWithdrawn).not.toHaveBeenCalled();
  expect(mockUnsubscribe).toHaveBeenCalled();
});

it('unconfirmed withdrawal never claims success and requires fresh permission before retry', async () => {
  const input = props();
  jest.mocked(service.revokeDubbing).mockRejectedValueOnce(new service.DubbingRequestError('unavailable'));
  await render(<MediaDubbingManagement {...input} />);
  await act(async () => { fireEvent.press(screen.getByLabelText('Remove AI audio')); });
  expect(screen.getByText('Withdrawal not confirmed. Reload permission and try again.')).toBeTruthy();
  expect(screen.queryByLabelText('Remove AI audio')).toBeNull();
  expect(input.onWithdrawn).not.toHaveBeenCalled();
  expect(service.getDubbingOptions).toHaveBeenCalledTimes(1);
  await act(async () => { fireEvent.press(screen.getByLabelText('Reload AI audio permissions')); });
  expect(service.getDubbingOptions).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText('Remove AI audio')).toBeTruthy();
});

it('withdrawal deadline reports uncertainty and ignores late completion', async () => {
  jest.useFakeTimers();
  const input = props(); const pending = deferred<void>();
  jest.mocked(service.revokeDubbing).mockReturnValueOnce(pending.promise);
  await render(<MediaDubbingManagement {...input} />);
  await act(async () => { fireEvent.press(screen.getByLabelText('Remove AI audio')); });
  const signal = jest.mocked(service.revokeDubbing).mock.calls[0][1]!;
  await act(async () => { jest.advanceTimersByTime(15_000); });
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(undefined); });
  expect(screen.getByText('Withdrawal not confirmed. Reload permission and try again.')).toBeTruthy();
  expect(input.onWithdrawn).not.toHaveBeenCalled();
  expect(service.getDubbingOptions).toHaveBeenCalledTimes(1);
});
