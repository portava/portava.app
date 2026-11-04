/**
 * Admin — Account deletions: the screen that runs one real deletion through the
 * admin route before the scheduled worker is switched on (migration 2073).
 *
 * Run with: pnpm test:component
 *
 * Pinned: a failed read is an error, not "nobody is waiting"; nothing is
 * deleted without the confirm; a run shows every step the cascade reported and
 * the row leaves only on success; a refusal stays on the row; the worker's
 * flag state is said in words.
 */
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
}));

import * as svc from '../../../src/services/adminConsole';
import AdminDeletionRequestsScreen from '../deletion-requests';

const m = svc as jest.Mocked<typeof svc>;

const REQ = {
  id: 'u-del', user_id: 'u-del', status: 'pending',
  requested_at: '2026-10-01T00:00:00Z', scheduled_at: '2026-10-31T00:00:00Z',
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

  it('says the worker is off and how to turn it on safely', async () => {
    m.listDeletionRequests.mockResolvedValue({ ok: true, data: [] });
    await render(<AdminDeletionRequestsScreen />);
    await screen.findByTestId('deletions-empty');
    expect(screen.getByText(/Automatic deletion is OFF/)).toBeTruthy();
    expect(screen.getByText(/Run one request here first/)).toBeTruthy();
  });

  it('says when the worker is on', async () => {
    mockWorkerOn = true;
    m.listDeletionRequests.mockResolvedValue({ ok: true, data: [] });
    await render(<AdminDeletionRequestsScreen />);
    await screen.findByTestId('deletions-empty');
    expect(screen.getByText(/Automatic deletion is ON/)).toBeTruthy();
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
    expect(await screen.findByText(/Due now/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('deletion-run-u-del'));
    expect(alertSpy).toHaveBeenCalledTimes(1);
    await screen.findByTestId('deletion-result');
    expect(m.executeDeletionRequest).toHaveBeenCalledWith('u-del');
    expect(screen.getByText('Deleted. Every step finished.')).toBeTruthy();
    expect(screen.getByTestId('deletion-step-posts')).toBeTruthy();
    expect(screen.getByTestId('deletion-step-auth_user')).toBeTruthy();
    expect(screen.queryByTestId('deletion-u-del')).toBeNull();
  });

  it('cancelling the confirm deletes nothing', async () => {
    alertSpy.mockImplementation(() => {});
    m.listDeletionRequests.mockResolvedValue({ ok: true, data: [REQ] });
    await render(<AdminDeletionRequestsScreen />);
    await fireEvent.press(await screen.findByTestId('deletion-run-u-del'));
    expect(m.executeDeletionRequest).not.toHaveBeenCalled();
    expect(screen.getByTestId('deletion-u-del')).toBeTruthy();
  });

  it('a failed run keeps the row and says why', async () => {
    m.listDeletionRequests.mockResolvedValue({ ok: true, data: [REQ] });
    m.executeDeletionRequest.mockResolvedValue({ ok: false, error: 'Account deletion did not complete — auth_user: not found' });
    await render(<AdminDeletionRequestsScreen />);
    await fireEvent.press(await screen.findByTestId('deletion-run-u-del'));
    await screen.findByText(/Not deleted: Account deletion did not complete/);
    expect(screen.getByTestId('deletion-u-del')).toBeTruthy();
  });
});
