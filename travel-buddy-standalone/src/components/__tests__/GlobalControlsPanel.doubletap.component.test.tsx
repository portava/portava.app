/**
 * GlobalControlsPanel — duplicate-save guard tests.
 *
 * The Switch-based global-control toggles confirm via Alert.alert before
 * PATCHing /api/admin/rent-buddy/global-controls.  Before this guard was
 * added, a fast second flip (or two stacked alert confirms) would fire
 * overlapping PATCHes that race each other.
 *
 * ## What's covered
 *
 * 1. Two rapid Alert confirms while the first PATCH is still in flight
 *    produce exactly one PATCH — not two.
 * 2. Flipping a switch while a save is in flight is ignored (toggle returns
 *    immediately when savingRef is set).
 *
 * ## How Alert interactions are tested
 *
 * Alert.alert is mocked via jest.spyOn.  The spy captures the button array
 * and pressAlertButton finds the right button by label and calls its onPress
 * directly — the same pattern used in FailedJobsScreen.component.test.tsx.
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, act, waitFor, screen, fireEvent } from '@testing-library/react-native';
import AdminRolloutDashboard from '../../../app/(rent-a-buddy)/admin/rollout.tsx';

// ── Module mocks ───────────────────────────────────────────────────────────────

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), canGoBack: () => true },
}));

// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../hooks/useRequireAdmin', () => ({
  ...jest.requireActual('../../hooks/useRequireAdmin'),
  useRequireAdmin: jest.fn(),
}));

jest.mock('../../lib/supabase', () => ({
  ...jest.requireActual('../../lib/supabase'),
  supabase: {
    auth: { getSession: jest.fn(async () => ({ data: { session: { access_token: 'tok' } } })) },
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

const CONTROLS_RESPONSE = {
  controls: {
    all_bookings_paused: false,
    applications_paused: false,
    cash_balance_paused: false,
    nightlife_paused: false,
    force_full_in_app: false,
    force_public_meetup: false,
    force_delayed_posting: false,
  },
};

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as any;
}

/** Invoke the first Alert button whose `text` matches `label`. */
async function pressAlertButton(alertSpy: jest.SpyInstance, label: string) {
  const calls = alertSpy.mock.calls;
  if (calls.length === 0) throw new Error('Alert.alert was never called');
  const lastCall = calls[calls.length - 1];
  const buttons: Array<{ text: string; onPress?: () => void }> = lastCall[2] ?? [];
  const btn = buttons.find(b => b.text === label);
  if (!btn) throw new Error(`No Alert button labelled "${label}" — found: ${buttons.map(b => b.text).join(', ')}`);
  btn.onPress?.();
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('GlobalControlsPanel duplicate-save guard', () => {
  let fetchMock: jest.Mock;
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.fn();
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      // Simulate a slow PATCH so the in-flight window is observable.
      if (opts?.method === 'PATCH') {
        await new Promise(r => setTimeout(r, 20));
        return jsonResponse({});
      }
      if (String(url).includes('/global-controls')) return jsonResponse(CONTROLS_RESPONSE);
      if (String(url).includes('/rollout/cities'))  return jsonResponse({ cities: [] });
      if (String(url).includes('/beta-access'))     return jsonResponse({ betaAccess: [] });
      if (String(url).includes('/qa/checklists'))   return jsonResponse({ checklists: [] });
      if (String(url).includes('/audit-log'))       return jsonResponse({ logs: [] });
      return jsonResponse({});
    });
    global.fetch = fetchMock as any;

    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('two rapid Alert confirms produce exactly one PATCH', async () => {
    await act(async () => { render(<AdminRolloutDashboard />); });

    // Switch to the Controls tab.
    await act(async () => { fireEvent.press(screen.getByText('Controls')); });
    await waitFor(() => expect(screen.getByText('Pause ALL bookings')).toBeTruthy());

    // Flip the first switch → Alert opens.
    await act(async () => {
      fireEvent(screen.getAllByRole('switch')[0], 'valueChange', true);
    });
    expect(alertSpy).toHaveBeenCalled();

    // Fire both confirms in the same synchronous frame so the guard fires before
    // act() can drain the in-flight timer.  Wrapping either call in await act()
    // would flush the 20 ms PATCH timer between the two confirms, resetting
    // savingRef.current to false and letting the second PATCH through.
    pressAlertButton(alertSpy, 'Confirm'); // starts PATCH; savingRef.current = true
    pressAlertButton(alertSpy, 'Confirm'); // guard fires → returns early

    // Flush React state + let the in-flight PATCH settle.
    await act(async () => { await new Promise(r => setTimeout(r, 40)); });

    const patches = fetchMock.mock.calls.filter(
      ([, opts]: [string, RequestInit]) => opts?.method === 'PATCH',
    );
    expect(patches.length).toBe(1);
  });

  it('flipping a switch while saving is in flight is ignored', async () => {
    await act(async () => { render(<AdminRolloutDashboard />); });

    await act(async () => { fireEvent.press(screen.getByText('Controls')); });
    await waitFor(() => expect(screen.getByText('Pause ALL bookings')).toBeTruthy());

    // First flip → Alert opens → confirm → PATCH starts.
    await act(async () => {
      fireEvent(screen.getAllByRole('switch')[0], 'valueChange', true);
    });
    pressAlertButton(alertSpy, 'Confirm');

    // Second flip while the PATCH is in flight — toggle() should return early.
    const callsBefore = alertSpy.mock.calls.length;
    await act(async () => {
      fireEvent(screen.getAllByRole('switch')[0], 'valueChange', false);
    });
    // No new Alert should have been opened.
    expect(alertSpy.mock.calls.length).toBe(callsBefore);

    // Let the first PATCH settle.
    await act(async () => { await new Promise(r => setTimeout(r, 40)); });

    const patches = fetchMock.mock.calls.filter(
      ([, opts]: [string, RequestInit]) => opts?.method === 'PATCH',
    );
    expect(patches.length).toBe(1);
  });
});
