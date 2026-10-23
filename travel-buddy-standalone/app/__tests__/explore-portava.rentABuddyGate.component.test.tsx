/**
 * Explore Portava — the "Rent a Buddy" row is listed only while Rent a Buddy is served.
 *
 * With `rent_buddy_enabled` OFF (production, 2026-10-22) Services › Rent a Buddy was a live row (chevron, no SOON
 * badge) that opened only the (rent-a-buddy) layout's COMING SOON gate.
 *   E1  flag off → no Rent a Buddy row; the rest of Services is still listed;
 *   E2  flag on → the row, and it opens /(rent-a-buddy).
 *
 * The real SectionList virtualises (only ~10 rows commit under Jest's 0-height window — see
 * explore-portava.liveRoutes), so it is replaced by a flat list that draws every section the screen passes it:
 * what is asserted is what the screen hands the list.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

// NOTE: intentional stub — TESTING.md Rule 6 pattern (a Proxy, so the rest of react-native stays real): SectionList
// draws every section and row it is given instead of virtualising.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'SectionList') {
        const R = require('react');
        return ({ sections, renderItem, renderSectionHeader }: any) =>
          R.createElement(target.View, null, sections.map((section: any) =>
            R.createElement(target.View, { key: section.title },
              renderSectionHeader ? renderSectionHeader({ section }) : null,
              section.data.map((item: any, index: number) => R.createElement(R.Fragment, { key: item.key }, renderItem({ item, index, section }))))));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});

const mockRab = { enabled: false };
// NOTE: intentionally exhaustive — the flag is the input under test; the real hook fetches /api/feature-flags.
jest.mock('../../src/hooks/useRentABuddyFlag', () => ({
  useRentABuddyFlag: () => ({ enabled: mockRab.enabled, loading: false }),
}));

const mockPush = jest.fn();
// NOTE: intentionally exhaustive — expo-router needs a NavigationContainer; the screen uses `router` only.
jest.mock('expo-router', () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn() },
}));
// NOTE: intentional stub — AppHeader chrome is not under test.
jest.mock('../../src/components/ui/AppHeader', () => ({ AppHeader: () => null }));
// NOTE: intentional stub — the create sheet is closed.
jest.mock('../../src/components/create/CreateHubSheet', () => ({ CreateHubSheet: () => null }));
// NOTE: intentionally exhaustive — the session would build the real Supabase client; only signOut is read.
jest.mock('../../src/context/SessionContext', () => ({ useSession: () => ({ signOut: jest.fn() }) }));
// NOTE: intentionally exhaustive — the bottom inset reads the tab bar's context.
jest.mock('../../src/hooks/useBottomInset', () => ({ useBottomInset: () => 0 }));

import ExplorePortavaScreen from '../explore-portava.tsx';

beforeEach(() => { mockRab.enabled = false; mockPush.mockClear(); });

describe('Explore Portava — rent_buddy_enabled gate', () => {
  it('E1: flag off → no Rent a Buddy row; the rest of Services is still listed', async () => {
    await render(<ExplorePortavaScreen />);
    expect(screen.getByText('SERVICES')).toBeTruthy();
    expect(screen.getByLabelText('Emergency Tools')).toBeTruthy();
    expect(screen.queryByLabelText('Rent a Buddy')).toBeNull();
  });

  it('E2: flag on → the row, and it opens /(rent-a-buddy)', async () => {
    mockRab.enabled = true;
    await render(<ExplorePortavaScreen />);
    await fireEvent.press(screen.getByLabelText('Rent a Buddy'));
    expect(mockPush).toHaveBeenCalledWith('/(rent-a-buddy)');
  });
});
