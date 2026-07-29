/**
 * Passport stamp country pin — navigation tests.
 *
 * Confirms that:
 * 1. MapEntityPreviewCard renders a "View Stamps" CTA for stamps entities.
 * 2. Tapping the CTA calls router.push('/passport/country/France') and onClose.
 * 3. The card shows the country name and stamp count.
 *
 * This tests MapEntityPreviewCard (used by the inline/discover-tab map) in
 * isolation — no full-screen map wrapper or Reanimated needed.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { MapEntityPreviewCard } from '../../../src/components/map/MapEntityPreviewCard.tsx';

// ── expo-router ────────────────────────────────────────────────────────────────
// Provide a minimal stub — MapEntityPreviewCard only uses `router`.
// NOTE: no jest.requireActual spread; that causes the actual router singleton
// to override our mock due to babel-jest hoisting order.
jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    navigate: jest.fn(),
    dismiss: jest.fn(),
  },
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
  useSegments: () => [],
  Link: ({ children }: { children: React.ReactNode }) => children,
  Redirect: () => null,
  Stack: { Screen: () => null },
  Tabs: { Screen: () => null },
}));

// ── react-native-safe-area-context ─────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── messaging service ──────────────────────────────────────────────────────────
// NOTE: intentional stub — openDirectThread is only used by FriendCard.
jest.mock('../../../src/services/messaging', () => ({
  openDirectThread: jest.fn().mockResolvedValue({ ok: false }),
}));

// ── Test fixture ───────────────────────────────────────────────────────────────

const STAMPS_ENTITY = {
  id: 'stamp:France',
  type: 'stamps' as const,
  lat: 46.2276,
  lng: 2.2137,
  payload: {
    country: 'France',
    stampCount: 4,
    cities: ['Paris', 'Lyon', 'Nice'],
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MapEntityPreviewCard — stamps "View Stamps" CTA navigation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders "View Stamps" CTA for a stamps entity', async () => {
    await render(
      <MapEntityPreviewCard entity={STAMPS_ENTITY} onClose={jest.fn()} />,
    );

    expect(screen.getByText('View Stamps')).toBeTruthy();
  });

  it('calls router.push("/passport/country/France") and onClose when "View Stamps" is tapped', async () => {
    const onClose = jest.fn();

    await render(
      <MapEntityPreviewCard entity={STAMPS_ENTITY} onClose={onClose} />,
    );

    fireEvent.press(screen.getByText('View Stamps'));

    // onClose must be called first (closes the preview card).
    expect(onClose).toHaveBeenCalledTimes(1);

    // router.push must navigate to the country-filtered stamp screen.
    // Navigation is deferred until after the sheet's close animation finishes
    // (BUG CC/CD fix — see closeThenNavigate), so wait for it here.
    // Cast to jest.Mock — the mock factory sets router.push = jest.fn().
    await waitFor(() => expect((router.push as jest.Mock)).toHaveBeenCalledWith('/passport/country/France'));
  });

  it('shows the country name and stamp count in the card', async () => {
    await render(
      <MapEntityPreviewCard entity={STAMPS_ENTITY} onClose={jest.fn()} />,
    );

    expect(screen.getByText('France')).toBeTruthy();
    expect(screen.getByText('4 stamps')).toBeTruthy();
  });
});
