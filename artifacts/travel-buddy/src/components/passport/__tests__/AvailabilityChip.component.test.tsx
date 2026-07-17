/**
 * Component tests for AvailabilityChip and PassportIdentityCard chip integration.
 *
 * Covers:
 *  - Chip renders when chipState has primary text only
 *  - Chip renders with secondary text (e.g. quick status)
 *  - Chip is absent (returns null) when chipState is null / undefined
 *  - onPress is called when chip is tapped
 *  - PassportIdentityCard renders chip when availabilityChip prop is set
 *  - PassportIdentityCard renders NO chip when availabilityChip is null (opted-out / busy)
 *  - PassportIdentityCard chip tap fires onAvailabilityChipPress
 *
 * NOTE: render() must be awaited in this env (RNTL 14 + React 19 + jest-expo)
 * or screen stays unbound and every query throws "render not called".
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AvailabilityChip } from '../AvailabilityChip.tsx';
import { PassportIdentityCard } from '../PassportIdentityCard.tsx';

// ── react-native-svg stub ─────────────────────────────────────────────────────

jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View, Text } = require('react-native');
  const stub = (name: string) => (props: Record<string, unknown>) =>
    React.createElement(View, { testID: `svg-${name}` }, props.children ?? null);
  return {
    __esModule: true,
    default:    stub('Svg'),
    Svg:        stub('Svg'),
    Circle:     stub('Circle'),
    Path:       stub('Path'),
    Rect:       stub('Rect'),
    Text:       (_props: unknown) => React.createElement(Text, null),
  };
});

// ── Identity / verification helpers ──────────────────────────────────────────

jest.mock('../../../utils/identity', () => ({
  ...jest.requireActual('../../../utils/identity'),
  resolveAvatarUrl:  (_url: unknown) => null,
  fallbackInitials:  (_profile: unknown) => 'TU',
}));

jest.mock('../../../lib/displayIdentity', () => ({
  ...jest.requireActual('../../../lib/displayIdentity'),
  primaryIdentityText:   (_identity: unknown) => 'Test User',
  secondaryIdentityText: (_identity: unknown) => '@testuser',
}));

jest.mock('../../../lib/verification', () => ({
  ...jest.requireActual('../../../lib/verification'),
  isTravelBuddyVerified: (_profile: unknown) => false,
}));

// ── Sub-components / services ─────────────────────────────────────────────────

// NOTE: intentionally exhaustive — HighlightRing uses native ring/gradient deps
// that are unavailable in the jest-expo JSDOM env. The component is purely a
// passthrough wrapper for testing; requireActual would crash the suite.
jest.mock('../../HighlightRing', () => ({
  HighlightRing: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('../../../services/passportStamps', () => ({
  ...jest.requireActual('../../../services/passportStamps'),
  getPassportStats: jest.fn().mockResolvedValue({ ok: false }),
}));

// ── Theme ─────────────────────────────────────────────────────────────────────

jest.mock('../../../theme/passportTokens', () => ({
  ...jest.requireActual('../../../theme/passportTokens'),
  PP: {
    paper:       '#FFFFFF',
    inkMuted:    '#8A7E6E',
    borderLight: 'rgba(0,0,0,0.08)',
  },
}));

// ── Minimal profile fixture ───────────────────────────────────────────────────

const baseProfile = {
  id:        'user-1',
  username:  'testuser',
  avatarUrl: null,
  bio:       null,
} as unknown as Parameters<typeof PassportIdentityCard>[0]['profile'];

// ── AvailabilityChip standalone tests ─────────────────────────────────────────

describe('AvailabilityChip', () => {
  it('renders the primary label when chipState has only a primary', async () => {
    await render(<AvailabilityChip chipState={{ primary: 'Open to meet' }} />);
    expect(screen.getByText(/Open to meet/)).toBeTruthy();
  });

  it('renders primary + secondary when chipState has both', async () => {
    await render(
      <AvailabilityChip
        chipState={{ primary: 'Open to meet', secondary: 'Free now' }}
      />,
    );
    expect(screen.getByText(/Open to meet/)).toBeTruthy();
    expect(screen.getByText(/Free now/)).toBeTruthy();
  });

  it('renders nothing when chipState is null', async () => {
    const { toJSON } = await render(<AvailabilityChip chipState={null} />);
    expect(toJSON()).toBeNull();
  });

  it('renders nothing when chipState is undefined', async () => {
    const { toJSON } = await render(<AvailabilityChip chipState={undefined} />);
    expect(toJSON()).toBeNull();
  });

  it('calls onPress when the chip is tapped', async () => {
    const onPress = jest.fn();
    await render(
      <AvailabilityChip
        chipState={{ primary: 'Open to meet' }}
        onPress={onPress}
        testID="chip"
      />,
    );
    fireEvent.press(screen.getByTestId('chip'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

// ── PassportIdentityCard chip integration tests ───────────────────────────────

describe('PassportIdentityCard — availability chip', () => {
  it('renders the availability chip when availabilityChip prop is provided', async () => {
    await render(
      <PassportIdentityCard
        profile={baseProfile}
        isOwner
        availabilityChip={{ primary: 'Open to meet', secondary: 'Free tonight' }}
        onAvailabilityChipPress={jest.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('availability-chip')).toBeTruthy());
  });

  it('does NOT render the chip when availabilityChip is null (opted-out / busy)', async () => {
    await render(
      <PassportIdentityCard
        profile={baseProfile}
        isOwner
        availabilityChip={null}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('availability-chip')).toBeNull());
  });

  it('does NOT render the chip when availabilityChip prop is absent', async () => {
    await render(
      <PassportIdentityCard
        profile={baseProfile}
        isOwner
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('availability-chip')).toBeNull());
  });

  it('calls onAvailabilityChipPress when chip is tapped', async () => {
    const onPress = jest.fn();
    await render(
      <PassportIdentityCard
        profile={baseProfile}
        isOwner
        availabilityChip={{ primary: 'Open to meet' }}
        onAvailabilityChipPress={onPress}
      />,
    );
    const chip = await waitFor(() => screen.getByTestId('availability-chip'));
    fireEvent.press(chip);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
