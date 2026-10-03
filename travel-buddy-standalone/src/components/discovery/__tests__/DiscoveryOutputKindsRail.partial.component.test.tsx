/**
 * census-discovery §105 (DV-83 round 9, register D-W11X2-60): the output-kinds rail
 * says a PARTIAL page (a refusal with `coverage: "partial"` beside real rows).
 *
 *   OP1  partial rows: the rows are kept AND the browse list's partial line is shown
 *   OP2  CONTROL: a complete page shows no partial line
 *   OP3  a later complete page clears the partial line
 *   OP4  a partial page with NO rows is the failed state, never silence
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { DiscoveryOutputKindsRail } from '../DiscoveryOutputKindsRail.tsx';

let mockFlags: Record<string, boolean> = {};
// NOTE: intentionally exhaustive — the provider fetches /api/feature-flags;
// this file sets the flags directly.
jest.mock('../../../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (k: string) => mockFlags[k] === true, isLivePlacesEnabled: () => false, loading: false }),
}));

const mockGet = jest.fn();
jest.mock('../../../services/discoveryRecommendations', () => ({
  ...jest.requireActual('../../../services/discoveryRecommendations'),
  getOutputKindRecommendations: (...args: unknown[]) => mockGet(...(args as [])),
}));

beforeEach(() => { jest.clearAllMocks(); mockFlags = { discovery_output_kinds_enabled: true }; });

const trails = [{ id: 't1', title: 'Beach mornings', destination: 'miami' }];
const PARTIAL = 'Some trails couldn’t be loaded just now, so this list may be incomplete.';

describe('DiscoveryOutputKindsRail partial (§105)', () => {
  it('OP1 partial rows are kept and said to be partial', async () => {
    mockGet.mockResolvedValue({ ok: true, kind: 'trails', rankedBy: 'pde', items: trails, partial: true });
    const { findByTestId, queryByText, queryByTestId } = await render(<DiscoveryOutputKindsRail kind="trails" destination="Miami" enabled />);
    expect(await findByTestId('discovery-output-kind-item-t1')).toBeTruthy();
    expect(queryByText(PARTIAL)).not.toBeNull();
    expect(queryByTestId('discovery-output-kind-trails-partial')).not.toBeNull();
  });

  it('OP2 CONTROL: a complete page shows no partial line', async () => {
    mockGet.mockResolvedValue({ ok: true, kind: 'trails', rankedBy: 'pde', items: trails });
    const { findByTestId, queryByText } = await render(<DiscoveryOutputKindsRail kind="trails" destination="Miami" enabled />);
    expect(await findByTestId('discovery-output-kind-item-t1')).toBeTruthy();
    expect(queryByText(PARTIAL)).toBeNull();
  });

  it('OP3 a later complete page clears the partial line', async () => {
    mockGet.mockResolvedValueOnce({ ok: true, kind: 'trails', rankedBy: 'pde', items: trails, partial: true });
    const view = await render(<DiscoveryOutputKindsRail kind="trails" destination="Miami" enabled refreshKey={0} />);
    await waitFor(() => expect(view.queryByText(PARTIAL)).not.toBeNull());
    mockGet.mockResolvedValueOnce({ ok: true, kind: 'trails', rankedBy: 'pde', items: trails });
    await view.rerender(<DiscoveryOutputKindsRail kind="trails" destination="Miami" enabled refreshKey={1} />);
    await waitFor(() => expect(view.queryByText(PARTIAL)).toBeNull());
    expect(view.queryByTestId('discovery-output-kind-item-t1')).not.toBeNull();
  });

  it('OP4 a partial page with no rows is the failed state, never silence', async () => {
    mockGet.mockResolvedValue({ ok: true, kind: 'trails', rankedBy: 'pde', items: [], partial: true });
    const { findByTestId } = await render(<DiscoveryOutputKindsRail kind="trails" destination="Miami" enabled />);
    expect(await findByTestId('discovery-output-kind-trails-unavailable')).toBeTruthy();
  });
});
