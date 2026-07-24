/**
 * Component tests — PublicStampShowcaseSection
 *
 * Regression guard: AI stamp artwork images must never carry an
 * accessibilityLabel containing "photo". A future refactor that adds
 * accessibilityLabel="photo" to the Image element would be caught here.
 *
 * Also confirms the Image element carries the expected "<name> — <rarity> stamp"
 * label so screen readers can announce the artwork meaningfully.
 *
 * Uses react-test-renderer for prop inspection (RNTL v14 dropped
 * UNSAFE_getAllByType). Follows the DisplayMediaImage.component.test.tsx pattern.
 */

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { PublicStampShowcaseSection } from '../PublicStampShowcaseSection.tsx';
import type { ShowcaseStamp } from '../../../services/stampShowcase.ts';

// ── stampRarity mock ─────────────────────────────────────────────────────────
// NOTE: only RARITY_COLORS/normalizeRarity/hasGlowRing are used by ShowcaseCard;
// factory is intentionally exhaustive for those three exports.
jest.mock('../../../lib/stampRarity.ts', () => ({
  RARITY_COLORS: {
    common: { ring: '#aaa', glow: '#aaa' },
    uncommon: { ring: '#5a5', glow: '#5a5' },
    rare: { ring: '#55a', glow: '#55a' },
    epic: { ring: '#a5a', glow: '#a5a' },
    legendary: { ring: '#fa0', glow: '#fa0' },
  },
  normalizeRarity: () => 'common' as const,
  hasGlowRing: () => false,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** All expo-image elements in the tree that have a URI source (artwork images). */
function findArtworkImages(root: TestRenderer.ReactTestInstance) {
  try {
    return root.findAllByProps({ testID: 'stamp-artwork-image' });
  } catch {
    return [];
  }
}

function create(el: React.ReactElement) {
  let tr!: TestRenderer.ReactTestRenderer;
  act(() => { tr = TestRenderer.create(el); });
  return tr;
}

// ── Fixture ───────────────────────────────────────────────────────────────────

const SHOWCASE_ITEM: ShowcaseStamp = {
  userStampId: 'us-pub-001',
  rank: 1,
  earnedAt: '2024-07-01T00:00:00Z',
  city: 'Lisbon',
  country: 'Portugal',
  titleOverride: null,
  definition: {
    slug: 'lisbon-visit',
    name: 'Lisbon Visit',
    rarity: 'rare',
    stampType: 'place',
    category: 'city',
    artworkUrl: 'https://example.com/art/lisbon.png',
  },
};

const ITEM_NO_ARTWORK: ShowcaseStamp = {
  ...SHOWCASE_ITEM,
  userStampId: 'us-pub-002',
  definition: SHOWCASE_ITEM.definition
    ? { ...SHOWCASE_ITEM.definition, artworkUrl: null }
    : null,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PublicStampShowcaseSection — no "photo" label on AI artwork images', () => {
  it('renders the section with artwork items', () => {
    const tr = create(
      <PublicStampShowcaseSection items={[SHOWCASE_ITEM]} onPress={jest.fn()} />,
    );
    expect(tr.toJSON()).not.toBeNull();
  });

  it('renders an artwork image element when artworkUrl is present', () => {
    const tr = create(
      <PublicStampShowcaseSection items={[SHOWCASE_ITEM]} onPress={jest.fn()} />,
    );
    expect(findArtworkImages(tr.root).length).toBeGreaterThanOrEqual(1);
  });

  it('Image element does not have accessibilityLabel containing "photo"', () => {
    const tr = create(
      <PublicStampShowcaseSection items={[SHOWCASE_ITEM]} onPress={jest.fn()} />,
    );
    for (const img of findArtworkImages(tr.root)) {
      const label: string | undefined = img.props.accessibilityLabel;
      if (label != null) {
        expect(label.toLowerCase()).not.toContain('photo');
      }
    }
  });

  it('Image element carries a "<name> — <rarity> stamp" accessibilityLabel', () => {
    const tr = create(
      <PublicStampShowcaseSection items={[SHOWCASE_ITEM]} onPress={jest.fn()} />,
    );
    const images = findArtworkImages(tr.root);
    expect(images.length).toBeGreaterThanOrEqual(1);
    for (const img of images) {
      // Expected: "Lisbon Visit — common stamp"
      expect(typeof img.props.accessibilityLabel).toBe('string');
      expect(img.props.accessibilityLabel).toMatch(/— \w+ stamp$/);
      expect(img.props.accessibilityLabel.toLowerCase()).not.toContain('photo');
    }
  });

  it('renders multiple items without any Image carrying a "photo" label', () => {
    const second: ShowcaseStamp = { ...SHOWCASE_ITEM, userStampId: 'us-pub-003', rank: 2 };
    const tr = create(
      <PublicStampShowcaseSection items={[SHOWCASE_ITEM, second]} onPress={jest.fn()} />,
    );
    const images = findArtworkImages(tr.root);
    expect(images.length).toBeGreaterThanOrEqual(1);
    for (const img of images) {
      const label: string | undefined = img.props.accessibilityLabel;
      if (label != null) {
        expect(label.toLowerCase()).not.toContain('photo');
      }
    }
  });

  it('renders no artwork Image when artworkUrl is null', () => {
    const tr = create(
      <PublicStampShowcaseSection items={[ITEM_NO_ARTWORK]} onPress={jest.fn()} />,
    );
    expect(findArtworkImages(tr.root).length).toBe(0);
  });

  it('returns null when given an empty list', () => {
    const tr = create(
      <PublicStampShowcaseSection items={[]} onPress={jest.fn()} />,
    );
    expect(tr.toJSON()).toBeNull();
  });
});
