/**
 * WatchItemOverlay — action rail touch-target tests.
 *
 * ## What's covered
 *
 * 1. Each action rail button (Stamp, Comment, Save, Share, Send to a chat,
 *    More options) renders with minWidth ≥ 44 and minHeight ≥ 44, meeting
 *    the WCAG / Apple HIG 44 × 44 pt minimum touch-target guideline.
 * 2. The icon-to-counter gap is 4pt on every button — so the count label
 *    never collapses into the icon after a future style edit.
 *
 * ## Why these tests exist
 *
 * The actionBtn style received an explicit minWidth/minHeight enforcement.
 * Without a test, a future edit that removes or reduces those values would
 * go undetected until a user reports difficulty tapping the rail.
 */

import React from 'react';
import { View } from 'react-native';
import { render, screen } from '@testing-library/react-native';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentional exhaustive stub — expo-router's actual implementation
// relies on NavigationContainer and native navigation context unavailable in
// Jest. Only the router object shape is needed; navigation is not under test.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

// NOTE: intentional exhaustive stub — safe-area insets are not under test;
// a predictable zero-inset return value is all that is needed so layout
// arithmetic does not vary across environments.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('expo-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  // NOTE: intentional exhaustive stub — LinearGradient is a visual-only
  // decoration not relevant to touch-target assertions.
  return {
    LinearGradient: ({ children, ...rest }: any) => (
      <View {...rest}>{children}</View>
    ),
  };
});

// NOTE: intentional exhaustive stub — useFollow network + auth behaviour is
// not under test; a stable non-loading state is sufficient.
jest.mock('../../../hooks/useFollow', () => ({
  useFollow: () => ({
    isFollowing: false,
    loading: false,
    toggling: false,
    followsYou: false,
    followersCount: 0,
    followingCount: 0,
    toggle: jest.fn(),
  }),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { WatchItemOverlay } from '../WatchItemOverlay.tsx';
import type { MediaFeedItem } from '../../../types/media.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<MediaFeedItem> = {}): MediaFeedItem {
  return {
    id: 'item-1',
    videoUrl: 'https://example.com/video.mp4',
    posterUrl: null,
    duration: null,
    creator: {
      id: 'user-uuid-123',
      displayName: 'Jane Doe',
      username: 'janedoe',
      avatarUrl: null,
      isFollowing: false,
    },
    caption: 'Hello world!',
    hashtags: [],
    place: null,
    linkedEntity: null,
    audioLabel: null,
    likeCount: 10,
    commentCount: 2,
    saveCount: 3,
    likedByMe: false,
    savedByMe: false,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WatchItemOverlay action rail touch targets', () => {
  let stampGroupRef: React.RefObject<View | null>;

  beforeEach(() => {
    stampGroupRef = React.createRef<View>();
  });

  /**
   * Renders the overlay with all required stamp props so every rail button
   * is present in the tree.
   */
  async function renderOverlay(itemOverrides: Partial<MediaFeedItem> = {}) {
    await render(
      <WatchItemOverlay
        item={makeItem(itemOverrides)}
        currentUserId="other-user"
        isSaved={false}
        onComment={jest.fn()}
        onSave={jest.fn()}
        onMore={jest.fn()}
        stampGroupRef={stampGroupRef}
        stampVisualIsStamped={false}
        stampVisualCount={5}
        stampButtonStyle={{}}
        onStampPress={jest.fn()}
      />,
    );
  }

  // ── Individual button assertions ─────────────────────────────────────────

  const RAIL_LABELS = [
    'Stamp',
    'Comment',
    'Save',
    'Share',
    'Send to a chat',
    'More options',
  ] as const;

  it.each(RAIL_LABELS)(
    'renders "%s" button with minWidth ≥ 44 and minHeight ≥ 44',
    async (label) => {
      await renderOverlay();
      const btn = screen.getByRole('button', { name: label });
      expect(btn).toHaveStyle({ minWidth: 44, minHeight: 44 });
    },
  );

  it.each(RAIL_LABELS)(
    'renders "%s" button with icon-to-counter gap of 4pt',
    async (label) => {
      await renderOverlay();
      const btn = screen.getByRole('button', { name: label });
      expect(btn).toHaveStyle({ gap: 4 });
    },
  );

  it('renders all six rail buttons in a single pass', async () => {
    await renderOverlay();

    for (const label of RAIL_LABELS) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
  });
});

// ── Save button active-state label tests ──────────────────────────────────────

describe('WatchItemOverlay Save button accessibility label', () => {
  let stampGroupRef: React.RefObject<View | null>;

  beforeEach(() => {
    stampGroupRef = React.createRef<View>();
  });

  async function renderOverlayWithSaved(isSaved: boolean) {
    await render(
      <WatchItemOverlay
        item={makeItem()}
        currentUserId="other-user"
        isSaved={isSaved}
        onComment={jest.fn()}
        onSave={jest.fn()}
        onMore={jest.fn()}
        stampGroupRef={stampGroupRef}
        stampVisualIsStamped={false}
        stampVisualCount={0}
        stampButtonStyle={{}}
        onStampPress={jest.fn()}
      />,
    );
  }

  it('labels the Save button "Unsave" when isSaved=true', async () => {
    await renderOverlayWithSaved(true);
    expect(screen.getByRole('button', { name: 'Unsave' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('labels the Save button "Save" when isSaved=false', async () => {
    await renderOverlayWithSaved(false);
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Unsave' })).toBeNull();
  });
});

// ── Stamp active-state label tests ────────────────────────────────────────────

describe('WatchItemOverlay stamp button active state', () => {
  let stampGroupRef: React.RefObject<View | null>;

  function renderWithStampState(stampVisualIsStamped: boolean) {
    return render(
      <WatchItemOverlay
        item={(() => ({
          id: 'item-stamp',
          videoUrl: 'https://example.com/video.mp4',
          posterUrl: null,
          duration: null,
          creator: {
            id: 'user-uuid-123',
            displayName: 'Jane Doe',
            username: 'janedoe',
            avatarUrl: null,
            isFollowing: false,
          },
          // MediaFeedItem.caption is a non-nullable string — a captionless item
          // is the empty string, not null.
          caption: '',
          hashtags: [],
          place: null,
          linkedEntity: null,
          audioLabel: null,
          likeCount: 0,
          commentCount: 0,
          saveCount: 0,
          likedByMe: false,
          savedByMe: false,
        }))()}
        currentUserId="other-user"
        isSaved={false}
        onComment={jest.fn()}
        onSave={jest.fn()}
        onMore={jest.fn()}
        stampGroupRef={stampGroupRef}
        stampVisualIsStamped={stampVisualIsStamped}
        stampVisualCount={0}
        stampButtonStyle={{}}
        onStampPress={jest.fn()}
      />,
    );
  }

  beforeEach(() => {
    stampGroupRef = React.createRef<View>();
  });

  it('shows label "Unstamp" when viewer has already stamped (stampVisualIsStamped=true)', async () => {
    await renderWithStampState(true);
    expect(screen.getByRole('button', { name: 'Unstamp' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stamp' })).toBeNull();
  });

  it('shows label "Stamp" when viewer has not yet stamped (stampVisualIsStamped=false)', async () => {
    await renderWithStampState(false);
    expect(screen.getByRole('button', { name: 'Stamp' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Unstamp' })).toBeNull();
  });
});
