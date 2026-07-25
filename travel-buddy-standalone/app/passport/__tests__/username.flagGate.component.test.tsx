/**
 * Public passport screen — stamp_showcase_enabled flag gate
 *
 * Confirms the PublicStampShowcaseSection is hidden when the
 * `stamp_showcase_enabled` flag is off, even when showcaseItems are present
 * in state, and visible when the flag is on.
 *
 * Run with: pnpm test:component
 */

import React, { useState } from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { PublicStampShowcaseSection } from '../../../src/components/stamps/PublicStampShowcaseSection.tsx';
import { useFeatureFlags } from '../../../src/context/FeatureFlagsContext.tsx';
import type { ShowcaseStamp } from '../../../src/services/stampShowcase.ts';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — FeatureFlagsContext fetches from /api/feature-flags
// on mount; replacing with a jest.mock keeps tests hermetic.
const mockIsEnabled = jest.fn<boolean, [string]>();
jest.mock('../../../src/context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: mockIsEnabled, loading: false }),
}));

// NOTE: intentionally exhaustive — PublicStampShowcaseSection imports expo-image
// and native stamp-rarity modules; stub preserves the testID so the gate is
// testable without loading native modules.
jest.mock('../../../src/components/stamps/PublicStampShowcaseSection', () => {
  const { View, Text } = require('react-native');
  return {
    PublicStampShowcaseSection: ({ items }: { items: any[] }) => (
      <View testID="public-showcase-section">
        <Text testID="showcase-item-count">{items.length}</Text>
      </View>
    ),
  };
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeItem(id: string): ShowcaseStamp {
  return {
    userStampId: id,
    rank: 1,
    earnedAt: '2026-07-01T00:00:00Z',
    city: 'Tokyo',
    country: 'Japan',
    titleOverride: null,
    definition: {
      slug: `slug-${id}`,
      name: `Stamp ${id}`,
      rarity: 'rare',
      stampType: 'location',
      category: 'location',
      artworkUrl: null,
    },
  };
}

const ITEMS: ShowcaseStamp[] = [makeItem('s1'), makeItem('s2')];

// ── Thin wrapper that replicates the gate from app/passport/[username].tsx ────

/**
 * Mirrors the render condition from the public passport screen:
 *   isFlagEnabled('stamp_showcase_enabled') && showcaseItems && showcaseItems.length > 0
 */
function GatedShowcase({ items }: { items: ShowcaseStamp[] | null }) {
  const { isEnabled: isFlagEnabled } = useFeatureFlags();
  if (!isFlagEnabled('stamp_showcase_enabled')) return null;
  if (!items || items.length === 0) return null;
  return (
    <PublicStampShowcaseSection
      items={items}
      onPress={() => {}}
    />
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockIsEnabled.mockReset();
});

describe('public passport showcase — stamp_showcase_enabled flag gate', () => {
  it('hides the showcase when the flag is off — even when items are cached', async () => {
    mockIsEnabled.mockReturnValue(false);
    await render(<GatedShowcase items={ITEMS} />);
    await act(async () => {});

    expect(screen.queryByTestId('public-showcase-section')).toBeNull();
  });

  it('shows the showcase when the flag is on and items are present', async () => {
    mockIsEnabled.mockReturnValue(true);
    await render(<GatedShowcase items={ITEMS} />);
    await act(async () => {});

    expect(screen.getByTestId('public-showcase-section')).toBeTruthy();
  });

  it('hides the showcase when the flag is on but items is null', async () => {
    mockIsEnabled.mockReturnValue(true);
    await render(<GatedShowcase items={null} />);
    await act(async () => {});

    expect(screen.queryByTestId('public-showcase-section')).toBeNull();
  });

  it('hides the showcase when the flag is on but items is empty', async () => {
    mockIsEnabled.mockReturnValue(true);
    await render(<GatedShowcase items={[]} />);
    await act(async () => {});

    expect(screen.queryByTestId('public-showcase-section')).toBeNull();
  });
});
