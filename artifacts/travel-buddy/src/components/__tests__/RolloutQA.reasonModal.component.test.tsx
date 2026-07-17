/**
 * Rollout dashboard QA panel — cross-platform failure-reason modal test.
 *
 * "Mark Failed" used iOS-only Alert.prompt (a silent no-op on Android/web).
 * It now uses ReasonPromptModal; the reason is required. This test pins
 * that the modal opens, requires a reason, and posts it to mark-failed.
 */
import React from 'react';
import { render, act, waitFor, screen, fireEvent } from '@testing-library/react-native';
import AdminRolloutDashboard from '../../../app/(rent-a-buddy)/admin/rollout.tsx';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), canGoBack: () => true },
}));
// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../hooks/useRequireAdmin', () => ({ ...jest.requireActual('../../hooks/useRequireAdmin'), useRequireAdmin: jest.fn() }));
jest.mock('../../lib/supabase', () => ({
  ...jest.requireActual('../../lib/supabase'),
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: { access_token: 'tok' } } })) } },
}));

const checklist = {
  id: 'cl-1',
  city_rollout_id: 'city-12345678',
  checklist_status: 'in_progress',
};

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as any;
}

describe('Rollout QA reason modal', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/qa/checklists') && !url.includes('mark-failed')) {
        return jsonResponse({ checklists: [checklist] });
      }
      if (url.includes('/rollout/cities')) return jsonResponse({ cities: [] });
      return jsonResponse({});
    });
    global.fetch = fetchMock as any;
  });

  it('marks a checklist failed via the modal with a required reason', async () => {
    await act(async () => { render(<AdminRolloutDashboard />); });

    // Switch to QA tab
    await act(async () => { fireEvent.press(screen.getByText('QA')); });
    await waitFor(() => expect(screen.getByText('Mark Failed')).toBeTruthy());

    expect(screen.queryByTestId('reason-modal')).toBeNull();
    await act(async () => { fireEvent.press(screen.getByText('Mark Failed')); });
    expect(screen.getByTestId('reason-modal')).toBeTruthy();

    // Reason required — confirm disabled with no text
    await act(async () => { fireEvent.press(screen.getByTestId('reason-confirm-btn')); });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('mark-failed'))).toBe(false);

    await act(async () => { fireEvent.changeText(screen.getByTestId('reason-input'), 'payment flow broken'); });
    await act(async () => { fireEvent.press(screen.getByTestId('reason-confirm-btn')); });

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/qa/checklists/cl-1/mark-failed'));
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as any).body)).toEqual({ reason: 'payment flow broken' });
    });
  });

  it('double-tapping the modal confirm posts mark-failed exactly once', async () => {
    await act(async () => { render(<AdminRolloutDashboard />); });

    await act(async () => { fireEvent.press(screen.getByText('QA')); });
    await waitFor(() => expect(screen.getByText('Mark Failed')).toBeTruthy());

    await act(async () => { fireEvent.press(screen.getByText('Mark Failed')); });
    await act(async () => { fireEvent.changeText(screen.getByTestId('reason-input'), 'safety flow broken'); });

    // Fast double-tap before the modal closes.
    await act(async () => {
      const btn = screen.getByTestId('reason-confirm-btn');
      fireEvent.press(btn);
      fireEvent.press(btn);
    });

    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('mark-failed')).length).toBe(1));
  });
});
