/**
 * "No memories yet" is a claim about the owner's life. It must be true.
 *
 * Highlights/Memories Development Architecture Spec v1 §28.11 ("never swallow
 * projection/schema failures into plausible-looking empty history without
 * structured error state").
 *
 * THE DEFECT THIS GUARDS. `usePassport` turned a FAILED Memories read into
 * `memories: []`, and this tab renders `[]` as the onboarding empty state —
 * a 📖, the words "No memories yet", and an invitation to add your first one.
 * Shown to somebody with two hundred Memories whose read failed, that is the
 * worst thing this screen can say, and it is indistinguishable from the truth.
 *
 * The hook now reports `memoriesUnreadable` (see
 * usePassport.failedSectionNotPersisted.component.test.tsx, which also proves
 * the fabricated empty list is no longer written into the stale-while-
 * revalidate snapshot). This file is the other half: the tab must RENDER the
 * difference rather than collapse it back.
 *
 * Mock discipline follows MemoriesTab.fourViews.component.test.tsx.
 *
 * Run with: pnpm test:component
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
// NOTE: intentionally exhaustive — media.ts calls the API server + Supabase; no upload happens in this suite.
jest.mock('../../services/media', () => ({ uploadMedia: jest.fn() }));
// NOTE: intentionally exhaustive — passportStamps reaches the API server + Supabase; no write happens in this suite.
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

describe('MemoriesTab — an unread history is not an empty one', () => {
  it('does not say "No memories yet" when the read failed', async () => {
    await render(<MemoriesTab memories={[]} onReload={jest.fn()} unreadable />);

    // The onboarding empty state is a factual claim and we have no basis for it.
    expect(screen.queryByText(/No memories yet/i)).toBeNull();
    expect(screen.queryByText(/Add first memory/i)).toBeNull();

    expect(screen.getByTestId('memories-unreadable')).toBeTruthy();
  });

  it('offers a retry that reloads', async () => {
    const onReload = jest.fn();
    await render(<MemoriesTab memories={[]} onReload={onReload} unreadable />);

    fireEvent.press(screen.getByTestId('memories-unreadable-retry'));

    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('still shows the onboarding empty state when the read succeeded and found nothing', async () => {
    await render(<MemoriesTab memories={[]} onReload={jest.fn()} unreadable={false} />);

    expect(screen.getByText(/No memories yet/i)).toBeTruthy();
    expect(screen.queryByTestId('memories-unreadable')).toBeNull();
  });
});
