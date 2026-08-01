/**
 * Component tests for TripCard — status badge derivation.
 *
 * Confirms that TripCard calls `deriveTripDisplayStatus` before rendering
 * the badge, so the displayed label reflects the trip's actual temporal
 * state rather than a possibly-stale stored `status` column.
 *
 * Run with:  pnpm test:component
 *
 * RNTL v14: render() is async — always await the mount helper.
 */

import React from 'react';
import { render } from '@testing-library/react-native';
import { TripCard } from '../TripCard.tsx';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — real hook calls useLocation + AsyncStorage;
// spreading requireActual loads the Supabase client and crashes the runner.
jest.mock('../../../hooks/useEntityHeaderImage', () => ({
  useEntityHeaderImage: () => null,
}));

// NOTE: intentionally exhaustive — real CachedImage pulls expo-image native
// module unavailable in jest-expo; null render is the correct no-op stub.
jest.mock('../../CachedImage', () => ({
  CachedImage: () => null,
}));

// NOTE: intentionally exhaustive — real tokens file imports StyleSheet from
// react-native and computes values at module load; partial spread would pull
// in transitive native modules that crash the jest-expo runner.
jest.mock('../../../theme/tokens', () => ({
  color: {
    deep:        '#2A7F8F',
    ink:         '#1A1A2E',
    signal:      '#FF6B6B',
    mute:        '#9B9B9B',
    success:     '#22C55E',
    faint:       '#F3F4F6',
    paper:       '#FFFFFF',
    paperRaised: '#F9F9F9',
    haze:        '#E8E8E8',
    onInk:       '#FFFFFF',
  },
  space:      { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  radius:     { sm: 4, md: 8, lg: 12, pill: 999 },
  shadow:     { card: {} },
  typography: {
    label:    {},
    metadata: {},
    cardTitle: {},
    caption:  {},
  },
  layout: { pressedOpacity: 0.7 },
}));

// ── Shared fixture factory ─────────────────────────────────────────────────────

function makeProps(overrides: Partial<React.ComponentProps<typeof TripCard>> = {}) {
  return {
    id:                 'trip-1',
    title:              'Test Trip',
    destinationCity:    'Rome',
    destinationCountry: 'Italy',
    startDate:          '2025-06-01',
    endDate:            '2025-06-10',
    status:             'active',
    coverUrl:           null,
    memberCount:        null,
    onPress:            jest.fn(),
    ...overrides,
  } as React.ComponentProps<typeof TripCard>;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('TripCard — status badge derivation', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows COMPLETED when endDate is in the past even if stored status is "active"', async () => {
    // endDate well before today (2026-07-30) — should override stored 'active'.
    const { getByText } = await render(
      <TripCard {...makeProps({ status: 'active', endDate: '2025-01-01' })} />,
    );
    expect(getByText('COMPLETED')).toBeTruthy();
  });

  it('shows UPCOMING when endDate is in the future and stored status is "upcoming"', async () => {
    // endDate well after today — stored status should pass through unchanged.
    const { getByText } = await render(
      <TripCard {...makeProps({ status: 'upcoming', endDate: '2027-12-31' })} />,
    );
    expect(getByText('UPCOMING')).toBeTruthy();
  });

  it('shows CANCELLED regardless of endDate — terminal state is never overridden', async () => {
    // Cancelled is a terminal state; even a past endDate must not flip it to COMPLETED.
    const { getByText } = await render(
      <TripCard {...makeProps({ status: 'cancelled', endDate: '2025-01-01' })} />,
    );
    expect(getByText('CANCELLED')).toBeTruthy();
  });
});
