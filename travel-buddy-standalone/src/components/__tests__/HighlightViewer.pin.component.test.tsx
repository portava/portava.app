/**
 * HighlightViewer — §12 pin / §17 unpin, from the owner's side.
 *
 * Highlights/Memories Development Architecture Spec v1 §12 ("pinned/manual
 * order always outranks automatic ordering") and §17 (UNPIN_HIGHLIGHT).
 * Census H100 / H142 / H143.
 *
 * ── WHAT THIS ASSERTS AND WHY ──────────────────────────────────────────────
 *
 * 1. A Highlight THE SERVER SAYS IS PINNED opens showing UNPIN. This is the
 *    half that was broken: the pin affordance and both routes existed, but the
 *    client model dropped `pinnedAt`, so every Highlight opened as unpinned and
 *    the only thing an owner could do to an already-pinned Highlight was pin it
 *    again. Unpinning across sessions was unreachable.
 *
 * 2. The button follows the SERVER's answer, never the tap. `handlePinToggle`
 *    sets local state from the response, so a refused write leaves the icon
 *    where it was rather than springing back later.
 *
 * 3. `feature_disabled` — a deployment without migration 2723 — is reported as
 *    PERMANENT, with no invitation to retry something that will never work.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';
import { Alert } from 'react-native';

// NOTE: intentionally exhaustive — react-native-safe-area-context needs a
// native SafeAreaProvider jest-expo does not supply; zero insets keep the
// viewer's padding math from crashing without touching what is asserted.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — expo-av's <Video> needs native AV modules
// the jest-expo runner does not have. Only the image branch is exercised here.
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
jest.mock('expo-sharing', () => ({
  isAvailableAsync: async () => false,
  shareAsync: async () => {},
}));

// NOTE: intentionally exhaustive — mediaUrl signs private-bucket URLs over the
// network. The viewer only needs the hook to answer without a request.
jest.mock('../../services/mediaUrl.ts', () => ({
  useHydratedMedia: () => ({ resolved: {}, loading: false }),
  hydrateMediaUrl: async (u: string) => u,
}));

// NOTE: intentionally exhaustive — DisplayMediaImage/AvatarImage pull expo-image,
// a native module. Rendering nothing for the media keeps the action row intact.
jest.mock('../ui/DisplayMediaImage.tsx', () => ({
  DisplayMediaImage: () => null,
  AvatarImage: () => null,
}));

// NOTE: intentionally exhaustive — SaveButton imports the saves service graph
// (Supabase + API token stack), which OOMs the runner if pulled in for real.
jest.mock('../SaveButton.tsx', () => ({ SaveButton: () => null }));

// NOTE: intentionally exhaustive — these sheets each pull their own service
// graph and none of them is the subject of this suite.
jest.mock('../HighlightViewersSheet.tsx', () => ({ HighlightViewersSheet: () => null }));
jest.mock('../EngagementUserListSheet.tsx', () => ({ EngagementUserListSheet: () => null }));
jest.mock('../../features/highlights/HighlightPrivacySheet.tsx', () => ({
  HighlightPrivacySheet: () => null,
}));

// NOTE: intentionally exhaustive — UserIdentityLink navigates through the
// router graph; a pass-through wrapper keeps the author row renderable.
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

jest.mock('../../services/highlights.ts', () => ({
  ...jest.requireActual('../../services/highlights.ts'),
  markHighlightViewed: async () => {},
  toggleHighlightLike: async () => ({ ok: false, data: null }),
  replyToHighlight: async () => ({ ok: false, data: null }),
  reportHighlight: async () => ({ ok: false, data: null }),
  deleteHighlight: async () => ({ ok: false, data: null }),
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

const mockPin = jest.fn();
const mockUnpin = jest.fn();
jest.mock('../../features/highlights/lifetimeApi.ts', () => ({
  ...jest.requireActual('../../features/highlights/lifetimeApi.ts'),
  pinHighlight: (...a: unknown[]) => mockPin(...a),
  unpinHighlight: (...a: unknown[]) => mockUnpin(...a),
}));

import { HighlightViewer } from '../HighlightViewer.tsx';
import type { Highlight } from '../../services/highlights.ts';

const OWNER = '11111111-1111-4111-8111-111111111111';
const HID = '22222222-2222-4222-8222-222222222222';
const PINNED_AT = '2026-09-15T10:00:00.000Z';

function highlight(over: Partial<Highlight> = {}): Highlight {
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
    ...over,
  };
}

function viewer(h: Highlight) {
  return (
    <HighlightViewer visible highlights={[h]} currentUserId={OWNER} onClose={() => {}} />
  );
}

describe('HighlightViewer — §12 pin / §17 unpin', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    mockPin.mockReset();
    mockUnpin.mockReset();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('opens an already-pinned Highlight showing UNPIN, from the server’s pinnedAt', async () => {
    const { findByTestId } = await render(viewer(highlight({ pinnedAt: PINNED_AT })));
    // Before `pinnedAt` survived `mapHighlight` this was always the OFF state,
    // and §17's UNPIN_HIGHLIGHT was unreachable for anything pinned earlier.
    expect(await findByTestId('highlight-pin-on')).toBeTruthy();
  });

  it('opens an unpinned Highlight showing PIN', async () => {
    const { findByTestId } = await render(viewer(highlight({ pinnedAt: null })));
    expect(await findByTestId('highlight-pin-off')).toBeTruthy();
  });

  it('unpins through DELETE /highlights/:id/pin and follows the server’s answer', async () => {
    mockUnpin.mockResolvedValue({ ok: true, data: { id: HID, pinnedAt: null } });
    const { findByTestId } = await render(viewer(highlight({ pinnedAt: PINNED_AT })));

    fireEvent.press(await findByTestId('highlight-pin-on'));

    await waitFor(() => expect(mockUnpin).toHaveBeenCalledWith(HID));
    expect(mockPin).not.toHaveBeenCalled();
    expect(await findByTestId('highlight-pin-off')).toBeTruthy();
  });

  it('pins through POST /highlights/:id/pin and follows the server’s answer', async () => {
    mockPin.mockResolvedValue({ ok: true, data: { id: HID, pinnedAt: PINNED_AT } });
    const { findByTestId } = await render(viewer(highlight({ pinnedAt: null })));

    fireEvent.press(await findByTestId('highlight-pin-off'));

    await waitFor(() => expect(mockPin).toHaveBeenCalledWith(HID));
    expect(await findByTestId('highlight-pin-on')).toBeTruthy();
  });

  it('leaves the icon alone when the write is refused, and says so permanently', async () => {
    // Migration 2723 absent: the route answers `feature_disabled`, which is not
    // retryable on this deployment.
    mockPin.mockResolvedValue({
      ok: false,
      kind: 'not_available',
      detail: 'Pinning is not available on this deployment yet.',
    });
    const { findByTestId } = await render(viewer(highlight({ pinnedAt: null })));

    fireEvent.press(await findByTestId('highlight-pin-off'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    const body = String(alertSpy.mock.calls[0][1]);
    expect(body.toLowerCase()).not.toContain('try again');
    // A refused write must not leave a tick behind.
    expect(await findByTestId('highlight-pin-off')).toBeTruthy();
  });
});
