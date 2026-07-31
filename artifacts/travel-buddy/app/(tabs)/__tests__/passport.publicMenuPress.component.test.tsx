/**
 * Passport — ⋯ menu button opens public-profile action sheet
 *
 * Confirms that PassportIdentityCard renders the ⋯ button when isOwner=false
 * and onMenuPress is provided, and that pressing it calls the handler — which
 * in the real screen surfaces the block/report/share action sheet.
 *
 * The owner-passport case is covered by:
 *   passport.ownerMenuFreshLoad.component.test.tsx
 *   passport.ownerMenuScrolled.component.test.tsx
 *
 * Run with: pnpm test:component
 */

import React, { useState } from 'react';
import { View } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PassportIdentityCard } from '../../../src/components/passport/PassportIdentityCard.tsx';

// ── react-native-svg stub ─────────────────────────────────────────────────────
// SVG elements are not available in the jest-expo JSDOM env; stub them so
// PortavaBrandStamp and WorldTravelerStamp don't crash the test renderer.

jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View, Text } = require('react-native');
  const stub = (name: string) => (props: Record<string, unknown>) =>
    React.createElement(View, { testID: `svg-${name}` }, props.children ?? null);
  return {
    __esModule: true,
    default: stub('Svg'),
    Svg:     stub('Svg'),
    Circle:  stub('Circle'),
    Path:    stub('Path'),
    Rect:    stub('Rect'),
    Text:    (_props: unknown) => React.createElement(Text, null),
  };
});

// ── Identity / verification helpers ──────────────────────────────────────────
// NOTE: intentionally exhaustive — requireActual of identity utils is safe but
// avoids pulling in Supabase-adjacent modules.

jest.mock('../../../src/utils/identity', () => ({
  ...jest.requireActual('../../../src/utils/identity'),
  resolveAvatarUrl:      (_url: unknown)    => null,
  fallbackInitials:      (_profile: unknown) => 'PU',
  truncateDisplayName:   (name: unknown)    => name,
}));

jest.mock('../../../src/lib/displayIdentity', () => ({
  ...jest.requireActual('../../../src/lib/displayIdentity'),
  primaryIdentityText:   (_identity: unknown) => 'Public User',
  secondaryIdentityText: (_identity: unknown) => '@publicuser',
}));

jest.mock('../../../src/lib/verification', () => ({
  ...jest.requireActual('../../../src/lib/verification'),
  isTravelBuddyVerified: (_profile: unknown) => false,
}));

// ── Sub-components ─────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — HighlightRing pulls in native gesture deps.
jest.mock('../../../src/components/HighlightRing', () => ({
  HighlightRing: ({ children }: { children: React.ReactNode }) => children,
}));

// ── Services ──────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — getPassportStats calls Supabase.
jest.mock('../../../src/services/passportStamps', () => ({
  ...jest.requireActual('../../../src/services/passportStamps'),
  getPassportStats: jest.fn().mockResolvedValue({ ok: false }),
}));

// ── Theme ─────────────────────────────────────────────────────────────────────

jest.mock('../../../src/theme/passportTokens', () => ({
  ...jest.requireActual('../../../src/theme/passportTokens'),
  PP: {
    paper:       '#FFFFFF',
    ink:         '#1C1C1A',
    inkMuted:    '#8A7E6E',
    borderLight: 'rgba(0,0,0,0.08)',
  },
}));

// ── Minimal public-profile fixture ────────────────────────────────────────────

const PUBLIC_PROFILE = {
  id:       'user-public-1',
  username: 'publicuser',
  avatarUrl: null,
  bio:       null,
} as unknown as Parameters<typeof PassportIdentityCard>[0]['profile'];

// ── Thin wrapper: renders the card + an observable action-sheet sentinel ──────
//
// onMenuPress drives the sheet open in the real screen (app/passport/[username].tsx).
// Here we replicate that binding with a local state flag so the test can assert
// the sheet became visible after pressing ⋯.

function PublicPassportWithSheet() {
  const [sheetOpen, setSheetOpen] = useState(false);
  return (
    <>
      <PassportIdentityCard
        profile={PUBLIC_PROFILE}
        isOwner={false}
        onMenuPress={() => setSheetOpen(true)}
        onFollowPress={jest.fn()}
        isFollowing={false}
      />
      {sheetOpen ? <View testID="public-action-sheet" /> : null}
    </>
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Passport — ⋯ menu button (public-profile view)', () => {
  it('renders the ⋯ button with "More options" label when isOwner=false and onMenuPress is provided', async () => {
    await render(<PublicPassportWithSheet />);
    await act(async () => {});

    // The ⋯ button must exist in the public-profile card.
    expect(screen.getByLabelText('More options')).toBeTruthy();
  });

  it('calls onMenuPress and opens the action sheet when ⋯ is pressed on a public profile', async () => {
    await render(<PublicPassportWithSheet />);
    await act(async () => {});

    // Sheet is not open before pressing ⋯.
    expect(screen.queryByTestId('public-action-sheet')).toBeNull();

    // Press the ⋯ button — must trigger onMenuPress and show the sheet.
    await act(async () => {
      fireEvent.press(screen.getByLabelText('More options'));
    });

    expect(screen.getByTestId('public-action-sheet')).toBeTruthy();
  });

  it('does NOT render a ⋯ button when onMenuPress is omitted (public view, no handler)', async () => {
    await render(
      <PassportIdentityCard
        profile={PUBLIC_PROFILE}
        isOwner={false}
        onFollowPress={jest.fn()}
        isFollowing={false}
      />,
    );
    await act(async () => {});

    // No handler → no button.
    expect(screen.queryByLabelText('More options')).toBeNull();
  });
});
