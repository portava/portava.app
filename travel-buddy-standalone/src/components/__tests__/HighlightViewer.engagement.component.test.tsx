/**
 * HighlightViewer — reacting to a friend's Highlight says what really happened.
 *
 * WHAT WAS WRONG (lane highlights, 2026-10-03):
 *   - REPORT. `reportHighlight` resolves `{ ok: false }` on a refusal or a
 *     dropped connection and never rejects, but the viewer chained
 *     `.then(() => Alert.alert('Reported', 'Thank you.'))` — so a report the
 *     server never took was thanked as sent. On a safety control.
 *   - LIKE. The server answers `likeCount: null` when the like landed but the
 *     count could not be read; the viewer wrote that null over the count and
 *     the number vanished from the screen.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

// NOTE: intentionally exhaustive — react-native-safe-area-context needs a
// native SafeAreaProvider jest-expo does not supply.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — expo-av's <Video> needs native AV modules.
jest.mock('expo-av', () => {
  const R = jest.requireActual('react') as typeof import('react');
  const { View } = jest.requireActual('react-native') as typeof import('react-native');
  return {
    Video: (props: Record<string, unknown>) =>
      R.createElement(View as React.ComponentType<Record<string, unknown>>, { testID: 'expo-av-video', ...props }),
    ResizeMode: { CONTAIN: 'contain', COVER: 'cover', STRETCH: 'stretch', NONE: 'none' },
  };
});

// NOTE: intentionally exhaustive — expo-linear-gradient is a native view.
jest.mock('expo-linear-gradient', () => {
  const R = jest.requireActual('react') as typeof import('react');
  const { View } = jest.requireActual('react-native') as typeof import('react-native');
  return {
    LinearGradient: ({ children, ...p }: Record<string, unknown> & { children?: unknown }) =>
      R.createElement(View as React.ComponentType<Record<string, unknown>>, p, children as React.ReactNode),
  };
});

// NOTE: intentionally exhaustive — expo-sharing reaches a native share sheet.
jest.mock('expo-sharing', () => ({ isAvailableAsync: async () => false, shareAsync: async () => {} }));

// NOTE: intentionally exhaustive — mediaUrl signs private-bucket URLs over the
// network.
jest.mock('../../services/mediaUrl.ts', () => ({
  useHydratedMedia: () => ({ resolved: {}, loading: false }),
  hydrateMediaUrl: async (u: string) => u,
}));

// NOTE: intentionally exhaustive — DisplayMediaImage/AvatarImage pull expo-image.
jest.mock('../ui/DisplayMediaImage.tsx', () => ({
  DisplayMediaImage: () => null,
  AvatarImage: () => null,
}));

// NOTE: intentionally exhaustive — SaveButton imports the saves service graph.
jest.mock('../SaveButton.tsx', () => ({ SaveButton: () => null }));

// NOTE: intentionally exhaustive — these sheets each pull their own service
// graph and none is the subject of this suite.
jest.mock('../HighlightViewersSheet.tsx', () => ({ HighlightViewersSheet: () => null }));
jest.mock('../EngagementUserListSheet.tsx', () => ({ EngagementUserListSheet: () => null }));
jest.mock('../../features/highlights/HighlightPrivacySheet.tsx', () => ({
  HighlightPrivacySheet: () => null,
}));

// NOTE: intentionally exhaustive — UserIdentityLink navigates through the
// router graph.
jest.mock('../interaction/UserIdentityLink.tsx', () => {
  const R = jest.requireActual('react') as typeof import('react');
  const { View } = jest.requireActual('react-native') as typeof import('react-native');
  return {
    UserIdentityLink: ({ children }: { children?: unknown }) =>
      R.createElement(View as React.ComponentType, null, children as React.ReactNode),
  };
});

// NOTE: intentionally exhaustive — KeyboardSafeScrollView wraps native keyboard
// metrics that crash the jest-expo runner.
jest.mock('../ui/KeyboardSafeView.tsx', () => {
  const R = jest.requireActual('react') as typeof import('react');
  const { ScrollView } = jest.requireActual('react-native') as typeof import('react-native');
  return {
    KeyboardSafeScrollView: ({ children, ...p }: Record<string, unknown> & { children?: unknown }) =>
      R.createElement(ScrollView as React.ComponentType, p, children as React.ReactNode),
    KeyboardSafeView: ({ children }: { children?: unknown }) =>
      R.createElement(ScrollView as React.ComponentType, null, children as React.ReactNode),
  };
});

const mockReport = jest.fn();
const mockLike = jest.fn();
jest.mock('../../services/highlights.ts', () => ({
  ...jest.requireActual('../../services/highlights.ts'),
  markHighlightViewed: async () => {},
  toggleHighlightLike: (...a: unknown[]) => mockLike(...a),
  replyToHighlight: async () => ({ ok: false, data: null }),
  reportHighlight: (...a: unknown[]) => mockReport(...a),
  deleteHighlight: async () => ({ ok: false, data: null }),
  archiveHighlight: async () => ({ ok: false, data: null }),
}));

jest.mock('../../services/messaging.ts', () => ({
  ...jest.requireActual('../../services/messaging.ts'),
  markHighlightsViewed: async () => {},
}));

jest.mock('../../hooks/useHighlightRingState.ts', () => ({
  ...jest.requireActual('../../hooks/useHighlightRingState.ts'),
  markViewed: () => {},
  invalidateHighlightCache: () => {},
}));

jest.mock('../../features/highlights/lifetimeApi.ts', () => ({
  ...jest.requireActual('../../features/highlights/lifetimeApi.ts'),
  pinHighlight: async () => ({ ok: false, kind: 'unavailable', detail: 'x' }),
  unpinHighlight: async () => ({ ok: false, kind: 'unavailable', detail: 'x' }),
}));

import { HighlightViewer } from '../HighlightViewer.tsx';
import type { Highlight } from '../../services/highlights.ts';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const HID = '22222222-2222-4222-8222-222222222222';

function highlight(): Highlight {
  return {
    id: HID,
    ownerId: OWNER,
    mediaUrl: 'https://example.test/h.jpg',
    mediaType: 'image/jpeg',
    videoDurationSeconds: null,
    caption: null,
    locationName: null,
    locationCity: null,
    locationCountry: null,
    visibility: 'public',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    deletedAt: null,
    author: null,
    viewCount: 0,
    likeCount: 0,
    viewedByMe: false,
    likedByMe: false,
    filterId: 'original',
    filterIntensity: 100,
    pinnedAt: null,
    archivedAt: null,
  };
}

type AlertButton = { text?: string; onPress?: () => void };

describe('HighlightViewer — honest engagement', () => {
  let alertSpy: jest.SpyInstance;
  beforeEach(() => {
    mockReport.mockReset();
    mockLike.mockReset();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });
  afterEach(() => { alertSpy.mockRestore(); });

  async function reportAs(reason: 'Spam' | 'Inappropriate') {
    await render(<HighlightViewer visible highlights={[highlight()]} currentUserId={OTHER} onClose={() => {}} />);
    fireEvent.press(await screen.findByTestId('highlight-report'));
    const buttons = alertSpy.mock.calls[0][2] as AlertButton[];
    buttons.find((b) => b.text === reason)!.onPress!();
  }

  it('a refused report is NOT thanked as sent', async () => {
    mockReport.mockResolvedValue({ ok: false, data: null, errorKind: 'network_unreachable' });
    await reportAs('Spam');
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(2));
    expect(mockReport).toHaveBeenCalledWith(HID, 'spam');
    expect(alertSpy.mock.calls[1][0]).not.toBe('Reported');
    expect(alertSpy.mock.calls[1][0]).toBe('Could not send report');
  });

  it('an accepted report is thanked', async () => {
    mockReport.mockResolvedValue({ ok: true, data: null });
    await reportAs('Inappropriate');
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(2));
    expect(mockReport).toHaveBeenCalledWith(HID, 'inappropriate');
    expect(alertSpy.mock.calls[1][0]).toBe('Reported');
  });

  it('a like that landed with an unreadable count keeps the count on screen', async () => {
    mockLike.mockResolvedValue({ ok: true, data: { likedByMe: true, likeCount: null } });
    const h = { ...highlight(), likeCount: 3 };
    await render(<HighlightViewer visible highlights={[h]} currentUserId={OTHER} onClose={() => {}} />);
    expect(await screen.findByText('3')).toBeTruthy();
    fireEvent.press(screen.getByTestId('highlight-like'));
    await waitFor(() => expect(mockLike).toHaveBeenCalledWith(HID, false));
    await waitFor(() => expect(screen.getByText('4')).toBeTruthy());
  });

  it('a refused like goes back to what it was', async () => {
    mockLike.mockResolvedValue({ ok: false, data: null, errorKind: 'db_error' });
    const h = { ...highlight(), likeCount: 3 };
    await render(<HighlightViewer visible highlights={[h]} currentUserId={OTHER} onClose={() => {}} />);
    fireEvent.press(await screen.findByTestId('highlight-like'));
    await waitFor(() => expect(mockLike).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('3')).toBeTruthy());
  });
});
