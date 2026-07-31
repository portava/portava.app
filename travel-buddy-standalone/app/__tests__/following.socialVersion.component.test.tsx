/**
 * following.socialVersion.component.test.tsx
 *
 * Integration test: confirms that the Following screen re-fetches and shows
 * @Portava immediately when the social-version counter is bumped (as happens
 * after onboarding completes), WITHOUT requiring a manual focus/refresh.
 *
 * Uses the REAL useSocialVersion hook — not mocked — so the full
 * bumpSocialVersion → listener → re-fetch chain is exercised end-to-end.
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — useFocusEffect is replaced with a plain
// useEffect so the screen's initial load fires on mount in the jest renderer
// (there is no navigator focus event in the jest environment). router.back is
// a no-op stub; the real router would trigger native navigation transitions.
jest.mock('expo-router', () => {
  const R = require('react');
  return {
    useFocusEffect: (cb: () => void) => { R.useEffect(cb, []); },
    useLocalSearchParams: jest.fn().mockReturnValue({}),
    router: { back: jest.fn(), push: jest.fn() },
    useLocalSearchParams: () => ({}),
  };
});

// NOTE: intentionally exhaustive — getMyFollowing is the only export used;
// the real follows module connects to Supabase which is unavailable in jest.
jest.mock('../../src/services/follows', () => ({
  getMyFollowing: jest.fn(),
}));

// NOTE: intentionally exhaustive — AppHeader renders native navigation chrome
// (back button, status bar) that requires a navigator context unavailable here.
jest.mock('../../src/components/ui/AppHeader', () => ({
  AppHeader: () => null,
}));

// NOTE: intentionally exhaustive — OfficialBadge renders an SVG asset; the
// stub avoids pulling in the SVG transformer which is not configured for jest.
jest.mock('../../src/components/OfficialBadge', () => ({
  OfficialBadge: () => null,
}));

// NOTE: intentionally exhaustive — useNavBarScrollHandler returns an Animated
// event handler; the real implementation calls Reanimated internals that are
// not available in the jest-expo transform environment.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => jest.fn(),
  NavBarFiller:           () => null,
}));

// NOTE: intentionally exhaustive — theme tokens are pure value objects; the
// Proxy stubs produce valid style primitives without pulling the real tokens.
jest.mock('../../src/theme/tokens', () => {
  const colorProxy  = new Proxy({}, { get: () => '#000000' });
  const numberProxy = new Proxy({}, { get: () => 8 });
  const typeProxy   = new Proxy({}, { get: () => ({}) });
  return { color: colorProxy, space: numberProxy, radius: numberProxy, type: typeProxy };
});

// lucide-react-native: covered by the global Proxy mapper in jest.config.js —
// no per-file mock needed.

// ── Imports after mocks ───────────────────────────────────────────────────────

import FollowingScreen from '../following';
import { getMyFollowing } from '../../src/services/follows';
// Import the REAL bumpSocialVersion (useSocialVersion is NOT mocked here)
import { bumpSocialVersion } from '../../src/hooks/useSocialVersion';

const mockGetMyFollowing = getMyFollowing as jest.Mock;

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('FollowingScreen — social-version subscription', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('re-fetches and surfaces @Portava immediately after the social version bumps', async () => {
    // Phase 1: onboarding not yet complete — following list is empty.
    mockGetMyFollowing.mockResolvedValueOnce({ ok: true, data: [] });

    // Phase 2: server auto-follow has landed — @Portava is now in the list.
    mockGetMyFollowing.mockResolvedValueOnce({
      ok: true,
      data: [
        {
          id: 'portava-user-id',
          handle: 'portava',
          name: 'Portava',
          avatarUrl: null,
          isOfficial: true,
        },
      ],
    });

    await render(<FollowingScreen />);

    // Initial load on mount.
    await waitFor(() => expect(mockGetMyFollowing).toHaveBeenCalledTimes(1));

    // Simulate onboarding completion: runOnboardingFinish calls bumpSocialVersion().
    // Wrap in async act() so React flushes the setState from the listener and
    // the resulting useEffect([socialVersion]) before we assert.
    await act(async () => { bumpSocialVersion(); });

    // The subscription fires → getMyFollowing is called a second time
    // → @Portava appears in the list once the state update commits.
    await waitFor(() => {
      expect(mockGetMyFollowing).toHaveBeenCalledTimes(2);
      expect(screen.getByText('Portava')).toBeTruthy();
    });
  });
});
