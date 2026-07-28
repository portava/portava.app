/**
 * WatchItemOverlay — Stamp It long-press behaviour tests.
 *
 * ## What's covered
 *
 * 1. Long-pressing the Like button on an *unliked* item calls onLike exactly
 *    once (Stamp It acts as an idempotent "like if needed" action).
 * 2. Long-pressing the Like button on an *already-liked* item does NOT call
 *    onLike (Stamp It must never accidentally unlike content).
 * 3. Short-pressing the Like button still calls onLike normally (regression guard).
 *
 * ## Why these tests exist
 *
 * The `handleStampIt` callback gates `onLike()` on `!isLiked` because `onLike`
 * is wired to a toggle in the feed. Without this guard a user long-pressing the
 * heart on content they've already liked would silently remove the like.
 *
 * Press-budget note: each fireEvent.press counts toward the ~2-per-file
 * budget of this jest-expo / RNTL v14 / React 19 renderer. Tests that need
 * more press calls live in WatchItemOverlay.stampIt.guard.component.test.tsx.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentional exhaustive stub — expo-router's NavigationContainer and
// native navigation context are unavailable in Jest; only router.push is needed.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

// NOTE: intentional stub — safe-area insets are not under test; zero insets
// ensure layout is stable across environments.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// NOTE: intentional stub — LinearGradient requires a native renderer; only
// its children pass-through matters for overlay structure tests.
jest.mock('expo-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    LinearGradient: ({ children, ...rest }: any) => <View {...rest}>{children}</View>,
  };
});

// NOTE: intentional stub — useFollow network behaviour is not under test.
jest.mock('../../../hooks/useFollow', () => ({
  useFollow: () => ({
    isFollowing: false,
    loading: false,
    toggling: false,
    toggle: jest.fn(),
  }),
}));

// NOTE: intentional stub — haptics requires a native module unavailable in Jest.
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Heavy: 'Heavy', Medium: 'Medium', Light: 'Light' },
}));

// NOTE: intentional stub — admireStamp makes authenticated fetch calls; not
// under test here (fail-soft behaviour is tested in the service layer tests).
jest.mock('../../../services/stampAdmire', () => ({
  admireStamp: jest.fn().mockResolvedValue(true),
}));

// NOTE: intentional stub — StampItBurst is a pure RN Animated component; mock
// it so the imperative handle is a stable no-op and the ref never throws.
jest.mock('../StampItBurst.tsx', () => {
  const React = require('react');
  const { forwardRef, useImperativeHandle } = React;
  const StampItBurst = forwardRef((_: any, ref: any) => {
    useImperativeHandle(ref, () => ({ trigger: jest.fn() }));
    return null;
  });
  StampItBurst.displayName = 'StampItBurst';
  return { StampItBurst };
});

// NOTE: intentional stub — PlanPickerController has a safe null-context fallback,
// but mocking it makes the dependency explicit and avoids any provider errors.
jest.mock('../../PlanPickerController.tsx', () => ({
  usePlanPicker: () => ({ open: jest.fn(), isAdded: () => false }),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { WatchItemOverlay } from '../WatchItemOverlay.tsx';
import type { MediaFeedItem } from '../../../types/media.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<MediaFeedItem> = {}): MediaFeedItem {
  return {
    id: 'video-abc',
    videoUrl: 'https://example.com/video.mp4',
    posterUrl: null,
    duration: null,
    creator: {
      id: 'user-1',
      displayName: 'Alice',
      username: 'alice',
      avatarUrl: null,
      isFollowing: false,
    },
    caption: 'A great travel video',
    hashtags: [],
    place: null,
    linkedEntity: null,
    audioLabel: null,
    likeCount: 5,
    commentCount: 1,
    saveCount: 0,
    likedByMe: false,
    savedByMe: false,
    ...overrides,
  };
}

function makeProps(overrides: Partial<React.ComponentProps<typeof WatchItemOverlay>> = {}) {
  return {
    item: makeItem(),
    currentUserId: 'viewer-x',
    isLiked: false,
    isSaved: false,
    likeCount: 5,
    onLike: jest.fn(),
    onComment: jest.fn(),
    onSave: jest.fn(),
    onMore: jest.fn(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
// Press budget: 1 out of ~2 used in this file (test 3).
// The long-press+press guard tests live in .stampIt.guard.component.test.tsx.

describe('Stamp It — long-press like button', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls onLike when the item is not yet liked — Stamp It acts as like', async () => {
    const onLike = jest.fn();
    await render(<WatchItemOverlay {...makeProps({ onLike, isLiked: false })} />);

    // fireEvent(el, 'longPress') does not count toward the press budget.
    fireEvent(screen.getByLabelText('Like'), 'longPress');

    expect(onLike).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onLike when the item is already liked — Stamp It must never unlike', async () => {
    const onLike = jest.fn();
    await render(<WatchItemOverlay {...makeProps({ onLike, isLiked: true })} />);

    fireEvent(screen.getByLabelText('Unlike'), 'longPress');

    expect(onLike).not.toHaveBeenCalled();
  });

  it('short-press on Like still calls onLike normally — not broken by long-press addition', async () => {
    // Press budget: 1 of ~2 consumed here.
    const onLike = jest.fn();
    await render(<WatchItemOverlay {...makeProps({ onLike, isLiked: false })} />);

    fireEvent.press(screen.getByLabelText('Like'));

    expect(onLike).toHaveBeenCalledTimes(1);
  });
});
