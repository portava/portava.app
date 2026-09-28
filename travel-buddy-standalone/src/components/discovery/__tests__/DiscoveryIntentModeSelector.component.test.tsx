/**
 * DiscoveryIntentModeSelector — the Discovery screen's intent-mode selector.
 * census-discovery §71 (lane P31), rows A05 and DV-42.
 *
 * WHAT IS PINNED
 *   1. It is shown ONLY when the server reports the capability
 *      (`discovery_live_rank_enabled`, migration 2850) through the app's own
 *      flag read (FeatureFlagsContext → GET /api/feature-flags). Capability
 *      unknown — no provider, a failed read, the flag absent, the flag FALSE —
 *      is hidden. That is the fail-safe: with 2850 off the server ignores the
 *      mode, so a selector would be decorative (DSV2-03: "UI selection is not
 *      merely decorative").
 *   2. When shown: the eight, in Sensing §8's order, labelled with the spec's
 *      names verbatim.
 *   3. Pressing a mode chooses it; pressing the chosen mode again clears it
 *      (no mode ⇒ today's request). The chosen chip says so to a screen reader.
 *
 * The flag read is REAL: the production FeatureFlagsProvider, over a stubbed
 * `fetch`. Nothing in the selector or the provider is mocked.
 *
 * Run: pnpm test:component -- DiscoveryIntentModeSelector
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';

import { FeatureFlagsProvider } from '../../../context/FeatureFlagsContext.tsx';
import { DiscoveryIntentModeSelector } from '../DiscoveryIntentModeSelector.tsx';

const SPEC_ORDER = ['right_now', 'tonight', 'explore', 'quiet', 'social', 'high_energy', 'nearby', 'trip'];
const SPEC_LABELS = ['Right Now', 'Tonight', 'Explore', 'Quiet', 'Social', 'High Energy', 'Nearby', 'Trip'];

const realFetch = global.fetch;
let flagsReply: () => Promise<Response>;
beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  flagsReply = async () => new Response(JSON.stringify({ flags: {} }), { status: 200 });
  global.fetch = jest.fn((url: string | URL | Request) => {
    if (String(url).endsWith('/api/feature-flags')) return flagsReply();
    return Promise.resolve(new Response('{}', { status: 404 }));
  }) as unknown as typeof fetch;
});
afterEach(async () => {
  await act(async () => {});
  global.fetch = realFetch;
});

function flags(f: Record<string, boolean>) {
  flagsReply = async () => new Response(JSON.stringify({ flags: f }), { status: 200 });
}

async function renderWithFlags(selected: string | null, onChange = jest.fn()) {
  await render(
    <FeatureFlagsProvider>
      <DiscoveryIntentModeSelector selected={selected as never} onChange={onChange} />
    </FeatureFlagsProvider>,
  );
  // Let the provider's GET /api/feature-flags resolve.
  await act(async () => {});
  return onChange;
}

describe('shown only when the server reports the capability', () => {
  it('no FeatureFlagsProvider at all (capability unknown): hidden', async () => {
    await render(<DiscoveryIntentModeSelector selected={null} onChange={jest.fn()} />);
    expect(screen.queryByTestId('discovery-intent-mode-selector')).toBeNull();
  });

  it('the flag read FAILS: hidden', async () => {
    flagsReply = async () => { throw new Error('offline'); };
    await renderWithFlags(null);
    expect(screen.queryByTestId('discovery-intent-mode-selector')).toBeNull();
  });

  it('the flag is ABSENT from the server\'s answer: hidden', async () => {
    flags({ some_other_flag: true });
    await renderWithFlags(null);
    expect(screen.queryByTestId('discovery-intent-mode-selector')).toBeNull();
  });

  it('discovery_live_rank_enabled FALSE (2850 as seeded): hidden', async () => {
    flags({ discovery_live_rank_enabled: false });
    await renderWithFlags(null);
    expect(screen.queryByTestId('discovery-intent-mode-selector')).toBeNull();
  });

  it('discovery_live_rank_enabled TRUE: shown', async () => {
    flags({ discovery_live_rank_enabled: true });
    await renderWithFlags(null);
    await waitFor(() => expect(screen.getByTestId('discovery-intent-mode-selector')).toBeTruthy());
  });
});

describe('the eight, in the spec\'s order and words', () => {
  it('eight chips, Sensing §8 order, labels verbatim', async () => {
    flags({ discovery_live_rank_enabled: true });
    await renderWithFlags(null);
    await waitFor(() => expect(screen.getByTestId('discovery-intent-mode-selector')).toBeTruthy());
    const chips = screen.getAllByTestId(/^discovery-intent-mode-(?!selector)/);
    expect(chips.map((c) => c.props.testID)).toEqual(SPEC_ORDER.map((m) => `discovery-intent-mode-${m}`));
    for (const label of SPEC_LABELS) expect(screen.getByText(label)).toBeTruthy();
  });
});

describe('choosing and clearing', () => {
  it('pressing a mode chooses it', async () => {
    flags({ discovery_live_rank_enabled: true });
    const onChange = await renderWithFlags(null);
    await waitFor(() => expect(screen.getByTestId('discovery-intent-mode-quiet')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('discovery-intent-mode-quiet'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('quiet');
  });

  it('pressing the chosen mode again clears it', async () => {
    flags({ discovery_live_rank_enabled: true });
    const onChange = await renderWithFlags('quiet');
    await waitFor(() => expect(screen.getByTestId('discovery-intent-mode-quiet')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('discovery-intent-mode-quiet'));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('pressing another mode switches to it', async () => {
    flags({ discovery_live_rank_enabled: true });
    const onChange = await renderWithFlags('quiet');
    await waitFor(() => expect(screen.getByTestId('discovery-intent-mode-social')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('discovery-intent-mode-social'));
    expect(onChange).toHaveBeenLastCalledWith('social');
  });

  it('only the chosen chip is marked selected', async () => {
    flags({ discovery_live_rank_enabled: true });
    await renderWithFlags('high_energy');
    await waitFor(() => expect(screen.getByTestId('discovery-intent-mode-high_energy')).toBeTruthy());
    for (const m of SPEC_ORDER) {
      expect(screen.getByTestId(`discovery-intent-mode-${m}`).props.accessibilityState).toEqual({ selected: m === 'high_energy' });
    }
  });
});
