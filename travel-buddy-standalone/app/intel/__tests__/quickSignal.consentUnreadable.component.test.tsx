/**
 * Quick Signal — an UNREADABLE consent is not "never consented".
 *
 * THE DEFECT. The screen read consent through getIntelConsent, which folds a
 * 500, a dropped connection and a malformed body into `null`, and hasValidConsent
 * reads `null` as "not granted". So a person who HAD turned on Intelligence
 * Contributions was shown the first-use consent gate whenever the read failed —
 * and, with no disclosure version in hand, the gate told them to update the app.
 * The server names this exact harm (routes/intel.ts GET /v1/intel/consent): a
 * toggle shown over an unreadable row re-stamps a consent already given.
 *
 * What these cases pin: an unreadable read renders its OWN state (no gate, no
 * prompts), Retry re-reads, and a read that succeeds renders exactly as before
 * — the gate for a person who has not consented, the prompts for one who has.
 * CONTROLLED evidence: the consent service is a double; no network.
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — expo-router's real module needs a navigator.
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({ subjectId: '11111111-1111-4111-8111-111111111111', subjectName: 'Cafe Giang' }),
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// NOTE: intentionally exhaustive — the native haptics module is absent under jest.
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Error: 'error', Warning: 'warning' },
}));
// NOTE: intentional stub — flags, Safe Return and pauses are not under test here.
jest.mock('../../../src/hooks/useIntelPrompts', () => ({
  useIntelPrompts: () => ({ captureEnabled: true, safeReturnActive: false, trailEnabled: false }),
}));
// NOTE: intentional stub — the device position is not under test here.
jest.mock('../../../src/services/location', () => ({
  getCurrentGps: jest.fn().mockResolvedValue({ granted: false, lat: null, lng: null }),
}));
// NOTE: intentionally exhaustive — the real service does an authed fetch with a
// native token store; these cases assert only what the screen does with answers.
jest.mock('../../../src/services/intelCapture', () => ({
  submitQuickSignal: jest.fn().mockResolvedValue({ ok: true }),
  submitWalkIn: jest.fn().mockResolvedValue({ ok: true }),
  submitMusic: jest.fn().mockResolvedValue({ ok: true }),
  makeIdempotencyKey: () => 'k',
}));
const mockReadIntelConsent = jest.fn();
const mockSetIntelConsent = jest.fn();
jest.mock('../../../src/services/intelConsent', () => ({
  ...jest.requireActual('../../../src/services/intelConsent'),
  readIntelConsent: (...a: unknown[]) => mockReadIntelConsent(...a),
  setIntelConsent: (...a: unknown[]) => mockSetIntelConsent(...a),
}));

import QuickSignalScreen from '../quick-signal';

const GRANTED = {
  enabled: true, consentVersion: 'intel_contributions_v1', consentedAt: '2026-09-01T00:00:00Z',
  withdrawnAt: null, currentDisclosureVersion: 'intel_contributions_v1',
};
const NEVER = { ...GRANTED, enabled: false, consentVersion: null, consentedAt: null };

beforeEach(() => { mockReadIntelConsent.mockReset(); mockSetIntelConsent.mockReset(); });

describe('Quick Signal — consent that could not be read', () => {
  it.each([
    ['an HTTP error', { status: 'unreadable', reason: 'http', httpStatus: 500 }],
    ['a dropped connection', { status: 'unreadable', reason: 'network' }],
    ['a body this build cannot read', { status: 'unreadable', reason: 'malformed' }],
  ])('%s shows an outage with Retry — NOT the first-use consent gate, and no prompts', async (_l, read) => {
    mockReadIntelConsent.mockResolvedValue(read);
    const { findByTestId, queryByTestId, getByText } = await render(<QuickSignalScreen />);
    await findByTestId('intel-consent-unreadable');
    expect(queryByTestId('intel-consent-gate')).toBeNull();
    expect(queryByTestId('intel-party-size')).toBeNull();
    expect(getByText('Try again')).toBeTruthy();
    expect(mockSetIntelConsent).not.toHaveBeenCalled();
  });

  it('Retry re-reads, and a consent that IS granted then shows the prompts', async () => {
    mockReadIntelConsent.mockResolvedValueOnce({ status: 'unreadable', reason: 'http', httpStatus: 503 })
      .mockResolvedValueOnce({ status: 'ok', state: GRANTED });
    const { findByTestId, getByText, queryByTestId } = await render(<QuickSignalScreen />);
    await findByTestId('intel-consent-unreadable');
    fireEvent.press(getByText('Try again'));
    await findByTestId('intel-party-size');
    expect(mockReadIntelConsent).toHaveBeenCalledTimes(2);
    expect(queryByTestId('intel-consent-gate')).toBeNull();
  });

  it('an unconfigured build says it is not connected, and offers no retry that cannot help', async () => {
    mockReadIntelConsent.mockResolvedValue({ status: 'unreadable', reason: 'not_configured' });
    const { findByText, queryByText, queryByTestId } = await render(<QuickSignalScreen />);
    await findByText('Not connected');
    expect(queryByText('Try again')).toBeNull();
    expect(queryByTestId('intel-consent-gate')).toBeNull();
  });
});

describe('Quick Signal — a consent that WAS read renders as before', () => {
  it('not granted → the first-use consent gate', async () => {
    mockReadIntelConsent.mockResolvedValue({ status: 'ok', state: NEVER });
    const { findByTestId, queryByTestId } = await render(<QuickSignalScreen />);
    await findByTestId('intel-consent-gate');
    expect(queryByTestId('intel-consent-unreadable')).toBeNull();
  });

  it('granted → the prompts, with no gate', async () => {
    mockReadIntelConsent.mockResolvedValue({ status: 'ok', state: GRANTED });
    const { findByTestId, queryByTestId } = await render(<QuickSignalScreen />);
    await findByTestId('intel-party-size');
    expect(queryByTestId('intel-consent-gate')).toBeNull();
  });

  it('allowing at the gate shows the prompts without a second read', async () => {
    mockReadIntelConsent.mockResolvedValue({ status: 'ok', state: NEVER });
    mockSetIntelConsent.mockResolvedValue(GRANTED);
    const { findByTestId } = await render(<QuickSignalScreen />);
    fireEvent.press(await findByTestId('intel-consent-allow'));
    await findByTestId('intel-party-size');
    await waitFor(() => expect(mockReadIntelConsent).toHaveBeenCalledTimes(1));
  });
});
