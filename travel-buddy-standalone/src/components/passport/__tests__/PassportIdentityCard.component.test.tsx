/**
 * Component tests for PassportIdentityCard — Saved shortcut navigation.
 *
 * Confirms that:
 *  1. Pressing the "Saved" button when isOwner={true} calls onSavedPress once.
 *  2. onSavedPress is NOT called when isOwner={false} (Follow pill is shown
 *     instead; the Saved button is absent from the owner-only branch).
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PassportIdentityCard } from '../PassportIdentityCard.tsx';

// ── react-native-svg stub ─────────────────────────────────────────────────────
// SVG elements are not available in the jest-expo JSDOM env; stub them out so
// the Passport brand stamp and verified seal don't crash the test renderer.

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
  primaryIdentityText:   (_identity: unknown) => 'Test User',
  secondaryIdentityText: (_identity: unknown) => '@testuser',
}));

jest.mock('../../../lib/verification', () => ({
  isTravelBuddyVerified: (_profile: unknown) => false,
}));

// ── Sub-components ────────────────────────────────────────────────────────────

jest.mock('../../HighlightRing', () => ({
  HighlightRing: ({ children }: { children: React.ReactNode }) => children,
}));

// ── Services ─────────────────────────────────────────────────────────────────

jest.mock('../../../services/passportStamps', () => ({
  getPassportStats: jest.fn().mockResolvedValue({ ok: false }),
}));

// ── Theme ─────────────────────────────────────────────────────────────────────

jest.mock('../../../theme/passportTokens', () => ({
  PP: {
    paper:       '#FFFFFF',
    inkMuted:    '#8A7E6E',
    borderLight: 'rgba(0,0,0,0.08)',
  },
}));

// ── Minimal profile fixtures ──────────────────────────────────────────────────

const ownProfile = {
  id:        'user-1',
  username:  'testuser',
  avatarUrl: null,
  bio:       null,
} as unknown as Parameters<typeof PassportIdentityCard>[0]['profile'];

const publicProfile = {
  id:       'user-2',
  username: 'otheruser',
  avatarUrl: null,
} as unknown as Parameters<typeof PassportIdentityCard>[0]['profile'];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PassportIdentityCard — Saved shortcut', () => {
  it('calls onSavedPress exactly once when the Saved button is pressed (isOwner=true)', async () => {
    const onSavedPress = jest.fn();

    render(
      <PassportIdentityCard
        profile={ownProfile}
        isOwner
        onSavedPress={onSavedPress}
      />,
    );

    // waitFor is required under React 19 + RNTL 14 to avoid a race between
    // the async-act scope and the screen query's internal polling setup.
    const savedBtn = await waitFor(() => screen.getByTestId('saved-btn'));
    fireEvent.press(savedBtn);

    expect(onSavedPress).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onSavedPress when isOwner=false (public view shows Follow pill instead)', async () => {
    const onSavedPress = jest.fn();

    render(
      <PassportIdentityCard
        profile={publicProfile}
        isOwner={false}
        onSavedPress={onSavedPress}
        onFollowPress={jest.fn()}
        isFollowing={false}
      />,
    );

    // The Saved button must not exist in the public view.
    await waitFor(() => expect(screen.queryByTestId('saved-btn')).toBeNull());
    expect(onSavedPress).not.toHaveBeenCalled();
  });
});
