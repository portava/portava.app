/**
 * CompassPicksSection — a failed Compass read is said, never the section's
 * silence (census-discovery §102, lane W11-X2 round 6; DV-83; register
 * D-W11X2-41).
 *
 * The section is on the Discovery For You tab. It hid itself whenever it had
 * nothing to show — "hide silently (no error state)" — so a failed read drew
 * exactly the screen Compass draws when it has no picks for this city; and a
 * failed refresh over kept picks drew them as current.
 *
 *   P1  the read failed, nothing held: the header, "couldn't load" and a retry that asks again
 *   P2  a failed refresh over kept picks: the picks, and the stale line
 *   P3  a scope switch in flight (loading, no data): the skeleton, never hidden
 *   C1  CONTROL: Compass answered with no picks: hidden (a real "nothing here")
 *   C2  CONTROL: Compass disabled (fallback): hidden
 *   C3  CONTROL: picks and no error: no failure line
 *
 * Run with: npx jest src/components/compass/__tests__/CompassPicksSection.failedRead.component.test.tsx
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

let mockFeed: Record<string, unknown> = {};
const mockRefresh = jest.fn();

// NOTE: intentionally exhaustive — expo-router navigation internals are not safe under jest-expo.
jest.mock('expo-router', () => ({ router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() } }));
// NOTE: intentionally exhaustive — the hook makes real API calls; each case sets its state.
jest.mock('../../../hooks/compass/useCompassFeed.ts', () => ({ useCompassFeed: () => ({ refresh: mockRefresh, ...mockFeed }) }));
// NOTE: intentionally exhaustive — native modal internals not safe under jest-expo.
jest.mock('../CompassWhySheet.tsx', () => ({ CompassWhySheet: () => null }));
// NOTE: intentionally exhaustive — analytics imports; nothing asserted on them.
jest.mock('../CompassFeedbackMenu.tsx', () => ({ CompassFeedbackMenu: () => null }));
// NOTE: intentionally exhaustive — compass analytics make real network calls.
jest.mock('../../../services/compass.ts', () => ({ postCompassAnalyticsEvent: jest.fn(), reportCompassViewed: jest.fn(), COMPASS_ENGINE_VERSION: 'test' }));
// NOTE: intentionally exhaustive — SessionContext uses Supabase auth internals.
jest.mock('../../../context/SessionContext.tsx', () => ({ useSession: () => ({ isAuthed: true, userId: 'user-1' }) }));

import { CompassPicksSection } from '../CompassPicksSection.tsx';

const PICK = { id: 'pick-1', type: 'place', category: 'food', title: 'Le Petit Bistro', data: { city: 'Paris' }, recommendationToken: 'tok-1' };
const withPicks = { sections: [{ items: [PICK] }], safeItems: [], fallback: false, compassEnabled: true };
const noPicks = { sections: [{ items: [] }], safeItems: [], fallback: false, compassEnabled: true };

beforeEach(() => { jest.clearAllMocks(); });

describe('CompassPicksSection — a failed read is said (DV-83, §102)', () => {
  it('P1 the read failed, nothing held: "couldn\'t load" with a retry that asks again', async () => {
    mockFeed = { loading: false, compassEnabled: true, data: null, error: 'network_error' };
    const { getByTestId, getByText } = await render(<CompassPicksSection city="Paris" enabled />);
    expect(getByTestId('compass-picks-failed')).toBeTruthy();
    expect(getByText('Couldn’t load Compass picks just now.')).toBeTruthy();
    fireEvent.press(getByTestId('compass-picks-retry'));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('P2 a failed refresh over kept picks: the picks, and the stale line', async () => {
    mockFeed = { loading: false, compassEnabled: true, data: withPicks, error: 'network_error' };
    const { getByTestId, getByText } = await render(<CompassPicksSection city="Paris" enabled />);
    expect(getByText('Le Petit Bistro')).toBeTruthy();
    expect(getByTestId('compass-picks-stale').props.children).toBe('Couldn’t refresh just now, so these picks may be out of date.');
  });

  it('P3 a scope switch in flight (loading, no data): the skeleton, never hidden', async () => {
    mockFeed = { loading: true, compassEnabled: true, data: null, error: null };
    const { toJSON, queryByTestId } = await render(<CompassPicksSection city="Paris" enabled />);
    expect(toJSON()).not.toBeNull();
    expect(queryByTestId('compass-picks-failed')).toBeNull();
  });

  it('C1 CONTROL Compass answered with no picks: hidden', async () => {
    mockFeed = { loading: false, compassEnabled: true, data: noPicks, error: null };
    const { toJSON } = await render(<CompassPicksSection city="Paris" enabled />);
    expect(toJSON()).toBeNull();
  });

  it('C2 CONTROL Compass disabled (fallback): hidden', async () => {
    mockFeed = { loading: false, compassEnabled: false, data: { ...noPicks, fallback: true, compassEnabled: false }, error: null };
    const { toJSON } = await render(<CompassPicksSection city="Paris" enabled />);
    expect(toJSON()).toBeNull();
  });

  it('C3 CONTROL picks and no error: no failure line', async () => {
    mockFeed = { loading: false, compassEnabled: true, data: withPicks, error: null };
    const { queryByTestId, getByText } = await render(<CompassPicksSection city="Paris" enabled />);
    expect(getByText('Le Petit Bistro')).toBeTruthy();
    expect(queryByTestId('compass-picks-stale')).toBeNull();
    expect(queryByTestId('compass-picks-failed')).toBeNull();
  });
});
