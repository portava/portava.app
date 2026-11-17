/** Admin recovery and explicit irreversible deletion through canonical commands. */
import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentional stub — expo-router's real module needs a navigator.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

jest.mock('../../../src/hooks/useRequireAdmin', () => ({
  ...jest.requireActual('../../../src/hooks/useRequireAdmin'),
  useRequireAdmin: jest.fn(),
}));

jest.mock('../../../src/context/SessionContext', () => ({
  ...jest.requireActual('../../../src/context/SessionContext'),
  useSession: () => ({ isAuthed: true, loading: false }),
}));

let mockWorkerOn = false;
// NOTE: intentional stub — the real provider fetches flags from the server.
jest.mock('../../../src/context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (k: string) => k === 'account_deletion_worker_enabled' && mockWorkerOn }),
}));

jest.mock('../../../src/services/adminConsole', () => ({
  ...jest.requireActual('../../../src/services/adminConsole'),
  listDeletionRequests: jest.fn(),
  executeDeletionRequest: jest.fn(),
  recoverDeletionRequest: jest.fn(),
  reconcileDeletionRequest: jest.fn(),
}));

import * as svc from '../../../src/services/adminConsole';
import AdminDeletionRequestsScreen from '../deletion-requests';

const m = svc as jest.Mocked<typeof svc>;

const REQ = {
  id: 'u-del', user_id: 'u-del', status: 'pending',
  requested_at: '2026-10-01T00:00:00Z', scheduled_at: null,
  recovery_generation: '11111111-1111-4111-8111-111111111111', recovery_verified: true, execution_started_at: null,
};

let alertSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  mockWorkerOn = false;
  // Press the destructive button of whatever confirm is shown.
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
    buttons?.find((b) => b.style === 'destructive')?.onPress?.();
  });
});
afterEach(() => alertSpy.mockRestore());

describe('Account deletions', () => {
  it('a failed read is an error, not "no accounts waiting"', async () => {
    m.listDeletionRequests.mockResolvedValue({ ok: false, error: 'HTTP 503' });
    await render(<AdminDeletionRequestsScreen />);
    await screen.findByTestId('deletions-error');
    expect(screen.queryByTestId('deletions-empty')).toBeNull();
  });

  it('states the owner and admin recovery rules even if the old worker flag is on', async () => {
    mockWorkerOn = true;
    m.listDeletionRequests.mockResolvedValue({ ok: true, data: [] });
    await render(<AdminDeletionRequestsScreen />); await screen.findByTestId('deletions-empty');
    expect(screen.getByText(/Users can recover their own profiles for 90 days/)).toBeTruthy();
    expect(screen.queryByText(/Automatic deletion is ON/)).toBeNull();
  });

  it('requires a reason, restores the selected generation, and removes the row only after success', async () => {
    m.listDeletionRequests.mockResolvedValue({ ok: true, data: [REQ] });
    m.recoverDeletionRequest.mockResolvedValue({ ok: true, data: { recovered: true, accountStatus: 'active' } });
    await render(<AdminDeletionRequestsScreen />);
    const recover = await screen.findByTestId('deletion-recover-u-del');
    await fireEvent.press(recover); expect(m.recoverDeletionRequest).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByTestId('deletion-reason-u-del'), 'Owner requested recovery');
    await fireEvent.press(recover); await screen.findByTestId('deletion-recovered');
    expect(m.recoverDeletionRequest).toHaveBeenCalledWith('u-del', REQ.recovery_generation, 'Owner requested recovery');
    expect(screen.queryByTestId('deletion-u-del')).toBeNull(); expect(m.executeDeletionRequest).not.toHaveBeenCalled();
  });

  it('failed recovery retains the row and explains the refusal', async () => {
    m.listDeletionRequests.mockResolvedValue({ ok: true, data: [REQ] });
    m.recoverDeletionRequest.mockResolvedValue({ ok: false, error: 'Permanent deletion has started' });
    await render(<AdminDeletionRequestsScreen />);
    await fireEvent.changeText(await screen.findByTestId('deletion-reason-u-del'), 'Owner requested recovery');
    await fireEvent.press(screen.getByTestId('deletion-recover-u-del'));
    await screen.findByText(/Action not completed: Permanent deletion has started/); expect(screen.getByTestId('deletion-u-del')).toBeTruthy();
  });

  it('an executing or unverified deletion cannot be presented as recoverable', async () => {
    for (const row of [{ ...REQ, status: 'executing', execution_started_at: '2026-11-16T12:00:00Z' }, { ...REQ, recovery_verified: false }]) {
      m.listDeletionRequests.mockResolvedValue({ ok: true, data: [row] });
      const view = await render(<AdminDeletionRequestsScreen />);
      await fireEvent.changeText(await screen.findByTestId('deletion-reason-u-del'), 'Review recovery');
      await fireEvent.press(screen.getByTestId('deletion-recover-u-del')); expect(m.recoverDeletionRequest).not.toHaveBeenCalled();
      await view.unmount();
    }
  });

  it('runs a due request only through the confirm, shows every step, and drops the row', async () => {
    m.listDeletionRequests.mockResolvedValue({ ok: true, data: [REQ] });
    m.executeDeletionRequest.mockResolvedValue({
      ok: true,
      data: {
        ok: true, userId: 'u-del', steps: [
          { step: 'posts', ok: true, count: 3 },
          { step: 'auth_user', ok: true },
        ], warnings: [],
      },
    });
    await render(<AdminDeletionRequestsScreen />);
    expect(await screen.findByText(/Recoverable by an admin/)).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('deletion-reason-u-del'), 'Approved permanent deletion');
    await fireEvent.press(screen.getByTestId('deletion-run-u-del'));
    expect(alertSpy).toHaveBeenCalledTimes(1);
    await screen.findByTestId('deletion-result');
    expect(m.executeDeletionRequest).toHaveBeenCalledWith('u-del', REQ.recovery_generation, 'Approved permanent deletion');
    expect(screen.getByText('Permanent deletion verified.')).toBeTruthy();
    expect(screen.getByTestId('deletion-step-posts')).toBeTruthy();
    expect(screen.getByTestId('deletion-step-auth_user')).toBeTruthy();
    expect(screen.queryByTestId('deletion-u-del')).toBeNull();
  });

  it('cancelling the confirm deletes nothing', async () => {
    alertSpy.mockImplementation(() => {});
    m.listDeletionRequests.mockResolvedValue({ ok: true, data: [REQ] });
    await render(<AdminDeletionRequestsScreen />);
    await fireEvent.changeText(await screen.findByTestId('deletion-reason-u-del'), 'Approved permanent deletion');
    await fireEvent.press(screen.getByTestId('deletion-run-u-del'));
    expect(m.executeDeletionRequest).not.toHaveBeenCalled();
    expect(screen.getByTestId('deletion-u-del')).toBeTruthy();
  });

  it('a failed run keeps the row and says why', async () => {
    m.listDeletionRequests.mockResolvedValue({ ok: true, data: [REQ] });
    m.executeDeletionRequest.mockResolvedValue({ ok: false, error: 'Account deletion did not complete — auth_user: not found' });
    await render(<AdminDeletionRequestsScreen />);
    await fireEvent.changeText(await screen.findByTestId('deletion-reason-u-del'), 'Approved permanent deletion');
    await fireEvent.press(screen.getByTestId('deletion-run-u-del'));
    await screen.findByText(/Action not completed: Account deletion did not complete/);
    expect(screen.getByTestId('deletion-u-del')).toBeTruthy();
  });
  it('checks a stable receipt after the user FK disappeared without dispatching another erase', async () => {
    const row = { ...REQ, id: 'receipt-1', deletion_request_id: 'receipt-1', user_id: null, status: 'executing', can_reconcile: true };
    m.listDeletionRequests.mockResolvedValue({ ok: true, data: [row] });
    m.reconcileDeletionRequest.mockResolvedValue({ ok: true, data: { completed: true } });
    await render(<AdminDeletionRequestsScreen />);
    const check = await screen.findByTestId('deletion-reconcile-receipt-1');
    await fireEvent.press(check); expect(m.reconcileDeletionRequest).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByTestId('deletion-reason-receipt-1'),'Verify interrupted result');
    await fireEvent.press(screen.getByTestId('deletion-run-receipt-1')); await fireEvent.press(screen.getByTestId('deletion-recover-receipt-1'));
    await fireEvent.press(check); await screen.findByText('Permanent deletion was verified.');
    expect(m.reconcileDeletionRequest).toHaveBeenCalledWith('receipt-1',REQ.recovery_generation,'Verify interrupted result');
    expect(m.executeDeletionRequest).not.toHaveBeenCalled(); expect(m.recoverDeletionRequest).not.toHaveBeenCalled();
    expect(screen.queryByTestId('deletion-receipt-1')).toBeNull(); expect(alertSpy).not.toHaveBeenCalled();
  });
  it('retains an unsettled receipt and does not offer another deletion', async () => {
    const row = { ...REQ, id: 'receipt-2', deletion_request_id: 'receipt-2', user_id: null, status: 'executing', can_reconcile: true };
    m.listDeletionRequests.mockResolvedValue({ ok: true, data: [row] });
    m.reconcileDeletionRequest.mockResolvedValue({ ok: false, error: 'Auth result remains unknown' });
    await render(<AdminDeletionRequestsScreen />);
    await fireEvent.changeText(await screen.findByTestId('deletion-reason-receipt-2'),'Verify result');
    await fireEvent.press(screen.getByTestId('deletion-reconcile-receipt-2'));
    await screen.findByText('Action not completed: Auth result remains unknown');
    expect(screen.getByTestId('deletion-receipt-2')).toBeTruthy(); expect(m.executeDeletionRequest).not.toHaveBeenCalled();
  });

});
