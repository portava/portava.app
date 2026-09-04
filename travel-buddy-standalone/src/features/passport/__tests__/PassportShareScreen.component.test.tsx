/**
 * Component tests for PassportShareScreen — the owner's Share entry (§25).
 *
 * Verifies:
 *   1. It builds the MINIMAL QR projection from the owner's profile and hands it
 *      (plus the @handle and share stats) to PassportQrSheet.
 *   2. Closing the sheet navigates back.
 *   3. It fails soft (no crash) when the profile is unavailable.
 *
 * PassportQrSheet is mocked to a prop-capturing probe so the wiring is asserted
 * without pulling its native SVG / clipboard / image dependencies.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import PassportShareScreen from '../PassportShareScreen.tsx';
import { router } from 'expo-router';

// NOTE: intentionally exhaustive — expo-router needs Expo native navigation
// modules unavailable in jest-expo; stub the members the screen uses.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) },
}));

// Prop-capturing probe for the QR sheet (real component pulls native SVG/clipboard).
const mockSheetProps: { current: any } = { current: null };
// NOTE: intentional stub — PassportQrSheet's own suite covers its behaviour; here
// it is a probe so the projection/handle wiring can be asserted in isolation.
jest.mock('../PassportQrSheet', () => ({
  PassportQrSheet: (props: any) => {
    mockSheetProps.current = props;
    return null;
  },
}));

// NOTE: intentionally exhaustive — usePassport drives Supabase + the full network
// stack; the screen only reads profile + stamps, injected here.
jest.mock('../../../hooks/usePassport', () => ({
  usePassport: jest.fn(),
}));

const { usePassport } = require('../../../hooks/usePassport.ts');
const mockUsePassport = usePassport as jest.Mock;

const OWNER = {
  id: 'me',
  name: 'Ana Lopez',
  displayName: 'Ana Lopez',
  handle: 'ana',
  username: 'ana',
  avatarUrl: 'https://cdn/a.jpg',
  verified: true,
  verificationLevel: 'trusted_traveler',
  homeCountry: 'Vietnam',
  interests: ['Food', 'Hiking'],
  tripCount: 4,
  bio: 'Slow traveler',
};

describe('PassportShareScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSheetProps.current = null;
  });

  it('builds the minimal QR projection and passes it + handle to the sheet', async () => {
    mockUsePassport.mockReturnValue({
      profile: OWNER,
      stamps: [{ locked: false }, { locked: true }, { locked: false }],
      loading: false,
    });

    await render(<PassportShareScreen />);

    const props = mockSheetProps.current;
    expect(props).toBeTruthy();
    expect(props.visible).toBe(true);
    expect(props.username).toBe('ana');
    // Minimal projection: first name only, handle, verification, permitted fields.
    expect(props.projection.firstName).toBe('Ana');
    expect(props.projection.handle).toBe('ana');
    expect(props.projection.verified).toBe(true);
    expect(props.projection.homeCountry).toBe('Vietnam');
    expect(props.projection.interests).toEqual(['Food', 'Hiking']);
    // The full/family name is NEVER part of the projection.
    expect(JSON.stringify(props.projection)).not.toMatch(/Lopez/);
    // Share stats: only unlocked stamps count.
    expect(props.stats.stampCount).toBe(2);
    expect(props.stats.tripCount).toBe(4);
  });

  it('navigates back when the sheet closes', async () => {
    mockUsePassport.mockReturnValue({ profile: OWNER, stamps: [], loading: false });

    await render(<PassportShareScreen />);
    mockSheetProps.current.onClose();

    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('shows a sign-in message and no sheet when there is no profile', async () => {
    mockUsePassport.mockReturnValue({ profile: null, stamps: [], loading: false });

    await render(<PassportShareScreen />);

    expect(screen.getByText('Sign in to share your passport.')).toBeTruthy();
    expect(mockSheetProps.current).toBeNull();
  });
});
