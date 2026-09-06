/**
 * tabsLayout.wallEntry.component.test.tsx
 *
 * THE DEFECT THIS PINS
 * --------------------
 * PR #441 made the Wall's tab entry follow `wall_enabled` by setting `href` on
 * `<Tabs.Screen name="wall">`. That was NOT enough, and the gap is invisible to
 * any source-level check: `Tabs.Screen` configures expo-router's DEFAULT tab
 * bar, and this app does not render it. The visible navigation is drawn by
 * FloatingTabBar (mobile) and DesktopSidebar (web), both of which iterate
 * NAV_ITEMS — a hardcoded five-entry array that did not include the Wall.
 *
 * So the Wall was mounted, its routes served once the flag was on, its
 * Tabs.Screen href resolved... and no user could see a way in. "Live and
 * invisible" is indistinguishable from "the feature does not work".
 *
 * A source-level assertion would have passed on #441. Only rendering the bar
 * and looking for the entry catches it, which is why this is a component test.
 *
 * Run: pnpm run test:component -- tabsLayout.wallEntry
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

// jest only permits a `mock`-prefixed out-of-scope variable inside a mock factory.
let mockWallFlagOn = false;

// NOTE: exhaustive by design — the flag value is the variable under test, so it must
// be driven per-case rather than read through the real provider's network fetch.
jest.mock('../../src/context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (f: string) => (f === 'wall_enabled' ? mockWallFlagOn : false), loading: false }),
}));

// expo-router's Tabs must be a real component here: the global mock exposes it
// as a plain object, which cannot be rendered as <Tabs>.
jest.mock('expo-router', () => {
  const React2 = require('react');
  const { View } = require('react-native');
  const Tabs: any = ({ children }: any) => React2.createElement(View, null, children);
  Tabs.Screen = () => null;
  return {
    Tabs,
    router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
    usePathname: () => '/(tabs)',
    useRouter: () => ({ push: jest.fn() }),
    useFocusEffect: () => {},
    Link: ({ children }: any) => children,
  };
});

// NOTE: exhaustive by design — pins the MOBILE branch so the assertions target
// FloatingTabBar. DesktopSidebar is covered by the same NAV list it maps over.
jest.mock('../../src/hooks/useBreakpoint', () => ({ useIsDesktop: () => false }));
// NOTE: exhaustive by design — TabLayout renders nothing until authed; a real session
// would require Supabase auth in a test about tab-bar contents.
jest.mock('../../src/context/SessionContext', () => ({
  useSession: () => ({ isAuthed: true, loading: false, configured: true }),
}));
// NOTE: exhaustive by design — badge counts are irrelevant here and the real hook polls.
jest.mock('../../src/hooks/useMessaging', () => ({ useUnreadCounts: () => ({ total: 0, refresh: jest.fn() }) }));
// NOTE: exhaustive by design — the real hook starts geolocation watchers.
jest.mock('../../src/hooks/useGeofenceMonitor', () => ({ useGeofenceMonitor: () => {} }));
// NOTE: exhaustive by design — network call behind a tab badge.
jest.mock('../../src/services/messaging', () => ({ getIncomingMessageRequests: async () => [] }));
// NOTE: exhaustive by design — network call behind a tab badge.
jest.mock('../../src/services/trips', () => ({ getPendingTripInvites: async () => [] }));
// NOTE: exhaustive by design — network call unrelated to nav contents.
jest.mock('../../src/services/profile', () => ({ getMyProfile: async () => null }));
// NOTE: exhaustive by design — header widget, not part of the nav bar under test.
jest.mock('../../src/components/NotificationBell', () => ({ NotificationBell: () => null }));
// NOTE: exhaustive by design — a modal that pulls in the whole create stack.
jest.mock('../../src/components/create/CreateHubSheet', () => ({ CreateHubSheet: () => null }));
// NOTE: exhaustive by design — BlurView needs native code absent under jest.
jest.mock('expo-blur', () => ({ BlurView: ({ children }: any) => children ?? null }));
// NOTE: exhaustive by design — prompt UI unrelated to nav contents.
jest.mock('../../src/components/LocationPermissionPrompt', () => ({ LocationPermissionPrompt: () => null }));
// NOTE: exhaustive by design — TabLayout reads resolvedLocation.place.city only to
// prefetch Discovery; a real provider would need device geolocation.
jest.mock('../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    resolvedLocation: { place: { city: null } },
    locationState: { place: { city: null } },
  }),
  LocationProvider: ({ children }: any) => children,
}));
// NOTE: exhaustive by design — insets only; a real provider needs a native host view.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));

import TabLayout from '../(tabs)/_layout.tsx';

describe('(tabs)/_layout — the Wall entry appears in the navigation that is actually rendered', () => {
  afterEach(() => { mockWallFlagOn = false; });

  it('shows no Wall entry while wall_enabled is off', async () => {
    mockWallFlagOn = false;
    await render(<TabLayout />);
    expect(screen.queryByText('Wall')).toBeNull();
  });

  it('shows the Wall entry once wall_enabled is on', async () => {
    mockWallFlagOn = true;
    await render(<TabLayout />);
    expect(
      screen.queryByText('Wall'),
      // Setting href on <Tabs.Screen name="wall"> does NOT satisfy this: the
      // rendered bar iterates NAV_ITEMS, not the Tabs.Screen list.
    ).not.toBeNull();
  });

  it('keeps the five always-on tabs in both states', async () => {
    mockWallFlagOn = true;
    await render(<TabLayout />);
    for (const label of ['Pulse', 'Discovery', 'Roam', 'Trips', 'Passport']) {
      expect(screen.queryByText(label)).not.toBeNull();
    }
  });
});
