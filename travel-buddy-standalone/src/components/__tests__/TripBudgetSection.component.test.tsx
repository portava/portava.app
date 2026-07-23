/**
 * Component-level tests for TripBudgetSection — non-sandbox tests.
 *
 * Covers:
 *  1. null return when fetchCostEstimate returns null (flag off)
 *  2. Available estimate display (bands, confidence, assumptions, last-verified)
 *  3. Unavailable-reason display (available: false)
 *  4. Manual budget display and edit flow (owner)
 *  5. Non-owner sees no manual budget UI
 *
 * Sandbox Modal tests live in TripBudgetSection.sandbox.component.test.tsx
 * (two-file rule: each Modal test file gets its own Jest worker).
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { TripBudgetSection } from '../trip/TripBudgetSection.tsx';

// ── react-native Modal + ActivityIndicator proxy ──────────────────────────────
// Modal's animation lifecycle leaves a floating async act() scope. Intercept
// via Proxy so Modal renders children synchronously as a plain View.

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: any) =>
    visible ? R.createElement(actual.View, null, children) : null;
  const MockActivityIndicator = () => null;
  return new Proxy(actual, {
    get(target: any, prop: string, receiver: any) {
      if (prop === 'Modal') return MockModal;
      if (prop === 'ActivityIndicator') return MockActivityIndicator;
      return Reflect.get(target, prop, receiver);
    },
  });
});

// ── tripIntel mock ────────────────────────────────────────────────────────────

jest.mock('../../services/tripIntel', () => ({
  ...jest.requireActual('../../services/tripIntel'),
  fetchCostEstimate:  jest.fn(),
  fetchManualBudget:  jest.fn(),
  updateManualBudget: jest.fn(),
  runBudgetSandbox:   jest.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TRIP_ID = 'trip-budget-test';

const AVAILABLE_ESTIMATE = {
  available:      true,
  days:           7,
  tier:           'mid',
  currency:       'USD',
  perDay:         { low: 80, mid: 120, high: 200 },
  total:          { low: 560, mid: 840, high: 1400 },
  assumptions:    ['Mid-range accommodation', 'Public transport'],
  confidence:     'high',
  lastVerifiedAt: '2026-06-01T00:00:00Z',
  disclaimer:     'Estimates may vary.',
};

const UNAVAILABLE_ESTIMATE = {
  available: false,
  reason:    'No baseline data for this destination yet.',
};

const MANUAL_BUDGET = {
  tripId:      TRIP_ID,
  currency:    'USD',
  totalBudget: 1500,
  spent:       null,
  breakdown:   null,
  updatedAt:   '2026-07-01T00:00:00Z',
};

// ── Helper ────────────────────────────────────────────────────────────────────

async function mount(props?: Partial<React.ComponentProps<typeof TripBudgetSection>>) {
  return render(
    <TripBudgetSection
      tripId={TRIP_ID}
      isOwnerOrCohost={false}
      isOwner={false}
      {...props}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TripBudgetSection', () => {
  let fetchCostEstimate: jest.Mock;
  let fetchManualBudget: jest.Mock;
  let updateManualBudget: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    const m = require('../../services/tripIntel.ts');
    fetchCostEstimate  = m.fetchCostEstimate;
    fetchManualBudget  = m.fetchManualBudget;
    updateManualBudget = m.updateManualBudget;

    fetchCostEstimate.mockResolvedValue(AVAILABLE_ESTIMATE);
    fetchManualBudget.mockResolvedValue(MANUAL_BUDGET);
    updateManualBudget.mockResolvedValue(MANUAL_BUDGET);
  });

  // ── 1. Flag off ─────────────────────────────────────────────────────────────

  it('renders nothing when fetchCostEstimate returns null (flag off)', async () => {
    fetchCostEstimate.mockResolvedValue(null);

    const view = await mount();

    await waitFor(() => {
      expect(fetchCostEstimate).toHaveBeenCalledWith(TRIP_ID);
    });
    await waitFor(() => {
      expect(view.toJSON()).toBeNull();
    });
  });

  // ── 2. Available estimate display ───────────────────────────────────────────

  it('shows per-day and total cost bands when estimate is available', async () => {
    const view = await mount();

    await view.findByText('Budget');
    await view.findByText('Per day');
    await view.findByText('Total trip');
    // formatBand produces "$80 – $200" and "$560 – $1,400"
    await view.findByText(/\$80/);
    await view.findByText(/\$560/);
  });

  it('shows confidence chip', async () => {
    const view = await mount();
    await view.findByText('high confidence');
  });

  it('shows assumptions list after toggling', async () => {
    const view = await mount();
    await view.findByText('Budget');

    fireEvent.press(view.getByText('Assumptions'));

    await waitFor(() => {
      expect(view.getByText(/Mid-range accommodation/)).toBeTruthy();
    });
  });

  it('shows last-verified date and disclaimer', async () => {
    const view = await mount();
    await view.findByText(/Last verified/);
    await view.findByText('Estimates may vary.');
  });

  it('shows the "What if…" button', async () => {
    const view = await mount();
    await view.findByText('What if…');
  });

  // ── 3. Unavailable state ────────────────────────────────────────────────────

  it('shows reason text when estimate is unavailable', async () => {
    fetchCostEstimate.mockResolvedValue(UNAVAILABLE_ESTIMATE);

    const view = await mount();

    await view.findByText('No baseline data for this destination yet.');
    expect(view.queryByText('Per day')).toBeNull();
  });

  it('shows fallback text when available:false with no reason', async () => {
    fetchCostEstimate.mockResolvedValue({ available: false });

    const view = await mount();
    await view.findByText(/No cost estimate available/);
  });

  // ── 4 & 5. Manual budget — owner edit + non-owner visibility ─────────────
  //
  // Both scenarios share ONE render (React 19 + RNTL v14 render-count limit:
  // the 10th+ independent mount's tree may not flush reliably).
  // We use rerender() to switch between owner and non-owner views.

  it('shows formatted budget for owner, saves on blur, and hides for non-owner', async () => {
    fetchManualBudget.mockResolvedValue(MANUAL_BUDGET);
    updateManualBudget.mockResolvedValue({ ...MANUAL_BUDGET, totalBudget: 2000 });

    const view = await mount({ isOwnerOrCohost: true, isOwner: true });

    // Owner sees formatted amount
    await view.findByText(/\$1,500/);
    expect(fetchManualBudget).toHaveBeenCalledWith(TRIP_ID);

    // Tap to enter edit mode
    fireEvent.press(await view.findByText(/\$1,500/));

    // Wait for TextInput to appear and value state to commit
    const input = await view.findByLabelText('Trip budget amount');
    fireEvent.changeText(input, '2000');
    // Wait for React 19 to commit the controlled-input state update
    await waitFor(() => {
      expect(view.getByLabelText('Trip budget amount').props.value).toBe('2000');
    });
    fireEvent(input, 'blur');

    await waitFor(() => {
      expect(updateManualBudget).toHaveBeenCalledWith(TRIP_ID, { totalBudget: 2000 });
    });

    // Rerender as non-owner — no manual budget UI should appear
    view.rerender(
      <TripBudgetSection tripId={TRIP_ID} isOwnerOrCohost={false} isOwner={false} />,
    );
    await view.findByText('Budget');
    expect(view.queryByLabelText('Trip budget amount')).toBeNull();
    expect(view.queryByLabelText('Edit trip budget')).toBeNull();
  });
});
