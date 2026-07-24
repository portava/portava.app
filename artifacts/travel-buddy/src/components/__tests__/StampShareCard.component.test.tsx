/**
 * StampShareCard — component tests
 *
 * Covers:
 *  1. Artwork Image rendered with the correct accessibilityLabel when
 *     universalArtworkUrl is set.
 *  2. Procedural fallback rendered (no expo-image Image) when
 *     universalArtworkUrl is absent.
 *  3. Rarity badge present for each of the five tiers — common, uncommon,
 *     rare, epic, and legendary.
 *
 * Run with: pnpm test:component
 *
 * ## Mock strategy
 *
 * expo-image is mocked exhaustively (native ExpoView internals crash the
 * jest-expo runner). The Image stub forwards all props so accessibilityLabel
 * is inspectable via getByRole / getByLabelText.
 *
 * stampArtworkResolver is mocked so rarity and categoryLabel can be
 * controlled per-test without needing a real Supabase-backed stamp.
 *
 * StampSvgFrame uses react-native-svg; it is mocked to avoid native SVG
 * crash in the test runner.
 *
 * lucide-react-native is handled by the global moduleNameMapper
 * (src/__mocks__/lucide-react-native.tsx) — no per-file mock needed.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import { StampShareCard } from '../StampShareCard.tsx';
import type { PassportStamp } from '../../types/models.ts';
import { STAMP_RARITY_LABELS } from '../../types/stampArtwork.ts';
import type { StampRarity } from '../../lib/stampRarity.ts';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — expo-image uses native ExpoView and
// ImageModule internals unavailable in the jest-expo runner.
jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Image: ({
      testID,
      accessibilityLabel,
      ...rest
    }: {
      testID?: string;
      accessibilityLabel?: string;
      [k: string]: unknown;
    }) =>
      React.createElement(View, {
        testID: testID ?? 'expo-image',
        accessibilityLabel,
        accessible: true,
        accessibilityRole: 'image',
        ...rest,
      }),
  };
});

// NOTE: intentionally exhaustive — react-native-svg crashes the jest-expo
// runner when loaded via requireActual.
jest.mock('../StampSvgFrame', () => ({
  StampSvgFrame: () => null,
}));

// NOTE: mockResolveArtwork lets each test control rarity and categoryLabel
// without a live Supabase session.
const mockResolveArtwork = jest.fn();
jest.mock('../../lib/stampArtworkResolver', () => ({
  resolveArtwork: (...args: unknown[]) => mockResolveArtwork(...args),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeArt(rarity: StampRarity = 'rare', categoryLabel = 'City') {
  return {
    iconKey: 'MapPin',
    rarity,
    categoryLabel,
    captionText: null,
    shape: 'rect',
    borderStyle: 'single',
    borderWeight: 1,
    accent: '#3B82F6',
    background: '#1E3A5F',
    pattern: 'solid',
    texture: 'paper',
    hasShimmer: false,
    hasGlow: false,
  };
}

function makeStamp(overrides: Partial<PassportStamp> = {}): PassportStamp {
  return {
    id: 'stamp-1',
    kind: 'city',
    label: 'CEBU',
    sublabel: 'PH · 2026',
    earnedAt: '2026-01-01T00:00:00Z',
    universalArtworkUrl: 'https://example.com/art.png',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StampShareCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveArtwork.mockReturnValue(makeArt('rare', 'City'));
  });

  it('renders the artwork Image with correct accessibilityLabel when universalArtworkUrl is set', async () => {
    mockResolveArtwork.mockReturnValue(makeArt('rare', 'City'));
    const stamp = makeStamp({ universalArtworkUrl: 'https://example.com/art.png' });

    await render(<StampShareCard stamp={stamp} />);

    await waitFor(() => {
      expect(
        screen.getByLabelText('City stamp artwork'),
      ).toBeTruthy();
    });
  });

  it('renders procedural fallback with no expo-image Image when universalArtworkUrl is absent', async () => {
    mockResolveArtwork.mockReturnValue(makeArt('common', 'Perk'));
    const stamp = makeStamp({ universalArtworkUrl: undefined });

    await render(<StampShareCard stamp={stamp} />);

    await waitFor(() => {
      // The rarity badge is always shown (procedural path still renders it).
      expect(screen.getByText(STAMP_RARITY_LABELS['common'])).toBeTruthy();
    });

    // No expo-image Image should be present in the procedural path.
    expect(screen.queryByTestId('expo-image')).toBeNull();
  });

  const RARITY_TIERS: StampRarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

  test.each(RARITY_TIERS)(
    'renders the rarity badge for %s tier',
    async (rarity) => {
      mockResolveArtwork.mockReturnValue(makeArt(rarity, 'City'));
      const stamp = makeStamp({ universalArtworkUrl: undefined });

      await render(<StampShareCard stamp={stamp} />);

      await waitFor(() => {
        expect(screen.getByText(STAMP_RARITY_LABELS[rarity])).toBeTruthy();
      });
    },
  );
});
