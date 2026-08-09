/**
 * Component tests for PrivateProfileWall
 *
 * Covers:
 *   1. Renders profile picture area (avatar initials fallback when avatarUrl is null)
 *   2. Renders display name
 *   3. Renders username (@handle line)
 *   4. Renders "Private account" indicator text
 *   5. Renders relationship action button (Send Request) for non-own profile
 *   6. Does NOT render bio node (PrivateProfileWall never accepts or renders bio)
 *   7. Hides action button when isOwnProfile=true
 *   8. Shows "Request Sent" / pending state when friendRequestPending=true
 *
 * Run with: pnpm test:component
 *
 * RNTL v14: render() is async — always await the mount helper.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import { PrivateProfileWall } from '../PrivateProfileWall.tsx';
import type { PrivateProfilePreview } from '../PrivateProfileWall.tsx';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — PrivateRequestButton imports followUser from
// services/follows which pulls in Supabase native internals that crash under
// jest-expo; only the rendered button text matters in these privacy wall tests.
jest.mock('../../ui/PrivateRequestButton.tsx', () => ({
  PrivateRequestButton: ({ initialPending }: { initialPending?: boolean }) => {
    const { Text } = require('react-native');
    return (
      <Text testID="private-request-button">
        {initialPending ? 'Request sent' : 'Send Request'}
      </Text>
    );
  },
}));

// NOTE: intentionally exhaustive — spreading requireActual pulls in native font
// loader internals that crash under jest-expo; plain value stubs are sufficient
// for layout and color tests.

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_PROFILE: PrivateProfilePreview = {
  id: 'user-priv-001',
  handle: 'secretuser',
  displayName: 'Secret Traveler',
  avatarUrl: null,
};

// ── Mount helper ──────────────────────────────────────────────────────────────

async function mountWall(
  profile: PrivateProfilePreview = BASE_PROFILE,
  props: { friendRequestPending?: boolean; isOwnProfile?: boolean } = {},
) {
  return render(
    <PrivateProfileWall
      profile={profile}
      friendRequestPending={props.friendRequestPending}
      isOwnProfile={props.isOwnProfile}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PrivateProfileWall', () => {
  it('renders display name', async () => {
    await mountWall();
    await waitFor(() => {
      expect(screen.getByText('Secret Traveler')).toBeTruthy();
    });
  });

  it('renders @handle line', async () => {
    await mountWall();
    await waitFor(() => {
      expect(screen.getByText('@secretuser')).toBeTruthy();
    });
  });

  it('renders "Private account" indicator', async () => {
    await mountWall();
    await waitFor(() => {
      expect(screen.getByText('Private account')).toBeTruthy();
    });
  });

  it('renders relationship action button (Send Request) for non-own profile', async () => {
    await mountWall(BASE_PROFILE, { isOwnProfile: false });
    await waitFor(() => {
      expect(screen.getByTestId('private-request-button')).toBeTruthy();
      expect(screen.getByText('Send Request')).toBeTruthy();
    });
  });

  it('does NOT render bio node — bio is never passed to the wall component', async () => {
    // PrivateProfileWall does not accept a bio prop and never renders bio text.
    // Even if a bio string were somehow injected, the component must not display it.
    await mountWall();
    await waitFor(() => {
      // No bio text should appear anywhere in the rendered tree
      expect(screen.queryByTestId('bio')).toBeNull();
      // The wall message is the only body text — verify it's the privacy message
      expect(screen.getByText('Send a friend request to view this Passport.')).toBeTruthy();
    });
  });

  it('hides action button when isOwnProfile=true', async () => {
    await mountWall(BASE_PROFILE, { isOwnProfile: true });
    await waitFor(() => {
      expect(screen.queryByTestId('private-request-button')).toBeNull();
    });
  });

  it('shows pending state in wall message when friendRequestPending=true', async () => {
    await mountWall(BASE_PROFILE, { friendRequestPending: true, isOwnProfile: false });
    await waitFor(() => {
      expect(
        screen.getByText('Your request is pending. The owner must accept before you can view their Passport.'),
      ).toBeTruthy();
      // Button shows "Request sent"
      expect(screen.getByText('Request sent')).toBeTruthy();
    });
  });

  it('renders avatar initials fallback when avatarUrl is null', async () => {
    await mountWall({ ...BASE_PROFILE, avatarUrl: null });
    await waitFor(() => {
      // The initial is the first character of the display name
      expect(screen.getByText('S')).toBeTruthy(); // 'S' from 'Secret Traveler'
    });
  });

  it('renders initials from handle when displayName is null', async () => {
    await mountWall({ ...BASE_PROFILE, displayName: null, handle: 'jdoe' });
    await waitFor(() => {
      // Falls back to handle — primary = "jdoe", initial = "J"
      expect(screen.getByText('J')).toBeTruthy();
      // handle line should still appear
      expect(screen.getByText('@jdoe')).toBeTruthy();
    });
  });
});
