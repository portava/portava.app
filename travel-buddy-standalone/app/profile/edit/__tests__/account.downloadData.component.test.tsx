/**
 * Settings → Account — "Download your data".
 *
 *   A1  the row is there for a signed-in person, and pressing it downloads;
 *   A2  a failed download says why, in words a person can act on;
 *   A3  a second press while one is running does not start another.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — the screen only calls router.replace on log out.
jest.mock('expo-router', () => ({ router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() } }));

// NOTE: intentionally exhaustive — the screen reads the session email once.
jest.mock('../../../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: () => Promise.resolve({ data: { session: { user: { email: 'mira@example.com' } } } }) } },
}));

// NOTE: intentionally exhaustive — a signed-in, configured session.
jest.mock('../../../../src/context/SessionContext', () => ({
  useSession: () => ({ signOut: jest.fn(), isAuthed: true, configured: true }),
}));

// NOTE: intentionally exhaustive — the account flows the screen imports; only the status read runs on mount.
jest.mock('../../../../src/services/profile', () => ({
  getAccountStatus: () => Promise.resolve({ ok: true, data: { accountStatus: 'active' } }),
  deactivateAccount: jest.fn(),
  reactivateAccount: jest.fn(),
  requestAccountDeletion: jest.fn(),
}));

const mockDownload = jest.fn();
// NOTE: intentionally exhaustive — the download itself is covered by
// src/services/__tests__/dataExport.component.test.ts; the real message map is kept.
jest.mock('../../../../src/services/dataExport', () => ({
  downloadMyData: (...a: unknown[]) => mockDownload(...a),
  dataExportErrorMessage: jest.requireActual('../../../../src/services/dataExport').dataExportErrorMessage,
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — useBottomInset imports native inset hooks
// that are unavailable in jest-expo JSDOM; only PlainBottomFiller is used by SettingsUI.
jest.mock('../../../../src/hooks/useBottomInset', () => ({
  PlainBottomFiller: () => null,
  useBottomInset: () => 0,
  useLayoverAwareBottomInset: () => 0,
}));

import AccountScreen from '../account';

let alertSpy: jest.SpyInstance;
beforeEach(() => {
  mockDownload.mockReset();
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => { alertSpy.mockRestore(); });

describe('Account — Download your data', () => {
  it('A1 the row is there and pressing it downloads, with no alert on success', async () => {
    mockDownload.mockResolvedValue({ ok: true, sections: 39, complete: true });
    await render(<AccountScreen />);
    const row = await screen.findByTestId('account-download-data');
    expect(screen.getByText('Download your data')).toBeTruthy();
    await act(async () => { fireEvent.press(row); });
    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('A2 a failed download says why', async () => {
    mockDownload.mockResolvedValue({ ok: false, error: 'rate_limited' });
    await render(<AccountScreen />);
    await act(async () => { fireEvent.press(await screen.findByTestId('account-download-data')); });
    expect(alertSpy).toHaveBeenCalledWith('Could not download your data', expect.stringMatching(/a few times this hour/));
  });

  it('A3 a second press while one is running does not start another', async () => {
    let finish: (v: unknown) => void = () => {};
    mockDownload.mockReturnValue(new Promise((r) => { finish = r; }));
    await render(<AccountScreen />);
    const row = await screen.findByTestId('account-download-data');
    await act(async () => { fireEvent.press(row); });
    await act(async () => { fireEvent.press(screen.getByTestId('account-download-data')); });
    expect(mockDownload).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ ok: true, sections: 39, complete: true }); });
  });
});
