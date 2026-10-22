/**
 * Compass preferences — the Rent a Buddy section is shown only while Rent a Buddy is served.
 *
 * With `rent_buddy_enabled` OFF (production, 2026-10-22) the screen still drew a "Rent a Buddy" section: a
 * "Show my Buddy profile in recommendations" switch for a marketplace that is not on, and "Edit Buddy profile &
 * pricing →", which opened the (rent-a-buddy) layout's COMING SOON gate.
 *   R1  flag off → no Rent a Buddy section; the rest of the screen is there;
 *   R2  flag on → the section, and its link opens the Buddy dashboard.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

import CompassPreferencesScreen from '../compass-preferences.tsx';

const mockRab = { enabled: false };
// NOTE: intentionally exhaustive — the flag is the input under test; the real hook fetches /api/feature-flags.
jest.mock('../../src/hooks/useRentABuddyFlag', () => ({
  useRentABuddyFlag: () => ({ enabled: mockRab.enabled, loading: false }),
}));

// NOTE: intentionally exhaustive — the preferences are the screen's input; the real hook calls the API.
jest.mock('../../src/hooks/compass/useCompassPreferences', () => ({
  useCompassPreferences: () => ({ prefs: { rent_buddy_discoverable: true }, loading: false, saving: false, update: jest.fn() }),
}));

// NOTE: intentionally exhaustive — the three calls the screen makes; the Sense read never answers, so that
// section stays out of the way (it renders nothing until its settings arrive).
jest.mock('../../src/services/compass', () => ({
  putCompassBoostVisibility: jest.fn(),
  fetchCompassSenseSettings: jest.fn(() => new Promise(() => {})),
  putCompassSenseSettings: jest.fn(),
}));

// NOTE: intentionally exhaustive — the nav-bar collapse handler needs the tab bar's animated context.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({ useNavBarScrollHandler: () => undefined }));
// NOTE: intentionally exhaustive — the bottom filler reads the tab bar's inset context.
jest.mock('../../src/hooks/useBottomInset', () => ({ PlainBottomFiller: () => null }));
// NOTE: intentionally exhaustive — the nudges panel is not under test.
jest.mock('../../src/features/live/SenseNudgesPanel', () => ({ SenseNudgesPanel: () => null }));
// NOTE: intentionally exhaustive — no SafeAreaProvider is mounted.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockPush = jest.fn();
// NOTE: intentionally exhaustive — expo-router needs a NavigationContainer; the screen uses `router` only.
jest.mock('expo-router', () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn() },
}));

beforeEach(() => { mockRab.enabled = false; mockPush.mockClear(); });

describe('Compass preferences — rent_buddy_enabled gate', () => {
  it('R1: flag off → no Rent a Buddy section; the rest of the screen is there', async () => {
    await render(<CompassPreferencesScreen />);
    expect(screen.getByText('Notification Preferences')).toBeTruthy();
    expect(screen.queryByText('Rent a Buddy')).toBeNull();
    expect(screen.queryByText('Show my Buddy profile in recommendations')).toBeNull();
    expect(screen.queryByText('Edit Buddy profile & pricing →')).toBeNull();
  });

  it('R2: flag on → the section, and its link opens the Buddy dashboard', async () => {
    mockRab.enabled = true;
    await render(<CompassPreferencesScreen />);
    expect(screen.getByText('Rent a Buddy')).toBeTruthy();
    expect(screen.getByText('Show my Buddy profile in recommendations')).toBeTruthy();
    await fireEvent.press(screen.getByText('Edit Buddy profile & pricing →'));
    expect(mockPush).toHaveBeenCalledWith('/(rent-a-buddy)/buddy-dashboard');
  });
});
