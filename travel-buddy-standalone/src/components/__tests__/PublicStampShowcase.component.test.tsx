/**
 * PublicStampShowcaseSection — component tests
 *
 * Covers:
 *  - section visible with items
 *  - hidden when result is null
 *  - hidden when result is empty array
 *  - tap navigates to stamp detail (app/stamp/[stampId])
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PublicStampShowcaseSection } from '../stamps/PublicStampShowcaseSection.tsx';
import type { ShowcaseStamp } from '../../services/stampShowcase.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeItem(userStampId: string, name = `Stamp ${userStampId}`): ShowcaseStamp {
  return {
    userStampId,
    rank: 1,
    earnedAt: '2026-07-01T00:00:00Z',
    city: 'Tokyo',
    country: 'Japan',
    titleOverride: null,
    definition: {
      slug: `slug-${userStampId}`,
      name,
      rarity: 'rare',
      stampType: 'location',
      category: 'location',
      artworkUrl: null,
    },
  };
}

const ITEMS: ShowcaseStamp[] = [makeItem('us1', 'Alpha'), makeItem('us2', 'Beta')];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PublicStampShowcaseSection', () => {
  it('renders the section and all stamp cards when items are provided', async () => {
    const onPress = jest.fn();
    await render(<PublicStampShowcaseSection items={ITEMS} onPress={onPress} />);
    await act(async () => {});

    expect(screen.getByTestId('public-showcase-section')).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.getByText('FEATURED STAMPS')).toBeTruthy();
  });

  it('renders nothing when items is null', async () => {
    const onPress = jest.fn();
    await render(<PublicStampShowcaseSection items={null as any} onPress={onPress} />);
    await act(async () => {});

    expect(screen.queryByTestId('public-showcase-section')).toBeNull();
  });

  it('renders nothing when items is an empty array', async () => {
    const onPress = jest.fn();
    await render(<PublicStampShowcaseSection items={[]} onPress={onPress} />);
    await act(async () => {});

    expect(screen.queryByTestId('public-showcase-section')).toBeNull();
  });

  it('calls onPress with the tapped item when a stamp card is pressed', async () => {
    const onPress = jest.fn();
    await render(<PublicStampShowcaseSection items={ITEMS} onPress={onPress} />);
    await act(async () => {});

    fireEvent.press(screen.getByText('Alpha'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledWith(ITEMS[0]);
  });
});
