/**
 * Component + unit tests for the Passport QR / Bump share sheet (spec §25).
 *
 * Covers the two privacy guarantees:
 *   1. The QR projection is MINIMAL — buildQrProjection is a closed allow-list
 *      (photo, first name, @handle, verification, permitted home country /
 *      interests) and buildQrPayload encodes only the deep link. No extra
 *      profile data (email, bio, current city, home base, trust score, family
 *      name) leaks into the projection or the rendered sheet.
 *   2. Bump requires an AFFIRMATIVE, two-step confirmation. Opening the Bump
 *      panel never reveals the profile; onBumpConfirmed fires only after the
 *      explicit "Confirm exchange" press.
 *
 * NOTE: render() is awaited (RNTL 14 + React 19 + jest-expo).
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PassportQrSheet } from '../PassportQrSheet.tsx';
import {
  buildQrProjection,
  buildQrPayload,
  MINIMAL_QR_FIELDS,
  type MinimalQrProjection,
} from '../passportQrProjection.ts';
import { makeDeepLink } from '../../../services/passportShareUtils.ts';

// NOTE: react-native-svg needs native modules unavailable under jest-expo; a
// Proxy stand-in returns a View for every element (Svg/Rect/Path + the shapes
// VerifiedStamp draws), so the sheet + QR render without native bindings.
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Any = (props: any) => React.createElement(View, props, props.children);
  return new Proxy(
    { __esModule: true, default: Any },
    { get: (target: any, key: string) => (key in target ? target[key] : Any) },
  );
});

// NOTE: exhaustive stub — expo-clipboard is a native module; setStringAsync is
// the only member the sheet calls.
jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn().mockResolvedValue(true),
}));

// NOTE: exhaustive stub — usePassportShare captures a view + opens the native
// share sheet (react-native-view-shot / expo-sharing), neither available here.
jest.mock('../../../hooks/usePassportShare', () => ({
  usePassportShare: () => ({ cardRef: { current: null }, share: jest.fn(), sharing: false, error: null }),
}));

// NOTE: exhaustive stub — PassportShareCard + CachedImage reach native image
// caching; the sheet only mounts them, it does not assert on them.
jest.mock('../../../components/PassportShareCard', () => {
  const React = require('react');
  return { PassportShareCard: React.forwardRef(() => null) };
});
// NOTE: exhaustive stub — CachedImage reaches native image caching; the sheet
// only mounts it for the avatar and does not assert on it.
jest.mock('../../../components/CachedImage', () => ({
  CachedImage: () => null,
}));

// NOTE: exhaustive stub — VerifiedStamp draws its badge with react-native-svg
// <Text>; it is not under test here and only signals the verified state.
jest.mock('../../../components/ui/VerifiedStamp', () => ({
  VerifiedStamp: () => null,
}));

// NOTE: safe-area provider isn't mounted in unit renders.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── A deliberately over-full identity: only 6 fields may survive into the QR ──

const RICH_INPUT = {
  name: 'Ada Lovelace',
  handle: 'ada',
  avatarUrl: 'https://cdn.example/ada.jpg',
  verified: true,
  verificationLevel: 'trusted_traveler',
  homeCountry: 'United Kingdom',
  interests: ['Food', 'Nightlife', 'Museums'],
  // Everything below MUST NOT reach the QR projection or the rendered sheet:
  email: 'ada@secret.example',
  bio: 'Countess of Lovelace, private bio text',
  currentCity: 'Da Nang',
  homeBase: '221B Baker Street',
  lat: 16.0544,
  lng: 108.2022,
  trustScore: 87,
  lastName: 'Lovelace',
  phone: '+15551234567',
};

// ── Pure allow-list ──────────────────────────────────────────────────────────

describe('buildQrProjection — minimal allow-list', () => {
  it('returns ONLY the six permitted fields and drops everything else', () => {
    const proj = buildQrProjection(RICH_INPUT);
    expect(Object.keys(proj).sort()).toEqual([...MINIMAL_QR_FIELDS].sort());

    // No disallowed value rode along under any key.
    const serialized = JSON.stringify(proj);
    for (const leak of ['secret.example', 'private bio', 'Da Nang', 'Baker Street', '16.05', '87', '+1555']) {
      expect(serialized).not.toContain(leak);
    }
  });

  it('exposes first name only — never the family name', () => {
    const proj = buildQrProjection(RICH_INPUT);
    expect(proj.firstName).toBe('Ada');
    expect(JSON.stringify(proj)).not.toContain('Lovelace');
  });

  it('withholds home country and interests when not permitted', () => {
    const proj = buildQrProjection(RICH_INPUT, { homeCountryPermitted: false, interestsPermitted: false });
    expect(proj.homeCountry).toBeNull();
    expect(proj.interests).toEqual([]);
  });
});

describe('buildQrPayload — the encoded QR carries no PII', () => {
  it('encodes only the passport deep link plus the scan marker (§32 passport_qr_scanned)', () => {
    const payload = buildQrPayload('ada');
    // The marker is the ONLY difference from the plain share link — it carries
    // no data about anyone and lets the opened passport tell a scan from a tap.
    expect(payload).toBe(`${makeDeepLink('ada')}?via=qr`);
    expect(payload.startsWith(makeDeepLink('ada'))).toBe(true);
    for (const leak of ['Ada', 'Lovelace', 'secret.example', 'Da Nang', '87']) {
      expect(payload).not.toContain(leak);
    }
  });
});

// ── Rendered sheet ───────────────────────────────────────────────────────────

const MINIMAL: MinimalQrProjection = buildQrProjection(RICH_INPUT);

describe('PassportQrSheet — QR panel', () => {
  it('shows only the minimal fields and never leaks extra profile data', async () => {
    await render(
      <PassportQrSheet visible onClose={() => {}} username="ada" projection={MINIMAL} />,
    );

    // Permitted fields are shown.
    expect(screen.getByText('Ada')).toBeTruthy();
    expect(screen.getByText('@ada')).toBeTruthy();
    expect(screen.getByText('United Kingdom')).toBeTruthy();
    expect(screen.getByText('Food')).toBeTruthy();

    // Disallowed profile data must appear nowhere in the tree.
    const tree = JSON.stringify(screen.toJSON());
    for (const leak of ['secret.example', 'private bio', 'Da Nang', 'Baker Street', 'Lovelace', '221B']) {
      expect(tree).not.toContain(leak);
    }
  });
});

// ── Bump: affirmative confirmation only ──────────────────────────────────────

describe('PassportQrSheet — Bump', () => {
  it('never reveals on passive open; onBumpConfirmed fires only after confirmation', async () => {
    const onBumpConfirmed = jest.fn();
    await render(
      <PassportQrSheet
        visible
        onClose={() => {}}
        username="ada"
        projection={MINIMAL}
        onBumpConfirmed={onBumpConfirmed}
        initialPanel="bump"
      />,
    );

    // Panel open, but nothing exchanged yet (no passive reveal).
    expect(screen.getByLabelText('Start Bump')).toBeTruthy();
    expect(onBumpConfirmed).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Passport shared')).toBeNull();

    // Step 1: arm the exchange — still no reveal.
    fireEvent.press(screen.getByLabelText('Start Bump'));
    await waitFor(() => expect(screen.getByLabelText('Confirm exchange')).toBeTruthy());
    expect(onBumpConfirmed).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Passport shared')).toBeNull();

    // Step 2: affirmative confirm — now (and only now) it reveals.
    fireEvent.press(screen.getByLabelText('Confirm exchange'));
    await waitFor(() => expect(screen.getByLabelText('Passport shared')).toBeTruthy());
    expect(onBumpConfirmed).toHaveBeenCalledTimes(1);
  });

  it('cancelling the exchange keeps the profile unshared', async () => {
    const onBumpConfirmed = jest.fn();
    await render(
      <PassportQrSheet
        visible
        onClose={() => {}}
        username="ada"
        projection={MINIMAL}
        onBumpConfirmed={onBumpConfirmed}
        initialPanel="bump"
      />,
    );

    fireEvent.press(screen.getByLabelText('Start Bump'));
    await waitFor(() => expect(screen.getByLabelText('Cancel bump')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('Cancel bump'));

    await waitFor(() => expect(screen.getByLabelText('Start Bump')).toBeTruthy());
    expect(onBumpConfirmed).not.toHaveBeenCalled();
  });
});
