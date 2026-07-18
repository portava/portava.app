/**
 * MemoryCard — video play badge tests
 *
 * Confirms that:
 * 1. A video memory renders VideoThumbnail — play badge is visible.
 * 2. An image memory renders without the play badge.
 *
 * ## Mock strategy
 *
 * expo-image is mocked exhaustively because it relies on native Expo modules
 * unavailable in the jest-expo runner. expo-image-picker and expo-av are
 * similarly neutralised. lucide-react-native is handled by the global
 * moduleNameMapper (renders each icon as <View testID="icon-<Name>" />).
 *
 * MemoriesTab is rendered in collapsed mode. After render the header Pressable
 * is pressed (inside act so the expanded state update flushes) to reveal the
 * MemoryCard list.
 */

import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react-native';
import { MemoriesTab } from '../MemoriesTab.tsx';
import type { PassportMemory } from '../../services/passportStamps.ts';

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — expo-image uses native ExpoView internals
// that crash the jest-expo runner when loaded via requireActual.
jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Image: ({ testID, ...rest }: { testID?: string; [k: string]: unknown }) =>
      React.createElement(View, { testID: testID ?? 'expo-image', ...rest }),
  };
});

// NOTE: intentionally exhaustive — expo-image-picker pulls native camera/gallery
// modules unavailable under jest-expo.
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  MediaTypeOptions: { Images: 'Images', Videos: 'Videos', All: 'All' },
  UIImagePickerPreferredAssetRepresentationMode: { Compatible: 'Compatible' },
}));

// NOTE: intentionally exhaustive — expo-av (Video component) requires native
// AVFoundation / ExoPlayer that cannot run under jest-expo.
jest.mock('expo-av', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Video: (props: any) => React.createElement(View, { testID: 'expo-av-video', ...props }),
    ResizeMode: { CONTAIN: 'contain', COVER: 'cover' },
    Audio: { setAudioModeAsync: jest.fn() },
  };
});

// NOTE: intentionally exhaustive — SharedVideoPlayer wraps expo-av (Video
// component) which requires native AVFoundation / ExoPlayer internals that
// crash the jest-expo runner.  The player is never visible in these render
// tests; a null stub is sufficient.
jest.mock('../ui/SharedVideoPlayer', () => ({
  SharedVideoPlayer: () => null,
}));

// NOTE: intentionally exhaustive — SaveButton carries a Supabase/auth
// dependency chain (session hooks, RPC calls) that pulls in native modules
// incompatible with the jest-expo runner.  Its save-state logic is tested
// separately; a null stub is sufficient here.
jest.mock('../SaveButton', () => ({
  SaveButton: () => null,
}));

// Stub passportStamps service calls used inside MemoriesTab event handlers.
// requireActual is safe — this is a pure-JS service module.
jest.mock('../../services/passportStamps', () => ({
  ...jest.requireActual('../../services/passportStamps'),
  createPassportMemory: jest.fn(),
  updatePassportMemory: jest.fn(),
}));

// Stub uploadMedia — used only in the CreateMemoryModal flow.
// requireActual is safe — this is a pure-JS service module.
jest.mock('../../services/media', () => ({
  ...jest.requireActual('../../services/media'),
  uploadMedia: jest.fn(),
}));

// ── Fixture factory ───────────────────────────────────────────────────────────

function makeMemory(overrides: { id?: string; mediaType: 'image' | 'video' | null }): PassportMemory {
  return {
    id:                overrides.id ?? 'mem-1',
    status:            'active',
    title:             'Sunset in Lisbon',
    description:       'Golden hour over the Tagus.',
    country:           'Portugal',
    city:              'Lisbon',
    neighborhood:      null,
    category:          'city',
    visibility:        'public',
    verificationLevel: 'gps',
    sourceType:        null,
    photoUrl:          'https://example.com/thumb.jpg',
    mediaType:         overrides.mediaType,
    planId:            null,
    tripId:            null,
    suggestionReason:  null,
    earnedAt:          '2024-06-01T12:00:00Z',
    createdAt:         '2024-06-01T12:00:00Z',
  };
}

/** Render MemoriesTab in collapsed mode and expand the section. */
async function renderAndExpand(memories: PassportMemory[]) {
  await render(
    <MemoriesTab
      memories={memories}
      loading={false}
      onReload={jest.fn()}
      collapsed
    />,
  );
  // Pressing the header toggles expanded; wrap in act so the state update flushes.
  await act(async () => {
    fireEvent.press(screen.getByText(/Memories/));
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MemoryCard — video memory', () => {
  it('renders the play badge (VideoThumbnail) for a video memory', async () => {
    await renderAndExpand([makeMemory({ id: 'mem-video', mediaType: 'video' })]);

    // VideoThumbnail exposes accessibilityLabel="Play video" on its Pressable.
    expect(screen.getByLabelText('Play video')).toBeTruthy();
  });

  it('shows the Play icon inside VideoThumbnail for a video memory', async () => {
    await renderAndExpand([makeMemory({ id: 'mem-video', mediaType: 'video' })]);

    // The lucide mock renders Play as <View testID="icon-Play" />.
    expect(screen.getByTestId('icon-Play')).toBeTruthy();
  });
});

describe('MemoryCard — image memory', () => {
  it('renders no play badge for an image memory', async () => {
    await renderAndExpand([makeMemory({ id: 'mem-image', mediaType: 'image' })]);

    // No VideoThumbnail — play badge accessibility label must be absent.
    expect(screen.queryByLabelText('Play video')).toBeNull();
  });

  it('renders no Play icon for an image memory', async () => {
    await renderAndExpand([makeMemory({ id: 'mem-image', mediaType: 'image' })]);

    // The lucide Play icon is only rendered inside VideoThumbnail.
    expect(screen.queryByTestId('icon-Play')).toBeNull();
  });
});
