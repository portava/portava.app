/**
 * §24 / Table-32 intel dashboards — rendered behaviour.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * The rule the whole surface exists for: a figure the server did not measure
 * reaches the screen as the words "Not instrumented", NEVER as a zero — while a
 * genuinely measured zero still renders as 0. Asserted against the rendered
 * tree, not against the formatter, so a screen that bypassed the formatter would
 * fail here.
 *
 * Also covered: each of the four screens renders its own Table-32 section; the
 * density-gate line reports "not certifiable" when it is not; and a failed load
 * shows an announced error banner instead of an empty dashboard that would read
 * as "everything is zero".
 */

import React from 'react';
import { render, waitFor, screen } from '@testing-library/react-native';

// ── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../../src/hooks/useRequireAdmin', () => ({
  ...jest.requireActual('../../../src/hooks/useRequireAdmin'),
  useRequireAdmin: jest.fn(),
}));

jest.mock('../../../src/context/SessionContext', () => ({
  ...jest.requireActual('../../../src/context/SessionContext'),
  useSession: () => ({ isAuthed: true, loading: false }),
}));

jest.mock('../../../src/services/adminApi', () => ({
  ...jest.requireActual('../../../src/services/adminApi'),
  adminGet: jest.fn(),
}));

import { adminGet } from '../../../src/services/adminApi';
import IntelTruthHealthScreen from '../intel-truth-health';
import IntelCalibrationScreen from '../intel-calibration';
import IntelDecisionScreen from '../intel-decision';
import IntelEconomyScreen from '../intel-economy';

const mockGet = adminGet as jest.Mock;

function section(key: string, title: string, metrics: unknown[], distributions: unknown[] = []) {
  return { key, title, requiredMetrics: `Table 32 line for ${key}`, metrics, distributions };
}

function metric(over: Record<string, unknown>) {
  return { key: 'k', label: 'Label', status: 'MEASURED', value: 1, denominator: null, unit: 'count', note: null, ...over };
}

const REPORT = {
  schemaVersion: 1,
  generatedAt: '2026-09-05T12:00:00.000Z',
  windowDays: 7,
  sections: [
    section('truth_health', 'Truth health', [
      metric({ key: 'servableLiveSnapshots', label: 'Fresh claim coverage', value: 0, denominator: 0 }),
      metric({ key: 'expiryLatencySeconds', label: 'Expiry latency', status: 'UNINSTRUMENTED', value: null, note: 'No serve-time log exists.' }),
    ], [
      { key: 'claimStatus', label: 'Claims by status', status: 'MEASURED', buckets: [{ key: 'active', count: 2 }], unknownValues: [], note: null },
    ]),
    section('calibration', 'Calibration', [
      metric({ key: 'activeContributorsCitywide', label: 'Active contributors citywide', status: 'UPPER_BOUND', value: 4, note: 'Reliability is not modelled.' }),
      metric({ key: 'crowdCalibrationAccuracy', label: 'Crowd-state calibration accuracy', status: 'UNINSTRUMENTED', value: null, note: 'No after-proof value.' }),
    ]),
    section('decision', 'Decision', [
      metric({ key: 'arrivalSuccess', label: 'Arrival success', value: 3, denominator: 4 }),
      metric({ key: 'rerouteRecovery', label: 'Reroute recovery', status: 'UNINSTRUMENTED', value: null, note: 'No reroute is recorded.' }),
    ]),
    section('economy', 'Economy', [
      metric({ key: 'fundedCashPayouts', label: 'Funded payouts (cash)', value: 0, note: 'Structurally zero.' }),
      metric({ key: 'apiMargin', label: 'API margin', status: 'UNINSTRUMENTED', value: null, note: 'No cost basis recorded.' }),
    ]),
  ],
  densityGate: { met: false, certifiable: false, failures: ['weekly_observations'], uninstrumented: ['crowdCalibrationAccuracy'], upperBound: [] },
};

describe('intel observability dashboards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({ ok: true, data: REPORT });
  });

  it('truth health: an uninstrumented metric renders as words, and no digit', async () => {
    await render(<IntelTruthHealthScreen />);
    await waitFor(() => expect(screen.getByTestId('intel-metric-value-expiryLatencySeconds')).toBeTruthy());
    const value = screen.getByTestId('intel-metric-value-expiryLatencySeconds');
    const text = value.props.children as string;
    expect(text).toBe('Not instrumented');
    expect(/\d/.test(text)).toBe(false);
  });

  it('truth health: a MEASURED zero still renders as a figure — 0 of 0, not "not instrumented"', async () => {
    await render(<IntelTruthHealthScreen />);
    await waitFor(() => expect(screen.getByTestId('intel-metric-value-servableLiveSnapshots')).toBeTruthy());
    expect(screen.getByTestId('intel-metric-value-servableLiveSnapshots').props.children).toBe('0 of 0');
  });

  it('truth health: renders its own section and warns how many figures are absent', async () => {
    await render(<IntelTruthHealthScreen />);
    await waitFor(() => expect(screen.getByTestId('intel-absent-banner')).toBeTruthy());
    expect(screen.getByTestId('intel-metric-servableLiveSnapshots')).toBeTruthy();
    expect(screen.getByTestId('intel-distribution-claimStatus')).toBeTruthy();
    // Another section's metric must NOT appear on this screen.
    expect(screen.queryByTestId('intel-metric-apiMargin')).toBeNull();
  });

  it('calibration: an UPPER_BOUND figure is shown but badged, never as a measurement', async () => {
    await render(<IntelCalibrationScreen />);
    await waitFor(() => expect(screen.getByTestId('intel-metric-value-activeContributorsCitywide')).toBeTruthy());
    expect(screen.getByTestId('intel-metric-value-activeContributorsCitywide').props.children).toBe('4');
    expect(screen.getByText('Upper bound')).toBeTruthy();
    expect(screen.getByTestId('intel-metric-value-crowdCalibrationAccuracy').props.children).toBe('Not instrumented');
  });

  it('calibration: the density gate reports "not certifiable" rather than a green light', async () => {
    await render(<IntelCalibrationScreen />);
    await waitFor(() => expect(screen.getByTestId('intel-density-gate')).toBeTruthy());
    expect(screen.getByTestId('intel-density-gate').props.children).toMatch(/not met/);
  });

  it('decision: reroute recovery is absent, and arrival success shows its denominator', async () => {
    await render(<IntelDecisionScreen />);
    await waitFor(() => expect(screen.getByTestId('intel-metric-value-arrivalSuccess')).toBeTruthy());
    expect(screen.getByTestId('intel-metric-value-arrivalSuccess').props.children).toBe('3 of 4');
    expect(screen.getByTestId('intel-metric-value-rerouteRecovery').props.children).toBe('Not instrumented');
  });

  it('economy: the structural cash zero stays a figure while API margin stays absent', async () => {
    await render(<IntelEconomyScreen />);
    await waitFor(() => expect(screen.getByTestId('intel-metric-value-fundedCashPayouts')).toBeTruthy());
    expect(screen.getByTestId('intel-metric-value-fundedCashPayouts').props.children).toBe('0');
    expect(screen.getByTestId('intel-metric-value-apiMargin').props.children).toBe('Not instrumented');
  });

  it('a failed load shows an announced error banner, not an all-zero dashboard', async () => {
    mockGet.mockResolvedValue({ ok: false, error: 'HTTP 500' });
    await render(<IntelTruthHealthScreen />);
    await waitFor(() => expect(screen.getByTestId('intel-observability-error')).toBeTruthy());
    const banner = screen.getByTestId('intel-observability-error');
    expect(banner.props.accessibilityRole).toBe('alert');
    expect(banner.props.accessibilityLiveRegion).toBe('assertive');
    expect(screen.getByText('HTTP 500')).toBeTruthy();
    expect(screen.queryByTestId('intel-metric-servableLiveSnapshots')).toBeNull();
  });

  it('requests the internal observability endpoint with an explicit window', async () => {
    await render(<IntelEconomyScreen />);
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(mockGet).toHaveBeenCalledWith('/api/v1/internal/intel/observability?windowDays=7');
  });
});
