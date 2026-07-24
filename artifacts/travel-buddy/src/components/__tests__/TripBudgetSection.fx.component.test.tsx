/**
 * FX converted band tests for TripBudgetSection.
 *
 * Covers:
 *   1. FX band is hidden when homeCurrency is not provided
 *   2. FX band is hidden when converted is null (same currency / flag off)
 *   3. FX band renders in the home currency label
 *   4. FX disclaimer is always rendered when the band is shown
 *   5. FX rate date is rendered when provided
 *   6. Source estimate header is still visible alongside the FX band
 *   7. fetchCostEstimateWithFx not called when estimate is null (flag off)
 *
 * Lives in its own file (two-file Modal rule).
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import { TripBudgetSection } from '../trip/TripBudgetSection.tsx';

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

jest.mock('../../services/tripIntel', () => ({
  ...jest.requireActual('../../services/tripIntel'),
  fetchCostEstimate:      jest.fn(),
  fetchCostEstimateWithFx: jest.fn(),
  fetchManualBudget:      jest.fn(),
  updateManualBudget:     jest.fn(),
  runBudgetSandbox:       jest.fn(),
}));

import {
  fetchCostEstimate,
  fetchCostEstimateWithFx,
  fetchManualBudget,
} from '../../services/tripIntel.ts';

const mockEst    = fetchCostEstimate    as jest.MockedFunction<typeof fetchCostEstimate>;
const mockFx     = fetchCostEstimateWithFx as jest.MockedFunction<typeof fetchCostEstimateWithFx>;
const mockBudget = fetchManualBudget    as jest.MockedFunction<typeof fetchManualBudget>;

const TRIP_ID = 'trip-fx-test';

const SOURCE_ESTIMATE = {
  available:   true,
  days:        5,
  tier:        'mid',
  currency:    'USD',
  perDay:      { low: 100, mid: 150, high: 220 },
  total:       { low: 500, mid: 750, high: 1100 },
  assumptions: [],
  confidence:  'high',
  lastVerifiedAt: null,
  disclaimer:  'Figures are estimates.',
};

const CONVERTED = {
  currency:    'EUR',
  perDay:      { low: 92, mid: 138, high: 203 },
  total:       { low: 460, mid: 690, high: 1015 },
  rateDate:    '2025-06-01',
  disclaimer:  'Indicative ECB rate — not guaranteed.',
};

const FX_RESPONSE = {
  estimate:  SOURCE_ESTIMATE,
  converted: CONVERTED,
};

describe('TripBudgetSection — FX band', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBudget.mockResolvedValue(null);
  });

  it('shows no FX band when homeCurrency is not provided', async () => {
    mockEst.mockResolvedValue(SOURCE_ESTIMATE);
    await render(
      <TripBudgetSection tripId={TRIP_ID} isOwnerOrCohost={false} isOwner={false} />
    );
    await waitFor(() => expect(screen.getByText(/AI cost estimate/i)).toBeTruthy());
    expect(screen.queryByText(/equivalent/i)).toBeNull();
    expect(mockFx).not.toHaveBeenCalled();
  });

  it('shows no FX band when fetchCostEstimateWithFx returns null converted', async () => {
    mockEst.mockResolvedValue(SOURCE_ESTIMATE);
    mockFx.mockResolvedValue({ estimate: SOURCE_ESTIMATE, converted: null });
    await render(
      <TripBudgetSection tripId={TRIP_ID} isOwnerOrCohost={false} isOwner={false} homeCurrency="EUR" />
    );
    await waitFor(() => expect(screen.getByText(/AI cost estimate/i)).toBeTruthy());
    expect(screen.queryByText(/equivalent/i)).toBeNull();
  });

  it('renders FX band in home currency when available', async () => {
    mockEst.mockResolvedValue(SOURCE_ESTIMATE);
    mockFx.mockResolvedValue(FX_RESPONSE);
    await render(
      <TripBudgetSection tripId={TRIP_ID} isOwnerOrCohost={false} isOwner={false} homeCurrency="EUR" />
    );
    await waitFor(() =>
      expect(screen.getByText(/EUR equivalent/i)).toBeTruthy()
    );
  });

  it('always renders FX disclaimer when band is shown', async () => {
    mockEst.mockResolvedValue(SOURCE_ESTIMATE);
    mockFx.mockResolvedValue(FX_RESPONSE);
    await render(
      <TripBudgetSection tripId={TRIP_ID} isOwnerOrCohost={false} isOwner={false} homeCurrency="EUR" />
    );
    await waitFor(() =>
      expect(screen.getByText(CONVERTED.disclaimer)).toBeTruthy()
    );
  });

  it('renders rate date when provided', async () => {
    mockEst.mockResolvedValue(SOURCE_ESTIMATE);
    mockFx.mockResolvedValue(FX_RESPONSE);
    await render(
      <TripBudgetSection tripId={TRIP_ID} isOwnerOrCohost={false} isOwner={false} homeCurrency="EUR" />
    );
    await waitFor(() =>
      expect(screen.getByText(/Rate:/i)).toBeTruthy()
    );
  });

  it('source estimate header is visible alongside the FX band', async () => {
    mockEst.mockResolvedValue(SOURCE_ESTIMATE);
    mockFx.mockResolvedValue(FX_RESPONSE);
    await render(
      <TripBudgetSection tripId={TRIP_ID} isOwnerOrCohost={false} isOwner={false} homeCurrency="EUR" />
    );
    // Source estimate header must remain
    await waitFor(() =>
      expect(screen.getByText(/AI cost estimate/i)).toBeTruthy()
    );
    // FX band is also present
    expect(screen.getByText(/EUR equivalent/i)).toBeTruthy();
  });

  it('does not call FX endpoint when estimate returns null (flag off)', async () => {
    mockEst.mockResolvedValue(null);
    await render(
      <TripBudgetSection tripId={TRIP_ID} isOwnerOrCohost={false} isOwner={false} homeCurrency="EUR" />
    );
    await waitFor(() => expect(mockEst).toHaveBeenCalled());
    expect(screen.toJSON()).toBeNull();
    expect(mockFx).not.toHaveBeenCalled();
  });
});
