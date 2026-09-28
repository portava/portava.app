/**
 * DiscoveryOutputKindsRail — the client asks for `01` §4's three output kinds
 * only behind the server's own flag (census-discovery §94, lane W11-X2;
 * §91.7 item 2; DC-01).
 *
 *   O1  flag OFF: nothing renders and NO request is sent (the For You tab is
 *       unchanged)
 *   O2  signed out, or emerging discoveries with no destination: no request
 *   O3  flag ON: the server's page, in the server's order
 *   O4  a failed read (503 → unavailable) is never silence: the browse list's
 *       no-rows sentence (register D-W10-S1-2)
 *   O5  an empty page, a 404 and a transport failure render nothing
 *   O6  ForYouTab renders the rail for all three kinds (wiring)
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
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

beforeEach(() => { jest.clearAllMocks(); mockFlags = {}; });

const trails = [{ id: 't2', title: 'Rooftops of Miami', destination: 'miami' }, { id: 't1', title: 'Beach mornings', destination: 'miami' }];

describe('DiscoveryOutputKindsRail (§94)', () => {
  it('O1 flag OFF: renders nothing and sends no request', async () => {
    mockGet.mockResolvedValue({ ok: true, kind: 'trails', rankedBy: 'pde', items: trails });
    const { toJSON } = await render(<DiscoveryOutputKindsRail kind="trails" destination="Miami" enabled />);
    await new Promise((r) => setTimeout(r, 20));
    expect(mockGet).not.toHaveBeenCalled();
    expect(toJSON()).toBeNull();
  });

  it('O2 signed out, or emerging discoveries with no destination: no request', async () => {
    mockFlags = { discovery_output_kinds_enabled: true };
    mockGet.mockResolvedValue({ ok: true, kind: 'trails', rankedBy: 'pde', items: trails });
    await render(<DiscoveryOutputKindsRail kind="trails" destination="Miami" enabled={false} />);
    await render(<DiscoveryOutputKindsRail kind="emerging_discoveries" destination={null} enabled />);
    await new Promise((r) => setTimeout(r, 20));
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("O3 flag ON: the server's page, in the server's order", async () => {
    mockFlags = { discovery_output_kinds_enabled: true };
    mockGet.mockResolvedValue({ ok: true, kind: 'trails', rankedBy: 'pde', items: trails });
    const { findByTestId, getAllByTestId, queryByText } = await render(<DiscoveryOutputKindsRail kind="trails" destination="Miami" enabled />);
    expect(await findByTestId('discovery-output-kind-trails')).toBeTruthy();
    expect(mockGet).toHaveBeenCalledWith('trails', { destination: 'Miami' });
    expect(getAllByTestId(/^discovery-output-kind-item-/).map((n) => n.props.testID)).toEqual(['discovery-output-kind-item-t2', 'discovery-output-kind-item-t1']);
    expect(queryByText('Rooftops of Miami')).not.toBeNull();
  });

  it('O4 a failed read is never silence: the browse list no-rows sentence', async () => {
    mockFlags = { discovery_output_kinds_enabled: true };
    mockGet.mockResolvedValue({ ok: false, reason: 'unavailable' });
    const { findByTestId, queryByText } = await render(<DiscoveryOutputKindsRail kind="trails" destination="Miami" enabled />);
    expect(await findByTestId('discovery-output-kind-trails-unavailable')).toBeTruthy();
    expect(queryByText('Some trails couldn’t be loaded just now')).not.toBeNull();
    expect(queryByText('This is on our side, not your filters. Try again in a moment.')).not.toBeNull();
  });

  for (const [name, answer] of [
    ['an empty page', { ok: true, kind: 'trails', rankedBy: 'pde', items: [] }],
    ['a 404 (flag off at the server)', { ok: false, reason: 'disabled' }],
    ['a transport failure', { ok: false, reason: 'network' }],
  ] as const) {
    it(`O5 ${name} renders nothing`, async () => {
      mockFlags = { discovery_output_kinds_enabled: true };
      mockGet.mockResolvedValue(answer);
      const { toJSON } = await render(<DiscoveryOutputKindsRail kind="trails" destination="Miami" enabled />);
      await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 10));
      expect(toJSON()).toBeNull();
    });
  }

  it('O6 ForYouTab renders the rail for all three kinds, gated on the viewer being signed in', () => {
    const src = readFileSync(join(__dirname, '..', 'ForYouTab.tsx'), 'utf8');
    expect(src).toContain("import { DiscoveryOutputKindsRail } from './DiscoveryOutputKindsRail.tsx';");
    expect(src).toContain("{(['trails', 'shared_moments', 'emerging_discoveries'] as const).map((k) => <DiscoveryOutputKindsRail key={k} kind={k} destination={destination} enabled={isAuthed} refreshKey={railRefreshKey} />)}");
  });
});
