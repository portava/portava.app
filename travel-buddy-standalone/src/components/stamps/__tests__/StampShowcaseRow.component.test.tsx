/**
 * Component tests — StampShowcaseRow
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
 *
 * AccessibilityInfo.isReduceMotionEnabled is spied on to return true so the
 * stagger spring animation (useNativeDriver:true) is skipped entirely — this
 * prevents a "Jest environment torn down" crash from the async .then callback
 * trying to connect native animated nodes after the test finishes.
 */

import React from 'react';
import { AccessibilityInfo } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { StampShowcaseRow } from '../StampShowcaseRow.tsx';
import type { ShowcaseStamp } from '../../../services/stampShowcase.ts';

// ── expo-image mock ──────────────────────────────────────────────────────────
// NOTE: only Image is used by ShowcaseCard; factory is intentionally exhaustive
// for that single export. testID makes prop inspection easy via TestRenderer.
jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Image: ({ accessibilityLabel, source, ...rest }: any) =>
      React.createElement(View, {
        testID: 'showcase-row-expo-image',
        accessibilityLabel,
        'data-source': source,
        ...rest,
      }),
  };
});

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

// ── AccessibilityInfo spy ────────────────────────────────────────────────────
// Return reduce-motion=true so StampShowcaseRow skips the Animated.spring
// (useNativeDriver:true) and falls into the synchronous setValue(1) branch.
// This prevents the animation from trying to connect native nodes after the
// Jest environment has been torn down.
let reducedMotionSpy: jest.SpyInstance;
beforeEach(() => {
  reducedMotionSpy = jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(true);
});
afterEach(() => {
  reducedMotionSpy.mockRestore();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function findArtworkImages(root: TestRenderer.ReactTestInstance) {
  try {
    return root.findAllByProps({ testID: 'showcase-row-expo-image' });
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
  userStampId: 'us-001',
  rank: 1,
  earnedAt: '2024-06-01T00:00:00Z',
  city: 'Kyoto',
  country: 'Japan',
  titleOverride: null,
  definition: {
    slug: 'kyoto-visit',
    name: 'Kyoto Visit',
    rarity: 'common',
    stampType: 'place',
    category: 'city',
    artworkUrl: 'https://example.com/art/kyoto.png',
  },
};

const ITEM_NO_ARTWORK: ShowcaseStamp = {
  ...SHOWCASE_ITEM,
  userStampId: 'us-002',
  definition: SHOWCASE_ITEM.definition
    ? { ...SHOWCASE_ITEM.definition, artworkUrl: null }
    : null,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StampShowcaseRow — no "photo" label on AI artwork images', () => {
  it('renders an image element when artworkUrl is present', () => {
    const tr = create(
      <StampShowcaseRow items={[SHOWCASE_ITEM]} onPress={jest.fn()} />,
    );
    expect(findArtworkImages(tr.root).length).toBeGreaterThanOrEqual(1);
  });

  it('Image element does not have accessibilityLabel containing "photo"', () => {
    const tr = create(
      <StampShowcaseRow items={[SHOWCASE_ITEM]} onPress={jest.fn()} />,
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
      <StampShowcaseRow items={[SHOWCASE_ITEM]} onPress={jest.fn()} />,
    );
    const images = findArtworkImages(tr.root);
    expect(images.length).toBeGreaterThanOrEqual(1);
    for (const img of images) {
      // Expected: "Kyoto Visit — common stamp"
      expect(typeof img.props.accessibilityLabel).toBe('string');
      expect(img.props.accessibilityLabel).toMatch(/— \w+ stamp$/);
      expect(img.props.accessibilityLabel.toLowerCase()).not.toContain('photo');
    }
  });

  it('renders multiple items without any Image carrying a "photo" label', () => {
    const second: ShowcaseStamp = { ...SHOWCASE_ITEM, userStampId: 'us-003', rank: 2 };
    const tr = create(
      <StampShowcaseRow items={[SHOWCASE_ITEM, second]} onPress={jest.fn()} />,
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
      <StampShowcaseRow items={[ITEM_NO_ARTWORK]} onPress={jest.fn()} />,
    );
    expect(findArtworkImages(tr.root).length).toBe(0);
  });

  it('returns null when given an empty list', () => {
    const tr = create(
      <StampShowcaseRow items={[]} onPress={jest.fn()} />,
    );
    expect(tr.toJSON()).toBeNull();
  });
});
