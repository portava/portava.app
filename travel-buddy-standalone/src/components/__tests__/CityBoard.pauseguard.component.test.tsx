/**
 * CityBoard — pause duplicate-POST guard tests.
 *
 * CityBoard.pause() shows an Alert confirmation before POSTing to
 * /api/admin/rent-buddy/rollout/cities/:id/pause.  Without an in-flight guard,
 * a fast double-confirm (or two stacked Alert callbacks) fires two overlapping
 * POST requests.  The pausingRef guard prevents this.
 *
 * ## What's covered
 *
 * 1. Two rapid Alert confirms while the first POST is still in flight produce
 *    exactly one POST — not two.
 *
 * ## How Alert interactions are tested
 *
 * Alert.alert is mocked via jest.spyOn.  pressAlertButton finds the button by
 * label and calls its onPress directly — the same pattern used in
 * GlobalControlsPanel.doubletap.component.test.tsx.
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

const CITIES_RESPONSE = {
  cities: [{ id: 'city-1', city: 'TestCity', country: 'TC', status: 'public_mvp' }],
};

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as any;
}

/** Invoke the Alert button whose `text` matches `label` (uses the last call). */
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

describe('CityBoard pause duplicate-POST guard', () => {
  let fetchMock: jest.Mock;
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.fn();
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      // Simulate a slow pause POST so the in-flight window is observable.
      if (opts?.method === 'POST' && String(url).includes('/pause')) {
        await new Promise(r => setTimeout(r, 20));
        return jsonResponse({});
      }
      if (String(url).includes('/rollout/cities'))  return jsonResponse(CITIES_RESPONSE);
      if (String(url).includes('/global-controls')) return jsonResponse({ controls: {} });
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

  it('two rapid pause Alert confirms produce exactly one POST', async () => {
    await act(async () => { render(<AdminRolloutDashboard />); });

    // Cities tab is the default — expand the city card to reveal the Pause button.
    await waitFor(() => expect(screen.getByText('TestCity')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByText('TestCity')); });
    await waitFor(() => expect(screen.getByText('Pause')).toBeTruthy());

    // Press Pause → Alert opens.
    await act(async () => { fireEvent.press(screen.getByText('Pause')); });
    expect(alertSpy).toHaveBeenCalled();

    // Confirm once — starts the POST (which takes 20 ms).
    await act(async () => { await pressAlertButton(alertSpy, 'Pause'); });

    // Immediately confirm again (simulating a stacked alert or a second tap).
    await act(async () => { await pressAlertButton(alertSpy, 'Pause'); });

    // Wait for the POST to settle.
    await act(async () => { await new Promise(r => setTimeout(r, 40)); });

    const pausePosts = fetchMock.mock.calls.filter(
      ([url, opts]: [string, RequestInit]) =>
        opts?.method === 'POST' && String(url).includes('/pause'),
    );
    expect(pausePosts.length).toBe(1);
  });
});
