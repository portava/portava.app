/** The signed-in account gate keeps temporary deactivation and deletion distinct. */
import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

// NOTE: intentional stub — test the gate without mounting auth or backend clients.
const mockSession = { isAuthed: true, accountStatus: 'deactivated', accountStatusLoaded: true,
  reactivateUntil: null as string | null, selfRecoverableUntil: null as string | null,
  signOut: jest.fn(), refreshAccountStatus: jest.fn() };
jest.mock('../../context/SessionContext.tsx', () => ({ useSession: () => mockSession }));
// NOTE: intentional stub — real commands are proved by the mounted database suite.
const mockReactivate = jest.fn(), mockRecover = jest.fn();
jest.mock('../../services/profile.ts', () => ({ reactivateAccount: (...a: unknown[]) => mockReactivate(...a), cancelAccountDeletion: (...a: unknown[]) => mockRecover(...a) }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), SafeAreaView: jest.requireActual('react-native').View }));
import { AccountStatusGate } from '../AccountStatusGate.tsx';

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(mockSession, { isAuthed: true, accountStatus: 'deactivated', accountStatusLoaded: true,
    reactivateUntil: new Date(Date.now() + 86400000).toISOString(), selfRecoverableUntil: null });
  mockReactivate.mockResolvedValue({ ok: true, data: { reactivated: true } });
  mockRecover.mockResolvedValue({ ok: true, data: { cancelled: true, accountStatus: 'active' } });
});
afterEach(() => jest.useRealTimers());
const view = () => <AccountStatusGate><Text>Private app</Text></AccountStatusGate>;

it('explains one-year deactivation and requires an explicit action after signing in', async () => {
  await render(view());
  expect(screen.getByText(/personally deactivated account for one year/)).toBeTruthy();
  expect(screen.queryByText('Private app')).toBeNull(); expect(mockReactivate).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Reactivate my account' }));
  expect(mockReactivate).toHaveBeenCalledTimes(1); expect(mockRecover).not.toHaveBeenCalled();
  expect(mockSession.refreshAccountStatus).toHaveBeenCalledTimes(1);
});
it('uses the separate profile recovery command and 90-day policy for deletion', async () => {
  Object.assign(mockSession, { accountStatus: 'pending_deletion', reactivateUntil: null, selfRecoverableUntil: new Date(Date.now() + 86400000).toISOString() });
  await render(view()); expect(screen.getByText(/recover it for 90 days/)).toBeTruthy();
  expect(screen.queryByText(/scheduled to be permanently deleted/)).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Recover my profile' }));
  expect(mockRecover).toHaveBeenCalledTimes(1); expect(mockReactivate).not.toHaveBeenCalled();
});
it.each(['deactivated', 'pending_deletion'])('blocks expired %s self-service without claiming automatic deletion', async (status) => {
  Object.assign(mockSession, { accountStatus: status, reactivateUntil: new Date(Date.now() - 1000).toISOString(), selfRecoverableUntil: new Date(Date.now() - 1000).toISOString() });
  await render(view()); expect(screen.getByText(/not automatically permanently deleted/)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: status === 'deactivated' ? 'Reactivate my account' : 'Recover my profile' }));
  expect(mockRecover).not.toHaveBeenCalled(); expect(mockReactivate).not.toHaveBeenCalled();
});
it('does not present unknown or in-progress recovery as available', async () => {
  mockSession.reactivateUntil = null;
  await render(view()); expect(screen.getByText(/Self-service recovery is unavailable/)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Reactivate my account' })); expect(mockReactivate).not.toHaveBeenCalled();
});
it('keeps the account hidden when the server refuses reactivation', async () => {
  mockReactivate.mockResolvedValue({ ok: false, message: 'Independent suspension is still active.' });
  await render(view()); await fireEvent.press(screen.getByRole('button', { name: 'Reactivate my account' }));
  expect(screen.getByText('Independent suspension is still active.')).toBeTruthy();
  expect(mockSession.refreshAccountStatus).not.toHaveBeenCalled(); expect(screen.queryByText('Private app')).toBeNull();
});
it('expires an open screen when its deadline passes', async () => {
  jest.useFakeTimers(); mockSession.reactivateUntil = new Date(Date.now() + 1000).toISOString();
  await render(view());
  await act(async () => { jest.advanceTimersByTime(1001); });
  expect(screen.getByText(/self-service recovery period has ended/)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Reactivate my account' })); expect(mockReactivate).not.toHaveBeenCalled();
});
