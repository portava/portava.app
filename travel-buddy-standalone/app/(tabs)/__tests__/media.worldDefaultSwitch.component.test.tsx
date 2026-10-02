/**
 * media.worldDefaultSwitch.component.test.tsx — with the owner's F1 decision
 * ON (MEDIA_TAB_WORLD_DEFAULT_ENABLED + MEDIA_WORLD_SHELL_ENABLED, census-media
 * §34) the Media tab opens on World, and Watch is one tap away: the tab's mode
 * switcher, drawn under the World header, takes the viewer to the Watch feed.
 *
 * One press, in its own file: this renderer commits one press per file
 * (.agents/memory/rntl-react19-renderer-budget.md). The query-only F1 cases
 * are in media.worldDefault.component.test.tsx.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */
import React from 'react';
import { screen, render, act, fireEvent } from '@testing-library/react-native';

// NOTE: intentional stub — navigation context unavailable in Jest.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: (_cb: () => void) => {},
}));

// NOTE: intentional stub — insets not under test.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentional stub — bottom inset value not under test.
jest.mock('../../../src/hooks/useBottomInset.ts', () => ({
  useBottomInset: () => 34,
  useLayoverAwareBottomInset: () => 34,
}));

// NOTE: intentional stub — event emission not under test.
jest.mock('../../../src/lib/mediaEvents.ts', () => ({
  mediaEvents: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
}));

// NOTE: exhaustive stub intentional — every mode flag, the shell and F1 on.
jest.mock('../../../src/context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({
    isEnabled: () => true,
    loading: false,
  }),
}));

// NOTE: intentional stubs — only which surface the tab mounts is under test.
jest.mock('../../../src/components/media/WatchFeed.tsx', () => {
  const { View } = require('react-native');
  return { WatchFeed: () => <View testID="watch-feed" /> };
});
// NOTE: intentional stub — not under test.
jest.mock('../../../src/components/media/GridFeed.tsx', () => ({
  GridFeed: () => null,
}));
// NOTE: intentional stub — GemsFeed pulls in map/location deps.
jest.mock('../../../src/components/media/GemsFeed.tsx', () => ({
  GemsFeed: () => null,
}));
// NOTE: intentional stub — the sheet's own deps are not under test.
jest.mock('../../../src/components/media/MediaQuickCreateSheet.tsx', () => ({
  MediaQuickCreateSheet: () => null,
}));
jest.mock('../../../src/features/media/screens/MediaWorldTabSurface.tsx', () => {
  const { View } = require('react-native');
  return {
    MediaWorldTabSurface: ({ modeSwitcher }: { modeSwitcher?: React.ReactNode }) => (
      <View testID="world-surface">{modeSwitcher}</View>
    ),
  };
});

import MediaScreen from '../media.tsx';

describe('Media tab — F1 ON: Watch is one tap from World', () => {
  it('opens on World; the Watch chip under the World header switches to the Watch feed', async () => {
    await act(async () => { render(<MediaScreen />); });

    expect(screen.getByTestId('world-surface')).toBeTruthy();
    expect(screen.queryByTestId('watch-feed')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('mode-chip-watch'));
    });

    expect(screen.getByTestId('watch-feed')).toBeTruthy();
    expect(screen.queryByTestId('world-surface')).toBeNull();
    // Back on Watch the tab's own selector is overlaid again, World first in it.
    expect(screen.getByTestId('mode-chip-world')).toBeTruthy();
  });
});
