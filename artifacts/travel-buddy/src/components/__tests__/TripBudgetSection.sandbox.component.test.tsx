/**
 * Sandbox sheet tests for TripBudgetSection.
 *
 * Separated per the two-file rule: async Modal tests must run in
 * isolated Jest workers to avoid shared actScopeDepth corruption.
 *
 * Only TWO `await render(...)` calls in this file (render-count limit —
 * the 3rd+ mount's tree does not flush reliably under React 19 + RNTL v14).
 * Tests 2 & 3 reuse ONE render with chained assertions.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { TripBudgetSection } from '../trip/TripBudgetSection.tsx';

// ── react-native Modal + ActivityIndicator proxy ──────────────────────────────

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

const TRIP_ID = 'trip-sandbox-test';

const AVAILABLE_ESTIMATE = {
  available:   true,
  currency:    'USD',
  perDay:      { low: 80, mid: 120, high: 200 },
  total:       { low: 560, mid: 840, high: 1400 },
  confidence:  'medium',
  assumptions: [],
};

// Shape mirrors SandboxResultAvailable from tripIntel.ts (backend: json.sandbox)
const SANDBOX_RESULT = {
  available:           true,
  days:                9,
  dailySpend:          { low: 80, mid: 120, high: 200 },
  total:               { low: 720, mid: 1080, high: 1800 },
  budget:              null,
  fitsBudget:          null,
  gap:                 null,
  suggestions:         [],
  protectedCategories: [],
  notes:               [],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TripBudgetSection — sandbox sheet', () => {
  let fetchCostEstimate: jest.Mock;
  let fetchManualBudget: jest.Mock;
  let runBudgetSandbox: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    const m = require('../../services/tripIntel.ts');
    fetchCostEstimate = m.fetchCostEstimate;
    fetchManualBudget = m.fetchManualBudget;
    runBudgetSandbox  = m.runBudgetSandbox;

    fetchCostEstimate.mockResolvedValue(AVAILABLE_ESTIMATE);
    fetchManualBudget.mockResolvedValue(null);
    runBudgetSandbox.mockResolvedValue(SANDBOX_RESULT);
  });

  // Render 1 — open-only assertion
  it('opens sandbox sheet when "What if…" is pressed', async () => {
    const view = await render(
      <TripBudgetSection tripId={TRIP_ID} isOwnerOrCohost={false} isOwner={false} />,
    );

    const whatIfBtn = await view.findByText('What if…');
    fireEvent.press(whatIfBtn);

    await waitFor(() => {
      expect(view.getByText('Run scenario')).toBeTruthy();
    });
  });

  // Render 2 — run with params → result bands, then reset → null result → error path.
  // Both sandbox scenarios share ONE render (render-count limit for RNTL v14 + React 19).
  it('runs sandbox scenario with extra-days and shows result; shows error on null result', async () => {
    runBudgetSandbox.mockResolvedValue(SANDBOX_RESULT);

    const view = await render(
      <TripBudgetSection tripId={TRIP_ID} isOwnerOrCohost={false} isOwner={false} />,
    );

    // ── Step 1: open the sandbox sheet ──────────────────────────────────────
    const whatIfBtn = await view.findByText('What if…');
    fireEvent.press(whatIfBtn);
    await waitFor(() => view.getByLabelText('Extra days'));

    // ── Step 2: enter extra-days value and wait for controlled-input commit ──
    fireEvent.changeText(view.getByLabelText('Extra days'), '2');
    // Wait for React 19 to commit the state update before pressing Run
    await waitFor(() => {
      expect(view.getByLabelText('Extra days').props.value).toBe('2');
    });

    // ── Step 3: run and verify call args + result bands ─────────────────────
    fireEvent.press(view.getByText('Run scenario'));

    await waitFor(() => {
      expect(runBudgetSandbox).toHaveBeenCalledWith(TRIP_ID, { extraDays: 2 });
    });

    await view.findByText('Scenario result');
    // total.low = $720 is unique to the sandbox result (estimate total starts at $560)
    await view.findByText(/\$720/);

    // ── Step 4: switch mock to null and run again → error message ───────────
    runBudgetSandbox.mockResolvedValue(null);
    // Clear extra-days so params are empty (null result even with no params)
    fireEvent.changeText(view.getByLabelText('Extra days'), '');
    await waitFor(() => {
      expect(view.getByLabelText('Extra days').props.value).toBe('');
    });

    fireEvent.press(view.getByText('Run scenario'));

    await waitFor(() => {
      expect(view.getByText(/Could not run scenario/)).toBeTruthy();
    });
  });
});
