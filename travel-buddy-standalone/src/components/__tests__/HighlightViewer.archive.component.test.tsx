/**
 * HighlightViewer — §21 Archive is a SEPARATE operation from Delete.
 *
 * Highlights/Memories Development Architecture Spec v1 §21: "Delete, archive,
 * do-not-resurface, and 'keep but do not personalize' are different operations
 * and must remain separate in both data model and UX."
 *
 * The server has held up its half since `archived_at` was given routes: archive
 * is reversible, retains the row, and does not consume the delete. The UX half
 * was missing entirely — the only removal an owner could perform from the
 * viewer was Delete, which is terminal and says so. An owner who wanted the
 * Highlight off their profile but kept had exactly one button, and it was the
 * wrong one.
 *
 * WHAT IS ASSERTED:
 *   - Archive and Delete are BOTH offered to the owner, and to nobody else;
 *   - Archive calls the archive route and NOT the delete route;
 *   - a refused archive does not remove the Highlight from the viewer.
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

const mockArchive = jest.fn();
const mockDelete = jest.fn();
jest.mock('../../services/highlights.ts', () => ({
  ...jest.requireActual('../../services/highlights.ts'),
  markHighlightViewed: async () => {},
  toggleHighlightLike: async () => ({ ok: false, data: null }),
  replyToHighlight: async () => ({ ok: false, data: null }),
  reportHighlight: async () => ({ ok: false, data: null }),
  deleteHighlight: (...a: unknown[]) => mockDelete(...a),
  archiveHighlight: (...a: unknown[]) => mockArchive(...a),
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

describe('HighlightViewer — §21 archive', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    mockArchive.mockReset();
    mockDelete.mockReset();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => { alertSpy.mockRestore(); });

  it('offers the owner Archive alongside Delete — two operations, not one', async () => {
    await render(
      <HighlightViewer visible highlights={[highlight()]} currentUserId={OWNER} onClose={() => {}} />,
    );
    expect(await screen.findByTestId('highlight-archive')).toBeTruthy();
    expect(screen.getByTestId('highlight-delete')).toBeTruthy();
  });

  it('offers neither to somebody who does not own the Highlight', async () => {
    await render(
      <HighlightViewer visible highlights={[highlight()]} currentUserId={OTHER} onClose={() => {}} />,
    );
    expect(screen.queryByTestId('highlight-archive')).toBeNull();
    expect(screen.queryByTestId('highlight-delete')).toBeNull();
  });

  it('archives through the archive route and never through delete', async () => {
    mockArchive.mockResolvedValue({ ok: true, data: { id: HID, archivedAt: '2026-09-22T00:00:00.000Z' } });
    const onClose = jest.fn();
    const onDeleted = jest.fn();
    await render(
      <HighlightViewer
        visible
        highlights={[highlight()]}
        currentUserId={OWNER}
        onClose={onClose}
        onDeleted={onDeleted}
      />,
    );

    fireEvent.press(await screen.findByTestId('highlight-archive'));

    await waitFor(() => expect(mockArchive).toHaveBeenCalledWith(HID));
    // The whole point of §21's separation: archiving must not delete.
    expect(mockDelete).not.toHaveBeenCalled();
    // It was the last one in the set, so the viewer closes and the profile
    // behind it is told to re-read.
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onDeleted).toHaveBeenCalled();
  });

  it('keeps the Highlight on screen when the archive write is refused', async () => {
    mockArchive.mockResolvedValue({ ok: false, data: null, errorKind: 'db_error', message: 'nope' });
    const onClose = jest.fn();
    await render(
      <HighlightViewer visible highlights={[highlight()]} currentUserId={OWNER} onClose={onClose} />,
    );

    fireEvent.press(await screen.findByTestId('highlight-archive'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    // Closing on a failed write would tell the owner it was archived.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('highlight-archive')).toBeTruthy();
  });
});
