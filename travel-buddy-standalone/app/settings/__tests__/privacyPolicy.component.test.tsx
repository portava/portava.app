import React from 'react';
import { Linking, StyleSheet } from 'react-native';
import { fireEvent, render, within, waitFor } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: {
    ...jest.requireActual('expo-router').router,
    push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(),
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 24, bottom: 34, left: 0, right: 0 }),
}));

import { router } from 'expo-router';
import { VERIFICATION_KEPT, VERIFICATION_NEVER_STORED } from '../../../src/lib/verificationDisclosure';
import PrivacyInformationScreen from '../privacy-policy';
const policyKeys = ['EXPO_PUBLIC_PRIVACY_POLICY_URL', 'EXPO_PUBLIC_IDENTITY_PROVIDER_PRIVACY_URL', 'EXPO_PUBLIC_PRIVACY_CONTACT_URL'] as const;
const previousPolicyEnv = Object.fromEntries(policyKeys.map(key => [key, process.env[key]]));

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of policyKeys) delete process.env[key];
  jest.mocked(router.canGoBack).mockReturnValue(true);
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network is forbidden in this test'));
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  jest.restoreAllMocks();
  for (const key of policyKeys) {
    if (previousPolicyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousPolicyEnv[key];
  }
});

describe('Owner-configured privacy destinations', () => {
  it('opens the exact published destinations only after a deliberate tap', async () => {
    process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL = 'https://policy.example.com/privacy';
    process.env.EXPO_PUBLIC_IDENTITY_PROVIDER_PRIVACY_URL = 'https://provider.example.com/privacy';
    process.env.EXPO_PUBLIC_PRIVACY_CONTACT_URL = 'https://support.example.com/privacy';
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const screen = await render(<PrivacyInformationScreen />);
    expect(screen.getByText('Published privacy policy')).toBeTruthy();
    expect(screen.queryByText('Not an approved privacy policy')).toBeNull();
    expect(open).not.toHaveBeenCalled();
    for (const [label, url] of [
      ['Read privacy policy', process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL],
      ['Verification service privacy policy', process.env.EXPO_PUBLIC_IDENTITY_PROVIDER_PRIVACY_URL],
      ['Contact about privacy', process.env.EXPO_PUBLIC_PRIVACY_CONTACT_URL],
    ]) {
      await fireEvent.press(screen.getByRole('link', { name: label }));
      expect(open).toHaveBeenLastCalledWith(url);
    }
  });
  it('withholds malformed or credential-bearing links and preserves the unavailable state', async () => {
    process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL = 'http://policy.example.com/privacy';
    process.env.EXPO_PUBLIC_IDENTITY_PROVIDER_PRIVACY_URL = 'javascript:alert(1)';
    process.env.EXPO_PUBLIC_PRIVACY_CONTACT_URL = 'https://user:secret@support.example.com/privacy';
    const screen = await render(<PrivacyInformationScreen />);
    expect(screen.getByText('Not an approved privacy policy')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Read privacy policy' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Verification service privacy policy' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Contact about privacy' })).toBeNull();
  });
  it('reports external-link failure without claiming the policy was opened', async () => {
    process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL = 'https://policy.example.com/privacy';
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('offline'));
    const screen = await render(<PrivacyInformationScreen />);
    await fireEvent.press(screen.getByRole('link', { name: 'Read privacy policy' }));
    await waitFor(() => expect(screen.getByText('Could not open this link. Please try again.')).toBeTruthy());
  });
});

describe('TV-7c — limited privacy information, not a published policy', () => {
  it('puts the unapproved status first and names the publication gaps without placeholder legal copy', async () => {
    const screen = await render(<PrivacyInformationScreen />);
    expect(screen.getAllByRole('header')[0].props.children).toBe('Not an approved privacy policy');
    expect(screen.getByText(/draft awaiting owner and legal review/)).toBeTruthy();
    expect(screen.getByText(/reviewed text or a published policy URL/)).toBeTruthy();
    expect(screen.getByText(/mailing address, privacy contact and effective date/)).toBeTruthy();
    expect(screen.getByText(/Age-policy choices and retention statements also need review/)).toBeTruthy();
    expect(screen.queryByText(/\[(?:COMPANY LEGAL NAME|PRIVACY EMAIL|ADDRESS|DATE|PROVIDER NAME|LINK)\]/)).toBeNull();
    expect(screen.queryByText(/last updated:|legally compliant|we don.t sell|no ads/i)).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /accept|agree|verify/i })).toBeNull();
    expect(screen.getByText(/does not give consent/)).toBeTruthy();
  });

  it('reuses every existing identity disclosure and explains the provider and profile boundaries', async () => {
    const screen = await render(<PrivacyInformationScreen />);
    for (const item of [...VERIFICATION_NEVER_STORED, ...VERIFICATION_KEPT]) {
      expect(screen.getByText(`• ${item.label}`)).toBeTruthy();
    }
    expect(screen.getByText(/session associated with your account/)).toBeTruthy();
    expect(screen.getByText(/Document capture and any selfie check/)).toBeTruthy();
    expect(screen.getByText(/verified adult/)).toBeTruthy();
    expect(screen.getByText(/birth date you enter separately in your profile/)).toBeTruthy();
    expect(screen.getByText(/provider name, session reference, and creation, update, verification and expiry times/)).toBeTruthy();
    expect(screen.queryByText(/Stripe|Persona|Sumsub/)).toBeNull();
  });

  it('describes cleanup and erasure without claiming deployed or guaranteed deletion', async () => {
    const screen = await render(<PrivacyInformationScreen />);
    expect(screen.getByText(/A provider request can fail/)).toBeTruthy();
    expect(screen.getByText(/failed or expired checks older than 90 days/)).toBeTruthy();
    expect(screen.getByText(/last status update/)).toBeTruthy();
    expect(screen.getByText(/does not target successful checks/)).toBeTruthy();
    expect(screen.getByText(/does not confirm that cleanup has run/)).toBeTruthy();
    expect(screen.getByText(/Moderation history is separate/)).toBeTruthy();
  });

  it('keeps information scrollable, scalable and untruncated with safe-area padding', async () => {
    const screen = await render(<PrivacyInformationScreen />);
    const scroll = screen.getByTestId('privacy-information-content');
    expect(StyleSheet.flatten(scroll.props.contentContainerStyle).paddingBottom).toBeGreaterThan(34);
    for (const text of within(scroll).getAllByText(/./)) {
      expect(text.props.allowFontScaling).not.toBe(false);
      expect(text.props.numberOfLines).toBeUndefined();
    }
    for (const heading of screen.getAllByRole('header')) {
      expect(heading.props.selectable).toBe(true);
    }
    for (const link of screen.getAllByRole('link')) {
      expect(StyleSheet.flatten(link.props.style).minHeight).toBeGreaterThanOrEqual(44);
    }
  });

  it.each([
    ['Privacy settings', '/profile/edit/privacy'],
    ['Identity verification', '/profile/verification'],
  ])('opens %s only after its accessible link is pressed', async (label, destination) => {
    const screen = await render(<PrivacyInformationScreen />);
    expect(router.push).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('link', { name: label }));
    expect(router.push).toHaveBeenCalledWith(destination);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it('returns to the previous screen using the accessible Back button', async () => {
    const screen = await render(<PrivacyInformationScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('falls back to Settings when opened without navigation history', async () => {
    jest.mocked(router.canGoBack).mockReturnValue(false);
    const screen = await render(<PrivacyInformationScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(router.replace).toHaveBeenCalledWith('/settings');
    expect(router.back).not.toHaveBeenCalled();
  });
});

// 2026-10-17 (wave 4, census-trust TV-7c restatement). A mutation that rewrote the
// erasure sentence to "Account deletion deletes Portava's verification records"
// left every case above green: the ORDER the data flow states — the provider is
// asked first, because the reference that lets anyone ask is deleted with the
// row (census-trust TV-7a) — was unpinned. Appended so no line above moves.
describe('TV-7c — the stated erasure order of the identity-check data flow', () => {
  it('says the verification service is asked to delete its copy BEFORE Portava deletes its records, and where deletion is requested', async () => {
    const screen = await render(<PrivacyInformationScreen />);
    expect(screen.getByText(/asking the verification service to delete its copy before\s+deleting Portava.s verification records/)).toBeTruthy();
    expect(screen.getByText(/Settings → Account → Delete account/)).toBeTruthy();
  });
});
