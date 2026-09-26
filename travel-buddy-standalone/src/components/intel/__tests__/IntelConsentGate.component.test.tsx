/**
 * IntelConsentGate — the first-use D4 consent surface. Proves consent is an
 * explicit, affirmative action: nothing is granted until "Allow & Share" is
 * tapped AND the server records it; "Not Now" leaves without granting.
 *
 * And that the words are the words of a VERSION: the gate renders the text of
 * the version the server says it will stamp, sends that version with the
 * grant, and — for a version this build has no text for — renders no terms and
 * offers no grant rather than showing older words.
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive stand-in — requireActual('expo-haptics') pulls the native
// ExpoHaptics module, which throws at import under jest-expo. The gate only calls
// impactAsync with one enum, so this covers every export it touches.
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Error: 'error', Warning: 'warning' },
}));

// NOTE: exhaustive stand-in is intentional — the real service performs an authed
// network PUT to record consent; these tests assert the gate calls it and only
// proceeds on a recorded grant. It covers the one export the gate uses.
jest.mock('../../../services/intelConsent.ts', () => ({
  setIntelConsent: jest.fn(),
}));

import { IntelConsentGate } from '../IntelConsentGate.tsx';
import { setIntelConsent } from '../../../services/intelConsent.ts';

const GRANTED = {
  enabled: true, withdrawnAt: null, consentVersion: 'intel_contributions_v1',
  consentedAt: '2026-08-27T00:00:00.000Z', currentDisclosureVersion: 'intel_contributions_v1',
};

describe('IntelConsentGate (D4 first-use consent)', () => {
  it('shows the disclosure and pre-checks nothing', async () => {
    const { getByText, getByTestId } = await render(<IntelConsentGate disclosureVersion="intel_contributions_v1" onAllow={jest.fn()} onNotNow={jest.fn()} />);
    expect(getByText(/Help improve live place intelligence/i)).toBeTruthy();
    expect(getByTestId('intel-consent-allow')).toBeTruthy();
    expect(getByTestId('intel-consent-notnow')).toBeTruthy();
  });

  it('grants on Allow & Share and calls onAllow only after the server records it', async () => {
    (setIntelConsent as jest.Mock).mockResolvedValue(GRANTED);
    const onAllow = jest.fn(); const onNotNow = jest.fn();
    const { getByTestId } = await render(<IntelConsentGate disclosureVersion="intel_contributions_v1" onAllow={onAllow} onNotNow={onNotNow} />);
    fireEvent.press(getByTestId('intel-consent-allow'));
    await waitFor(() => expect(setIntelConsent).toHaveBeenCalledWith(true, 'intel_contributions_v1'));
    await waitFor(() => expect(onAllow).toHaveBeenCalledWith(GRANTED));
    expect(onNotNow).not.toHaveBeenCalled();
  });

  it('does NOT proceed if the server did not record consent', async () => {
    (setIntelConsent as jest.Mock).mockResolvedValue(null);
    const onAllow = jest.fn();
    const { getByTestId, findByText } = await render(<IntelConsentGate disclosureVersion="intel_contributions_v1" onAllow={onAllow} onNotNow={jest.fn()} />);
    fireEvent.press(getByTestId('intel-consent-allow'));
    await waitFor(() => expect(setIntelConsent).toHaveBeenCalled());
    expect(onAllow).not.toHaveBeenCalled();
    expect(await findByText(/Could not save/i)).toBeTruthy();
  });

  it('renders the words of the version the server will stamp — v2 names passive sensing and what others may see', async () => {
    (setIntelConsent as jest.Mock).mockClear();
    (setIntelConsent as jest.Mock).mockResolvedValue({ ...GRANTED, consentVersion: 'sensing_contributions_v2', currentDisclosureVersion: 'sensing_contributions_v2' });
    const { getByText, getByTestId, queryByText } = await render(
      <IntelConsentGate disclosureVersion="sensing_contributions_v2" onAllow={jest.fn()} onNotNow={jest.fn()} />,
    );
    expect(getByText(/in the background/i)).toBeTruthy();
    expect(getByText(/Never how many, and never who/)).toBeTruthy();
    expect(queryByText(/Help improve live place intelligence/i)).toBeNull();
    fireEvent.press(getByTestId('intel-consent-allow'));
    await waitFor(() => expect(setIntelConsent).toHaveBeenCalledWith(true, 'sensing_contributions_v2'));
  });

  it('a version this build has no words for shows no terms and grants nothing', async () => {
    (setIntelConsent as jest.Mock).mockClear();
    const onAllow = jest.fn();
    const { getByTestId, queryByText } = await render(
      <IntelConsentGate disclosureVersion="some_future_disclosure" onAllow={onAllow} onNotNow={jest.fn()} />,
    );
    expect(getByTestId('intel-consent-unknown-version')).toBeTruthy();
    expect(queryByText(/Help improve live place intelligence/i)).toBeNull();
    fireEvent.press(getByTestId('intel-consent-allow'));
    expect(setIntelConsent).not.toHaveBeenCalled();
    expect(onAllow).not.toHaveBeenCalled();
  });

  it('with no version at all (state not loaded / API down) it grants nothing', async () => {
    (setIntelConsent as jest.Mock).mockClear();
    const { getByTestId } = await render(<IntelConsentGate disclosureVersion={null} onAllow={jest.fn()} onNotNow={jest.fn()} />);
    expect(getByTestId('intel-consent-unknown-version')).toBeTruthy();
    fireEvent.press(getByTestId('intel-consent-allow'));
    expect(setIntelConsent).not.toHaveBeenCalled();
  });

  it('Not Now leaves without granting any consent', async () => {
    (setIntelConsent as jest.Mock).mockClear();
    const onNotNow = jest.fn();
    const { getByTestId } = await render(<IntelConsentGate disclosureVersion="intel_contributions_v1" onAllow={jest.fn()} onNotNow={onNotNow} />);
    fireEvent.press(getByTestId('intel-consent-notnow'));
    expect(onNotNow).toHaveBeenCalled();
    expect(setIntelConsent).not.toHaveBeenCalled();
  });
});
