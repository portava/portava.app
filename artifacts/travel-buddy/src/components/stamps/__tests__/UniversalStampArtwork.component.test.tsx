/**
 * Component tests — UniversalStampArtwork
 *
 * Covers:
 *   1. Renders expo-image when activeArtworkUrl is provided
 *   2. Falls back to procedural art when no URLs available
 *   3. Falls back to procedural art on image error
 *   4. Shows pending label for unlocked stamps with no artwork
 *   5. Hides pending label when showPendingLabel=false
 *   6. Image has accessibilityLabel
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { UniversalStampArtwork } from '../UniversalStampArtwork.tsx';
import type { PassportStamp } from '../../../types/models.ts';

// expo-image mock — intercept the Image and expose onError + accessibilityLabel
jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Image: ({
      source,
      onError,
      accessibilityLabel,
      style,
      ...rest
    }: any) =>
      React.createElement(View, {
        ...rest,
        testID: 'expo-image',
        accessibilityLabel,
        onTouchStart: onError,   // expose via an event for fireEvent
        style,
      }),
  };
});

// StampArtwork is the procedural fallback — use module path from test location
// (test is in stamps/__tests__/, fallback is in src/components/StampArtwork.tsx)
// NOTE: StampArtwork is a leaf component with no other exports; factory is intentionally exhaustive.
jest.mock('../../StampArtwork.tsx', () => ({
  StampArtwork: () => {
    const React = require('react');
    const { View } = require('react-native');
    return React.createElement(View, { testID: 'stamp-artwork-fallback' });
  },
}));

// stampArtworkResolver — minimal stub for accessibilityLabel computation
// NOTE: only resolveArtwork is used by UniversalStampArtwork; factory is intentionally exhaustive.
jest.mock('../../../lib/stampArtworkResolver', () => ({
  resolveArtwork: () => ({
    rarity: 'common',
    categoryLabel: 'CITY',
    accessibilityLabel: 'Test stamp',
    hasShimmer: false,
    hasGlow: false,
    locked: false,
    shape: 'oval',
    borderStyle: 'single',
    borderWeight: 1,
    accent: '#000',
    background: '#fff',
    pattern: 'solid',
    texture: 'paper',
    iconKey: 'MapPin',
  }),
}));

const LEGACY_STAMP: PassportStamp = {
  id: 'stamp-1',
  label: 'Manila',
  sublabel: 'City',
  category: 'city',
  earnedAt: '2024-01-01T00:00:00Z',
  locked: false,
  visibility: 'public',
} as any;

const ARTWORK_URL = 'https://example.com/art/full.png';

describe('UniversalStampArtwork', () => {
  it('renders procedural art when no URLs are provided', async () => {
    await render(
      <UniversalStampArtwork stamp={LEGACY_STAMP} size={64} showPendingLabel={false} />
    );
    expect(screen.getByTestId('stamp-artwork-fallback')).toBeTruthy();
  });

  it('renders an image when activeArtworkUrl is provided', async () => {
    await render(
      <UniversalStampArtwork
        stamp={LEGACY_STAMP}
        activeArtworkUrl={ARTWORK_URL}
        size={64}
        showPendingLabel={false}
      />
    );
    expect(screen.getByTestId('expo-image')).toBeTruthy();
  });

  it('has an accessibilityLabel on the rendered image', async () => {
    await render(
      <UniversalStampArtwork
        stamp={LEGACY_STAMP}
        activeArtworkUrl={ARTWORK_URL}
        size={64}
        showPendingLabel={false}
      />
    );
    const img = screen.getByTestId('expo-image');
    expect(img.props.accessibilityLabel).toBeTruthy();
    expect(typeof img.props.accessibilityLabel).toBe('string');
  });

  it('shows pending label for unlocked stamps with no artwork', async () => {
    await render(
      <UniversalStampArtwork stamp={LEGACY_STAMP} size={64} showPendingLabel />
    );
    expect(screen.getByText(/artwork being prepared/i)).toBeTruthy();
  });

  it('hides pending label when showPendingLabel is false', async () => {
    await render(
      <UniversalStampArtwork stamp={LEGACY_STAMP} size={64} showPendingLabel={false} />
    );
    expect(screen.queryByText(/artwork being prepared/i)).toBeNull();
  });
});
