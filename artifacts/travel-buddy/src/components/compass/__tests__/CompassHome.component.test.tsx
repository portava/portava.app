/**
 * CompassHome component tests (Phase 10).
 *
 * Covers:
 *   - all six core actions render and prefill their intent via onAsk
 *   - sections backed by real data render; empty/null sections hide honestly
 *   - starting-soon event rows navigate to the real event screen
 *   - fallback response renders no data cards (actions still available)
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

const mockPush = jest.fn();
// NOTE: intentionally minimal — CompassHome only uses router.push; spreading
// requireActual('expo-router') here drags in native navigation internals that
// crash under jest-expo.
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
}));

const mockFetchCompassHome = jest.fn();
jest.mock('../../../services/compass', () => ({
  ...jest.requireActual('../../../services/compass'),
  fetchCompassHome: (...args: unknown[]) => mockFetchCompassHome(...args),
}));

import { CompassHome, CORE_ACTIONS } from '../CompassHome.tsx';

const FULL_HOME = {
  compassEnabled: true,
  fallback: false,
  timeOfDay: 'evening',
  contextState: 'exploring_now',
  city: 'Cebu',
  bestNextMove: {
    id: 'ev-1', type: 'event', title: 'Rooftop DJ set',
    category: 'music', city: 'Cebu', data: null, explanationKey: 'city_match',
  },
  circleActivity: {
    people: [{
      label: '@mika', handle: 'mika', status: 'out', statusLabel: 'Out exploring',
      approximateArea: 'IT Park area', venue: null, context: { type: 'trip', title: 'Cebu trip' },
    }],
  },
  startingSoon: [
    { id: 'ev-2', title: 'Sunset run club', city: 'Cebu', country: 'PH', startsAt: new Date().toISOString(), category: 'sports' },
  ],
  tonightVibe: {
    headline: '2 events on tonight — music leads the night',
    events: [
      { id: 'ev-3', title: 'Vinyl night', city: 'Cebu', country: 'PH', startsAt: new Date().toISOString(), category: 'music' },
    ],
  },
  weatherWindow: {
    city: 'Cebu', date: '2026-07-21', summary: 'Sunny', maxTempC: 31, minTempC: 25,
    precipMm: 0, headline: 'Sunny tomorrow — good window for outdoor plans',
  },
};

describe('CompassHome', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders all six core actions and prefills intents via onAsk', async () => {
    mockFetchCompassHome.mockResolvedValue({ ok: true, data: FULL_HOME });
    const onAsk = jest.fn();
    await render(<CompassHome onAsk={onAsk} />);
    await waitFor(() => expect(screen.getByText('Best next move')).toBeTruthy());

    expect(CORE_ACTIONS).toHaveLength(6);
    for (const a of CORE_ACTIONS) {
      expect(screen.getByText(a.label)).toBeTruthy();
    }
    fireEvent.press(screen.getByText('Tonight'));
    expect(onAsk).toHaveBeenCalledWith('What should I do tonight?');
  });

  it('renders every real-data section from the payload', async () => {
    mockFetchCompassHome.mockResolvedValue({ ok: true, data: FULL_HOME });
    await render(<CompassHome onAsk={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Best next move')).toBeTruthy());

    expect(screen.getByText('Rooftop DJ set')).toBeTruthy();
    expect(screen.getByText('Your circle')).toBeTruthy();
    expect(screen.getByText(/@mika/)).toBeTruthy();
    expect(screen.getByText('Starting soon')).toBeTruthy();
    expect(screen.getByText('Sunset run club')).toBeTruthy();
    expect(screen.getByText("Tonight's vibe")).toBeTruthy();
    expect(screen.getByText('2 events on tonight — music leads the night')).toBeTruthy();
    expect(screen.getByText("Tomorrow's window")).toBeTruthy();
    expect(screen.getByText('Sunny tomorrow — good window for outdoor plans')).toBeTruthy();
  });

  it('hides empty sections honestly (nulls render nothing)', async () => {
    mockFetchCompassHome.mockResolvedValue({
      ok: true,
      data: {
        compassEnabled: true, fallback: false, timeOfDay: 'morning', city: null,
        bestNextMove: null, circleActivity: null, startingSoon: null,
        tonightVibe: null, weatherWindow: null,
      },
    });
    await render(<CompassHome onAsk={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Good morning')).toBeTruthy());

    expect(screen.queryByText('Best next move')).toBeNull();
    expect(screen.queryByText('Your circle')).toBeNull();
    expect(screen.queryByText('Starting soon')).toBeNull();
    expect(screen.queryByText("Tonight's vibe")).toBeNull();
    expect(screen.queryByText("Tomorrow's window")).toBeNull();
    // Core actions remain available
    expect(screen.getByText('Surprise Me')).toBeTruthy();
  });

  it('navigates to the real event screen from a starting-soon row', async () => {
    mockFetchCompassHome.mockResolvedValue({ ok: true, data: FULL_HOME });
    await render(<CompassHome onAsk={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Sunset run club')).toBeTruthy());

    fireEvent.press(screen.getByText('Sunset run club'));
    expect(mockPush).toHaveBeenCalledWith('/event/ev-2');
  });

  it('renders no data cards on fallback response', async () => {
    mockFetchCompassHome.mockResolvedValue({
      ok: true,
      data: { compassEnabled: false, fallback: true },
    });
    await render(<CompassHome onAsk={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Welcome back')).toBeTruthy());

    expect(screen.queryByText('Best next move')).toBeNull();
    expect(screen.queryByText('Starting soon')).toBeNull();
    expect(screen.getByText('What should I do right now')).toBeTruthy();
  });
});
