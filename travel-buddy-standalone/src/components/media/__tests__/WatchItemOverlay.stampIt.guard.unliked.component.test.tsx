/**
 * WatchItemOverlay — Stamp It guard: unliked item (long-press → press lifecycle).
 *
 * ## What's covered
 *
 * Long-pressing then pressing the Like button on an *unliked* item calls onLike
 * exactly once — the internal `longPressJustFiredRef` guard absorbs the spurious
 * onPress that React Native fires on finger-up after onLongPress, preventing an
 * immediate unlike of what Stamp It just liked.
 *
 * ## Why a dedicated file
 *
 * Each `fireEvent.press` consumes the ~2-per-file press budget of the
 * jest-expo / RNTL v14 / React 19 renderer, and a key-swap render after a press
 * returns the stale tree (rule 3 + rule 7 of the renderer budget). Keeping exactly
 * ONE press per file guarantees reliable dispatch and query for this assertion.
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

// ── Test (one press per file — renderer budget rule) ──────────────────────────

it('long-press then press on unliked item: onLike fires exactly once — guard absorbs spurious release press', async () => {
  const onLike = jest.fn();
  await render(
    <WatchItemOverlay
      item={makeItem()}
      currentUserId="viewer-x"
      isLiked={false}
      isSaved={false}
      likeCount={5}
      onLike={onLike}
      onComment={jest.fn()}
      onSave={jest.fn()}
      onMore={jest.fn()}
    />,
  );

  const likeBtn = screen.getByLabelText('Like');
  // Simulate the full RN lifecycle: long-press fires, then onPress fires on finger-up.
  fireEvent(likeBtn, 'longPress');
  fireEvent.press(likeBtn); // press budget: 1 of ~2 (only press in this file)

  // Total: exactly one like — the Stamp It like; the release press was absorbed.
  expect(onLike).toHaveBeenCalledTimes(1);
});
