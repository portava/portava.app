/**
 * TripHeartbeatCard component tests (Phase 13 Trip Autopilot).
 *
 * Verifies:
 *  - renders health status + concrete issue reasons from the heartbeat
 *  - pending proposals render with Apply / Keep-as-is actions
 *  - confirming a proposal calls the resolve service with 'confirm'
 *  - hidden entirely when Compass is disabled (honest fallback)
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';

const mockFetchHeartbeat = jest.fn();
const mockRunCheck = jest.fn();
const mockFetchProposals = jest.fn();
const mockResolve = jest.fn();

// NOTE: intentionally exhaustive — TripHeartbeatCard imports exactly these four
// functions; requireActual would drag in supabase/env config into the jest env.
jest.mock('../../../services/compass', () => ({
  fetchTripHeartbeat: (...a: unknown[]) => mockFetchHeartbeat(...a),
  runTripAutopilotCheck: (...a: unknown[]) => mockRunCheck(...a),
  fetchAutopilotProposals: (...a: unknown[]) => mockFetchProposals(...a),
  resolveAutopilotProposal: (...a: unknown[]) => mockResolve(...a),
}));

import { TripHeartbeatCard } from '../TripHeartbeatCard.tsx';

const HEARTBEAT = {
  status: 'at_risk',
  issues: [
    {
      type: 'timing_conflict',
      severity: 'high',
      itemIds: ['i1', 'i2'],
      reason: '"Harbor tour" ends 17:30, "Dinner" starts 18:00 — only 30 min gap but getting there takes about 40 min.',
    },
  ],
  risks: [{ type: 'weather', label: 'Rain on 2026-07-22', detail: 'Rain, 12 mm — plans that day may need an indoor backup.' }],
  pendingProposals: 1,
  itemCounts: { fixed: 1, flexible: 2, optional: 0, total: 3 },
  nextItem: { id: 'i1', title: 'Harbor tour', startsAt: null, dayDate: null },
};

const PROPOSAL = {
  id: 'prop-1',
  issueType: 'timing_conflict',
  severity: 'attention',
  reason: 'Suggest starting "Dinner" 40 min later.',
  changes: [],
  status: 'pending',
  createdAt: '2026-07-21T00:00:00Z',
  resolvedAt: null,
};

describe('TripHeartbeatCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchHeartbeat.mockResolvedValue({ ok: true, compassEnabled: true, heartbeat: HEARTBEAT });
    mockFetchProposals.mockResolvedValue({ ok: true, proposals: [PROPOSAL] });
    mockResolve.mockResolvedValue({ ok: true, applied: 1, blocked: [] });
  });

  it('renders status, issue reasons, risks, and a pending proposal', async () => {
    await render(<TripHeartbeatCard tripId="trip-1" />);
    await waitFor(() => expect(screen.getByTestId('trip-heartbeat-card')).toBeTruthy());
    expect(screen.getByText('At risk')).toBeTruthy();
    expect(screen.getByText(/Harbor tour.*40 min/)).toBeTruthy();
    expect(screen.getByText(/Rain on 2026-07-22/)).toBeTruthy();
    expect(screen.getByTestId('autopilot-proposal-prop-1')).toBeTruthy();
    expect(screen.getByText(/Suggest starting "Dinner"/)).toBeTruthy();
  });

  it('confirming a proposal calls resolve with confirm', async () => {
    await render(<TripHeartbeatCard tripId="trip-1" />);
    await waitFor(() => expect(screen.getByTestId('autopilot-confirm-prop-1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('autopilot-confirm-prop-1'));
    await waitFor(() => expect(mockResolve).toHaveBeenCalledWith('prop-1', 'confirm'));
  });

  it('renders nothing when Compass is disabled', async () => {
    mockFetchHeartbeat.mockResolvedValue({ ok: true, compassEnabled: false });
    await render(<TripHeartbeatCard tripId="trip-1" />);
    await waitFor(() => expect(screen.queryByTestId('trip-heartbeat-card')).toBeNull());
  });
});
