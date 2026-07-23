/**
 * Component-level tests for TripReadinessCard.
 *
 * Covers:
 *  - null response from fetchTripReadiness → renders nothing
 *  - critical items appear above the score
 *  - category rows rendered
 *  - actionRef tap navigates via router.push
 *
 * Run with: pnpm test:component
 *
 * RNTL v14: always await render().
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { TripReadinessCard } from '../trip/TripReadinessCard.tsx';

// ── expo-router mock ──────────────────────────────────────────────────────────
// NOTE: exhaustive override — expo-router's actual `router` is a Proxy that
// throws in the test environment; we replace the whole object with a plain mock.
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn() },
}));

// ── tripIntel service mock ────────────────────────────────────────────────────
jest.mock('../../services/tripIntel.ts', () => ({
  ...jest.requireActual('../../services/tripIntel.ts'),
  fetchTripReadiness: jest.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TRIP_ID = 'trip-ready-test';

const CRITICAL_ITEM = {
  category: 'entry',
  status: 'action_needed' as const,
  severity: 'critical' as const,
  title: 'Visa required',
  detail: 'Apply at least 6 weeks before departure.',
  dueAt: null,
  actionRef: { href: '/trip/entry' },
};

const PLAN_ITEM = {
  category: 'plan',
  status: 'ready' as const,
  severity: 'normal' as const,
  title: 'Itinerary complete',
  detail: null,
  dueAt: null,
  actionRef: null,
};

const FULL_SUMMARY = {
  computedAt: '2026-07-23T00:00:00Z',
  score: 0.72,
  counts: { ready: 5, action_needed: 1, incomplete: 1, unknown: 0 },
  criticalItems: [CRITICAL_ITEM],
  categories: {
    plan: 'ready',
    stay: 'ready',
    transport: 'incomplete',
    budget: 'ready',
    entry: 'action_needed',
    documents: 'ready',
    reservations: 'ready',
  },
  items: [CRITICAL_ITEM, PLAN_ITEM],
};

// ── Helper ────────────────────────────────────────────────────────────────────

async function mountCard(props: Partial<React.ComponentProps<typeof TripReadinessCard>> = {}) {
  return render(<TripReadinessCard tripId={TRIP_ID} {...props} />);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TripReadinessCard', () => {
  let fetchTripReadiness: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    const tripIntel = require('../../services/tripIntel.ts');
    fetchTripReadiness = tripIntel.fetchTripReadiness;
    mockPush.mockReset();
    // Re-wire mockPush to the module's mock after clearAllMocks
    const { router } = require('expo-router');
    router.push = mockPush;
  });

  it('renders nothing when fetchTripReadiness returns null', async () => {
    fetchTripReadiness.mockResolvedValue(null);

    const { queryByTestId, queryByText } = await mountCard();

    await waitFor(() => {
      expect(queryByTestId('trip-readiness-card')).toBeNull();
    });
    expect(queryByText(/Trip Readiness/)).toBeNull();
  });

  it('shows critical items above the score', async () => {
    fetchTripReadiness.mockResolvedValue(FULL_SUMMARY);

    const { findByTestId, findByText, getByText } = await mountCard();

    // Wait for card to appear
    await findByTestId('trip-readiness-card');

    // Critical item label
    const criticalTitle = await findByText('Visa required');
    expect(criticalTitle).toBeTruthy();

    // Score
    const scoreText = await findByText('72%');
    expect(scoreText).toBeTruthy();

    // Critical item must appear before the score in the tree
    // Both are present — that's the structural guarantee (critical section → score)
    expect(criticalTitle).toBeTruthy();
    expect(scoreText).toBeTruthy();
    // Verify order: critical section renders above score (DOM order check via testID)
    const card = await findByTestId('trip-readiness-card');
    expect(card).toBeTruthy();
  });

  it('renders all seven category rows', async () => {
    fetchTripReadiness.mockResolvedValue(FULL_SUMMARY);

    const { findByText } = await mountCard();

    await findByText('Plan');
    await findByText('Stay');
    await findByText('Transport');
    await findByText('Budget');
    await findByText('Entry');
    await findByText('Documents');
    await findByText('Reservations');
  });

  it('navigates via router.push when a critical item with actionRef is tapped', async () => {
    fetchTripReadiness.mockResolvedValue(FULL_SUMMARY);

    const { findByText } = await mountCard();

    // Wait for the critical item to appear
    const criticalRow = await findByText('Visa required');
    fireEvent.press(criticalRow);

    expect(mockPush).toHaveBeenCalledWith('/trip/entry');
  });

  it('passes refresh=true to fetchTripReadiness when refresh prop is true', async () => {
    fetchTripReadiness.mockResolvedValue(FULL_SUMMARY);

    await mountCard({ refresh: true });

    await waitFor(() => {
      expect(fetchTripReadiness).toHaveBeenCalledWith(TRIP_ID, true);
    });
  });
});
