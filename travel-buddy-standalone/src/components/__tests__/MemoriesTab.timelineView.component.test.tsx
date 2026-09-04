/**
 * MemoriesTab — the §15 view switcher (All grid ↔ chronological Timeline).
 *
 *   1. Both view tabs render once there are memories.
 *   2. "All" shows every memory (the existing flat grid).
 *   3. "Timeline" groups by month with newest-first month headers.
 *
 * Follows the MemoriesTab component-test mock discipline: the Modal is replaced
 * with a synchronous View (its animation lifecycle otherwise leaks an act
 * scope), and every native/service dep the tree pulls is stubbed.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const R = require('react') as typeof import('react');
        return ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
          visible ? R.createElement(target.View as React.ComponentType, null, children) : null;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});
// NOTE: intentionally exhaustive — expo-image-picker pulls native camera/permission modules unavailable in jest-expo; the picker is not exercised here.
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  launchImageLibraryAsync: jest.fn().mockResolvedValue({ canceled: true, assets: [] }),
  MediaTypeOptions: { Images: 'Images' },
}));
// NOTE: intentionally exhaustive — media.ts calls the API server + Supabase; not exercised by the view switcher under test.
jest.mock('../../services/media', () => ({ uploadMedia: jest.fn() }));
// NOTE: intentionally exhaustive — passportStamps reaches the API server + Supabase; only updatePassportMemory is touched (visibility change) and is stubbed.
jest.mock('../../services/passportStamps', () => ({
  createPassportMemory: jest.fn(),
  updatePassportMemory: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../CachedImage.tsx', () => {
  const R = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return { CachedImage: (p: Record<string, unknown>) => R.createElement(View as React.ComponentType, p) };
});
jest.mock('../ui/KeyboardSafeView', () => {
  const R = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return { KeyboardSafeView: ({ children }: { children: unknown }) => R.createElement(View, null, children) };
});
// NOTE: intentionally exhaustive — SharedVideoPlayer wraps expo-av (native AV); rendered inert here.
jest.mock('../ui/SharedVideoPlayer', () => ({ SharedVideoPlayer: () => null }));
// NOTE: intentionally exhaustive — VideoThumbnail decodes video frames via native modules; rendered inert here.
jest.mock('../ui/VideoThumbnail', () => ({ VideoThumbnail: () => null }));
// NOTE: intentionally exhaustive — MediaSourceSheet opens native camera/library pickers; rendered inert here.
jest.mock('../ui/MediaSourceSheet', () => ({ MediaSourceSheet: () => null }));
// NOTE: intentionally exhaustive — GlobalPlacePicker starts location work + safe-area reads on mount; rendered inert here.
jest.mock('../selectors/GlobalPlacePicker', () => ({ GlobalPlacePicker: () => null }));

import { MemoriesTab } from '../MemoriesTab.tsx';
import type { PassportMemory } from '../../services/passportStamps.ts';

function mem(over: Partial<PassportMemory>): PassportMemory {
  return {
    id: 'm', status: 'active', title: 'Untitled', description: null, country: null, city: null,
    neighborhood: null, category: null, visibility: 'public', verificationLevel: 'none',
    sourceType: null, photoUrl: null, mediaType: null, planId: null, tripId: null,
    suggestionReason: null, earnedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z',
    ...over,
  } as PassportMemory;
}

const memories = [
  mem({ id: 'm-sep', title: 'Sky Bar', earnedAt: '2026-09-20T00:00:00Z' }),
  mem({ id: 'm-aug', title: 'Beach Day', earnedAt: '2026-08-05T00:00:00Z' }),
];

it('offers both views, defaults to the All grid, and Timeline groups by newest-first month', async () => {
  await render(<MemoriesTab memories={memories} onReload={jest.fn()} />);

  // Both view tabs; defaults to the flat grid with every memory.
  expect(screen.getByTestId('memories-view-all')).toBeTruthy();
  expect(screen.getByTestId('memories-view-timeline')).toBeTruthy();
  expect(screen.getByTestId('memories-view-all-list')).toBeTruthy();
  expect(screen.getByText('Sky Bar')).toBeTruthy();
  expect(screen.getByText('Beach Day')).toBeTruthy();

  // Switch to Timeline: memories grouped under newest-first month headers.
  fireEvent.press(screen.getByTestId('memories-view-timeline'));
  expect(await screen.findByTestId('memories-view-timeline-list')).toBeTruthy();
  expect(screen.getByTestId('memories-timeline-header-2026-09')).toBeTruthy();
  expect(screen.getByTestId('memories-timeline-header-2026-08')).toBeTruthy();
  expect(screen.getByText('September 2026')).toBeTruthy();
  expect(screen.getByText('August 2026')).toBeTruthy();
  expect(screen.getByText('Sky Bar')).toBeTruthy();
  expect(screen.getByText('Beach Day')).toBeTruthy();
});
