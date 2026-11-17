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
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';
import { useBottomInset } from '../../src/hooks/useBottomInset.ts';
import { NavBarFiller } from '../../src/hooks/useNavBarCollapse.ts';
import { router } from 'expo-router';

// jest only permits a `mock`-prefixed out-of-scope variable inside a mock factory.
let mockWallFlagOn = false;
let mockDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
let mockPathname = '/';
let mockDesktop = false;
let mockCity: string | null = null;
let mockUserId = 'viewer-a';
const mockGetMyProfile = jest.fn().mockResolvedValue({ ok: false, data: null });
let mockProfileChanged: (() => void) | undefined;
let mockSwipe: ((event: { translationX: number; translationY: number; velocityX: number }) => void) | undefined;
const mockPrefetchCounts = jest.fn().mockResolvedValue({});
const mockPrefetchPlaces = jest.fn().mockResolvedValue([]);
jest.mock('../../src/services/discovery.ts', () => ({
  ...jest.requireActual('../../src/services/discovery.ts'),
  getDiscoveryCategoryCountsBatch: (...args: unknown[]) => mockPrefetchCounts(...args),
  getDiscoveryPlaces: (...args: unknown[]) => mockPrefetchPlaces(...args),
}));
jest.mock('react-native-gesture-handler', () => {
  const actual = jest.requireActual('react-native-gesture-handler');
  return { ...actual, GestureDetector: ({ children }: any) => children,
    Gesture: { ...actual.Gesture, Pan: () => {
      const gesture = { minDistance: () => gesture, runOnJS: () => gesture,
        onEnd: (callback: typeof mockSwipe) => { mockSwipe = callback; return gesture; } };
      return gesture;
    } } };
});
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return Object.defineProperty(Object.create(actual), 'useWindowDimensions', { value: () => mockDimensions });
});

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
    usePathname: () => mockPathname,
    useRouter: () => ({ push: jest.fn() }),
    useFocusEffect: () => {},
    Link: ({ children }: any) => children,
  };
});

// NOTE: exhaustive by design — pins the MOBILE branch so the assertions target
// FloatingTabBar. DesktopSidebar is covered by the same NAV list it maps over.
jest.mock('../../src/hooks/useBreakpoint', () => ({ useIsDesktop: () => mockDesktop }));
// NOTE: exhaustive by design — TabLayout renders nothing until authed; a real session
// would require Supabase auth in a test about tab-bar contents.
jest.mock('../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: mockUserId, isAuthed: true, loading: false, configured: true }),
}));
// NOTE: exhaustive by design — badge counts are irrelevant here and the real hook polls.
jest.mock('../../src/hooks/useMessaging', () => ({ useUnreadCounts: () => ({ total: 0, refresh: jest.fn() }) }));
// NOTE: exhaustive by design — the real hook starts geolocation watchers.
jest.mock('../../src/hooks/useGeofenceMonitor', () => ({ useGeofenceMonitor: () => {} }));
// NOTE: exhaustive by design — network call behind a tab badge.
jest.mock('../../src/services/messaging', () => ({ getIncomingMessageRequests: async () => [] }));
// NOTE: exhaustive by design — network call behind a tab badge.
jest.mock('../../src/services/trips', () => ({ getPendingTripInvites: async () => [] }));
// NOTE: exhaustive by design — drive own-profile reads without network access.
jest.mock('../../src/services/profile', () => ({ getMyProfile: (...args: unknown[]) => mockGetMyProfile(...args),
  subscribeOwnProfileChanges: (listener: () => void) => { mockProfileChanged = listener; return () => { mockProfileChanged = undefined; }; },
}));
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
    resolvedLocation: { place: { city: mockCity } },
    locationState: { place: { city: mockCity } },
  }),
  LocationProvider: ({ children }: any) => children,
}));
// NOTE: exhaustive by design — insets only; a real provider needs a native host view.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));

import TabLayout from '../(tabs)/_layout.tsx';
function Clearance() { const inset = useBottomInset(); return <View testID="tab-scroll-clearance" style={{ paddingBottom: inset }}><NavBarFiller /></View>; }

describe('(tabs)/_layout — the Wall entry appears in the navigation that is actually rendered', () => {
  afterEach(() => { mockWallFlagOn = false; mockDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 }; mockPathname = '/'; mockDesktop = false; mockCity = null; mockSwipe = undefined; mockUserId = 'viewer-a'; mockGetMyProfile.mockReset().mockResolvedValue({ ok: false, data: null }); jest.clearAllMocks(); jest.useRealTimers(); });

  for (const desktop of [false, true]) it(`uses the viewer's profile photo for Passport and retains its destination (desktop=${desktop})`, async () => {
    mockDesktop = desktop;
    mockGetMyProfile.mockResolvedValue({ ok: true, data: { id: mockUserId, displayName: 'Maya Chen', username: 'maya', avatarUrl: 'https://example.com/maya.jpg' } });
    await render(<TabLayout />);
    expect(screen.getByTestId('passport-menu-avatar').props.source).toMatchObject({ uri: 'https://example.com/maya.jpg' });
    await fireEvent.press(screen.getByLabelText('Passport'));
    expect(router.push).toHaveBeenCalledWith('/(tabs)/passport');
  });

  it('refreshes after profile editing and uses initials when the photo is removed', async () => {
    mockGetMyProfile.mockResolvedValue({ ok: true, data: { id: mockUserId, displayName: 'Maya Chen', username: 'maya', avatarUrl: 'https://example.com/maya.jpg' } });
    const view = await render(<TabLayout />);
    mockGetMyProfile.mockResolvedValue({ ok: true, data: { id: mockUserId, displayName: 'Maya Chen', username: 'maya', avatarUrl: null } });
    mockPathname = '/passport';
    await view.rerender(<TabLayout />);
    expect(screen.getByText('MC')).toBeTruthy();
    expect(screen.getByTestId('passport-menu-avatar').props.source).toBeUndefined();
    expect(screen.getByLabelText('Passport').props.accessibilityState.selected).toBe(true);
  });

  it('refreshes an inline display-photo change without requiring tab navigation', async () => {
    mockGetMyProfile.mockResolvedValue({ ok: true, data: { id: mockUserId, displayName: 'Maya Chen', username: 'maya', avatarUrl: null } });
    await render(<TabLayout />);
    expect(screen.getByText('MC')).toBeTruthy();
    mockGetMyProfile.mockResolvedValue({ ok: true, data: { id: mockUserId, displayName: 'Maya Chen', username: 'maya', avatarUrl: 'https://example.com/new-photo.jpg' } });
    await act(async () => mockProfileChanged?.());
    expect(screen.getByTestId('passport-menu-avatar').props.source).toMatchObject({ uri: 'https://example.com/new-photo.jpg' });
  });

  it('withholds the old account photo and ignores a late profile response after account switching', async () => {
    let finishOld: (value: unknown) => void = () => {};
    mockGetMyProfile.mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }));
    const view = await render(<TabLayout />);
    mockUserId = 'viewer-b';
    mockGetMyProfile.mockResolvedValue({ ok: true, data: { id: mockUserId, displayName: 'Sam Lee', username: 'sam', avatarUrl: null } });
    await view.rerender(<TabLayout />);
    await act(async () => finishOld({ ok: true, data: { id: 'viewer-a', displayName: 'Maya Chen', username: 'maya', avatarUrl: 'https://example.com/maya.jpg' } }));
    expect(screen.getByText('SL')).toBeTruthy();
    expect(screen.queryByText('MC')).toBeNull();
    expect(screen.getByTestId('passport-menu-avatar').props.source).toBeUndefined();
  });

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

  it('keeps six narrow-screen labels in bounded slots with full accessibility names and intentional overflow', async () => {
    mockWallFlagOn = true; mockDimensions = { ...mockDimensions, width: 320 };
    await render(<TabLayout />);
    for (const label of ['Pulse', 'Discovery', 'Roam', 'Trips', 'Passport', 'Wall']) {
      const button = screen.getByLabelText(label);
      expect(StyleSheet.flatten(button.props.style)).toMatchObject({ minHeight: 44, minWidth: 0 });
      expect(screen.getByText(label).props).toMatchObject({ numberOfLines: 1, ellipsizeMode: 'tail', maxFontSizeMultiplier: 2 });
    }
    expect(StyleSheet.flatten(screen.getByText('Discovery').props.style)).toMatchObject({ fontSize: 9, width: '100%', textAlign: 'center' });
    expect(StyleSheet.flatten(screen.getByTestId('floating-tab-pill').props.style).height).toBe(64);
  });

  it('grows the scaled label line, pill and both scroll clearances together', async () => {
    mockWallFlagOn = true; mockDimensions = { ...mockDimensions, width: 320, fontScale: 2 };
    await render(<><TabLayout /><Clearance /></>);
    const height = StyleSheet.flatten(screen.getByTestId('floating-tab-pill').props.style).height;
    expect(height).toBe(77);
    const clearance = screen.getByTestId('tab-scroll-clearance');
    expect(StyleSheet.flatten(clearance.props.style).paddingBottom).toBe(height + 32);
    expect(StyleSheet.flatten(screen.getByTestId('nav-bar-filler').props.style).height).toBe(height + 32);
    expect(screen.getByLabelText('Discovery')).toBeTruthy();
  });

  it.each([
    ['/', 'Pulse'], ['/(tabs)/', 'Pulse'], ['/passport', 'Passport'],
    ['/(tabs)/passport/', 'Passport'], ['/passport/edit', 'Passport'], ['/discovery/', 'Discovery'],
  ])('selects only the correct tab for pathname %s', async (pathname, selected) => {
    mockWallFlagOn = true; mockPathname = pathname;
    await render(<TabLayout />);
    for (const label of ['Pulse', 'Discovery', 'Roam', 'Trips', 'Passport', 'Wall']) {
      expect(screen.getByLabelText(label).props.accessibilityState.selected).toBe(label === selected);
    }
  });

  it('does not confuse a similarly prefixed route with a tab', async () => {
    mockWallFlagOn = true; mockPathname = '/passportx';
    await render(<TabLayout />);
    expect(screen.getByLabelText('Passport').props.accessibilityState.selected).toBe(false);
    expect(screen.getByLabelText('Pulse').props.accessibilityState.selected).toBe(false);
  });

  it('uses the same ungrouped-path selection for the desktop sidebar', async () => {
    mockWallFlagOn = true; mockDesktop = true; mockPathname = '/passport/edit/';
    await render(<TabLayout />);
    expect(screen.getByLabelText('Passport').props.accessibilityState.selected).toBe(true);
    expect(screen.getByLabelText('Pulse').props.accessibilityState.selected).toBe(false);
    expect(screen.getByLabelText('Discovery').props.accessibilityState.selected).toBe(false);
  });

  it.each<[string, number, string | null]>([
    ['/passport', -100, null], ['/passport', 100, '/(tabs)/trips'],
    ['/discovery', -100, '/(tabs)/media'], ['/discovery', 100, '/(tabs)/'],
    ['/', -100, '/(tabs)/discovery'], ['/', 100, null],
    ['/(tabs)/passport/edit/', 100, '/(tabs)/trips'], ['/passportx', -100, null], ['/media', 100, null],
  ])('swipes from %s by %s using the real current tab and retains end bounds', async (pathname, translationX, destination) => {
    mockPathname = pathname;
    await render(<TabLayout />);
    expect(mockSwipe).toBeDefined();
    await act(async () => { mockSwipe?.({ translationX, translationY: 0, velocityX: 400 }); });
    if (destination) expect(router.replace).toHaveBeenCalledWith(destination);
    else expect(router.replace).not.toHaveBeenCalled();
  });

  it.each(['/', '/trips', '/(tabs)/trips/'])('warms Discovery when the real adjacent path is %s', async pathname => {
    jest.useFakeTimers(); mockPathname = pathname; mockCity = 'Cebu';
    await render(<TabLayout />);
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(mockPrefetchCounts).toHaveBeenCalledWith('Cebu', 10);
    expect(mockPrefetchPlaces).toHaveBeenCalledWith('Cebu', 'for_you', { radiusKm: 25, openNow: false, minRating: null });
  });

  it('does not warm Discovery from an unrelated similarly prefixed route', async () => {
    jest.useFakeTimers(); mockPathname = '/tripsx'; mockCity = 'Cebu';
    await render(<TabLayout />);
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(mockPrefetchCounts).not.toHaveBeenCalled();
    expect(mockPrefetchPlaces).not.toHaveBeenCalled();
  });
});
