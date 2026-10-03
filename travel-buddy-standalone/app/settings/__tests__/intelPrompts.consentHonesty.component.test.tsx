/**
 * Settings → Live intel prompts — the consent row tells the truth about what it
 * knows and about what it saved.
 *
 * THE DEFECTS. (1) An unreadable consent read came back `null` and rendered as
 * "Off" — with copy telling the person to update the app (no version, no
 * words) — over a LIVE switch whose "on" would re-stamp a consent they may
 * already have given. (2) A toggle whose write the server refused snapped back
 * with no word about why.
 *
 * CONTROLLED evidence: the consent service is a double; no network.
 */
import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — expo-router's real module needs a navigator.
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useNavigation: () => ({ addListener: () => () => {}, setOptions: jest.fn(), goBack: jest.fn(), canGoBack: () => true }),
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// NOTE: intentional stub — prompt pauses are not under test here.
jest.mock('../../../src/hooks/useIntelPrompts', () => ({
  useIntelPrompts: () => ({
    captureEnabled: true, pauseState: { pausedAll: false, pausedCategories: [] }, sessionPaused: false,
    pauseSession: jest.fn(), resumeSession: jest.fn(), pauseAll: jest.fn(), pauseCategory: jest.fn(), resumeEverything: jest.fn(),
  }),
}));
jest.mock('../../../src/services/sensing/acousticSensingPermission', () => ({
  ...jest.requireActual('../../../src/services/sensing/acousticSensingPermission'),
  readAcousticSensingPermission: jest.fn().mockResolvedValue({ granted: false }),
}));
const mockReadIntelConsent = jest.fn();
const mockSetIntelConsent = jest.fn();
jest.mock('../../../src/services/intelConsent', () => ({
  ...jest.requireActual('../../../src/services/intelConsent'),
  readIntelConsent: (...a: unknown[]) => mockReadIntelConsent(...a),
  setIntelConsent: (...a: unknown[]) => mockSetIntelConsent(...a),
}));

import IntelPromptsSettingsScreen from '../intel-prompts';

const GRANTED = {
  enabled: true, consentVersion: 'intel_contributions_v1', consentedAt: '2026-09-01T00:00:00Z',
  withdrawnAt: null, currentDisclosureVersion: 'intel_contributions_v1',
};
const NEVER = { ...GRANTED, enabled: false, consentVersion: null, consentedAt: null };

/** The consent row's Switch. */
const consentSwitch = (getByTestId: (id: string) => any) => getByTestId('intel-consent-switch');

beforeEach(() => { mockReadIntelConsent.mockReset(); mockSetIntelConsent.mockReset(); });

describe('Intel settings — a consent that could not be read', () => {
  it('says so, offers Retry, keeps the switch DISABLED, and never tells the person to update the app', async () => {
    mockReadIntelConsent.mockResolvedValue({ status: 'unreadable', reason: 'http', httpStatus: 500 });
    const r = await render(<IntelPromptsSettingsScreen />);
    await r.findByTestId('intel-consent-retry');
    expect(r.getByText(/Couldn't load this setting/)).toBeTruthy();
    expect(r.queryByText(/Update the app/)).toBeNull();
    expect(consentSwitch(r.getByTestId).props.disabled).toBe(true);
    expect(mockSetIntelConsent).not.toHaveBeenCalled();
  });

  it('Retry re-reads and a granted consent then shows On', async () => {
    mockReadIntelConsent.mockResolvedValueOnce({ status: 'unreadable', reason: 'network' })
      .mockResolvedValueOnce({ status: 'ok', state: GRANTED });
    const r = await render(<IntelPromptsSettingsScreen />);
    fireEvent.press(await r.findByTestId('intel-consent-retry'));
    await waitFor(() => expect(consentSwitch(r.getByTestId).props.value).toBe(true));
    expect(r.queryByTestId('intel-consent-retry')).toBeNull();
    expect(mockReadIntelConsent).toHaveBeenCalledTimes(2);
  });
});

describe('Intel settings — a refused write', () => {
  it('turning it on and being refused says the setting is unchanged', async () => {
    mockReadIntelConsent.mockResolvedValue({ status: 'ok', state: NEVER });
    mockSetIntelConsent.mockResolvedValue(null);
    const r = await render(<IntelPromptsSettingsScreen />);
    await waitFor(() => expect(consentSwitch(r.getByTestId).props.disabled).toBe(false));
    await act(async () => { fireEvent(consentSwitch(r.getByTestId), 'valueChange', true); });
    expect(await r.findByText(/Couldn.t save that change/)).toBeTruthy();
    expect(consentSwitch(r.getByTestId).props.value).toBe(false);
  });

  it('a write that succeeds shows On and no error', async () => {
    mockReadIntelConsent.mockResolvedValue({ status: 'ok', state: NEVER });
    mockSetIntelConsent.mockResolvedValue(GRANTED);
    const r = await render(<IntelPromptsSettingsScreen />);
    await waitFor(() => expect(consentSwitch(r.getByTestId).props.disabled).toBe(false));
    await act(async () => { fireEvent(consentSwitch(r.getByTestId), 'valueChange', true); });
    await waitFor(() => expect(consentSwitch(r.getByTestId).props.value).toBe(true));
    expect(r.queryByText(/Couldn.t save that change/)).toBeNull();
  });
});
