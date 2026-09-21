/**
 * W170 / spec §36 — "Video controls remain keyboard/screen-reader accessible."
 *
 * WHY THIS FILE EXISTS. The census graded this row CANNOT-VERIFY on the grounds
 * that "the transport controls belong to SharedVideoPlayer and their
 * screen-reader behaviour needs a device". Half of that is true and half is not,
 * and the census itself (§7.3) says so: the argument that moved W174 out of the
 * same bucket applies here unchanged. A screen reader reads the ACCESSIBILITY
 * TREE the app hands the platform — roles, labels, and how those labels change
 * with state — and @testing-library/react-native renders exactly that tree. What
 * needs a device is how a REAL screen reader TRAVERSES it and how it sounds;
 * what the spec asks for here is that the controls are in it at all, correctly
 * described, which is decidable in code.
 *
 * WHAT IS ASSERTED, AND WHY IT IS NOT THE SAME AS THE EXISTING TESTS.
 * `src/components/ui/__tests__/SharedVideoPlayer.component.test.tsx` reaches the
 * player's controls by label, which pins the labels of the SHARED component in
 * isolation. It says nothing about the WALL: the Wall could mount the player in
 * a way that removes the controls from the tree (a `pointerEvents="none"`
 * wrapper, an `importantForAccessibility="no-hide-descendants"` frame, an
 * overlay that covers them), and that file would stay green. This file renders
 * the REAL `VideoWallItem` with the REAL `SharedVideoPlayer` inside it — only
 * expo-av's native `Video` is stubbed — and asserts over the tree the Wall
 * actually produces.
 *
 * Three properties, each a separate regression:
 *   1. Every transport control is reachable and carries BOTH an
 *      `accessibilityRole` and a non-empty `accessibilityLabel`. This is a SWEEP
 *      over the mounted item, not a list of known labels, so a NEW unlabelled
 *      control added to the video card fails here too.
 *   2. The labels are STATEFUL: play/pause and mute/unmute announce what the
 *      control will DO next, which is the difference between an accessible
 *      control and a labelled one. A static "Video" label would pass a
 *      presence check and be useless to a screen-reader user.
 *   3. The poster fallback — the state a reduce-motion user actually gets — is
 *      itself a labelled button, so the video is operable when the inline
 *      player is deliberately never mounted (§36 reduced motion).
 *
 * WHAT STILL NEEDS A DEVICE, and the census row says so: whether VoiceOver or
 * TalkBack announce this tree in a useful ORDER and with useful phrasing, and
 * whether an external keyboard can reach the controls on a physical device. This
 * file makes no claim about either.
 *
 * MUTATION PROOF (each verified: apply → RED, restore → GREEN) — see the census
 * entry for W170 for the measured pass/fail counts.
 */

import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

// NOTE: exhaustive-by-design mock — the real wallApi loads the supabase /
// apiToken chain at import, which would crash the jest suite. wallItemShared
// (imported transitively by VideoWallItem) imports it.
jest.mock('../../../services/wallApi.ts', () => ({
  fetchWall: jest.fn(),
  fetchLiveForYou: jest.fn(),
  setSessionIntent: jest.fn(),
  clearSessionIntent: jest.fn(),
  sendImpression: jest.fn(),
  sendAction: jest.fn(),
}));

// NOTE: exhaustive-by-design mock — expo-av's Video is a native module with no
// jest-expo implementation. Only the native surface is stubbed; the REAL
// SharedVideoPlayer (and therefore its real accessibility tree) is what runs.
const mockPlayAsync = jest.fn().mockResolvedValue(undefined);
const mockPauseAsync = jest.fn().mockResolvedValue(undefined);
const mockSetStatusAsync = jest.fn().mockResolvedValue(undefined);
let capturedStatusCallback: ((s: any) => void) | null = null;

jest.mock('expo-av', () => {
  const ReactLocal = require('react');
  const { View } = require('react-native');
  const Video = ReactLocal.forwardRef(
    ({ onPlaybackStatusUpdate, testID, ...rest }: any, ref: any) => {
      capturedStatusCallback = onPlaybackStatusUpdate ?? null;
      ReactLocal.useImperativeHandle(ref, () => ({
        playAsync: mockPlayAsync,
        pauseAsync: mockPauseAsync,
        setStatusAsync: mockSetStatusAsync,
      }));
      return ReactLocal.createElement(View, { testID: testID ?? 'mock-video', ...rest });
    },
  );
  Video.displayName = 'Video';
  return { Video, ResizeMode: { COVER: 'cover', CONTAIN: 'contain' } };
});

import { VideoWallItem } from '../VideoWallItem.tsx';
import { WallItemVisibilityProvider } from '../../../hooks/useWallItemVisibility.tsx';
import type { VideoProjection } from '../../../types/wallProjection.ts';

const NOW = new Date().toISOString();

function videoProjection(): VideoProjection {
  return {
    projectionId: 'v1',
    canonicalObjectId: 'c-v1',
    objectType: 'video',
    inlinePlayback: true,
    publishedAt: NOW,
    visibility: 'public',
    text: 'A short clip',
    media: [
      {
        mediaId: 'm1',
        kind: 'video',
        url: 'https://example.com/clip.mp4',
        thumbnailUrl: 'https://example.com/clip.jpg',
      },
    ],
    actions: [],
  } as VideoProjection;
}

function renderItem(visible = true) {
  return render(
    <WallItemVisibilityProvider visibleIds={visible ? new Set(['v1']) : new Set<string>()}>
      <VideoWallItem projection={videoProjection()} />
    </WallItemVisibilityProvider>,
  );
}

/**
 * Every element in the RENDERED tree that a screen reader would treat as an
 * operable control. `onPress` is the operable surface in React Native; the
 * question the spec asks is whether each one announces itself.
 */
/** Every HOST node in the rendered tree. `screen.root` is the host tree — the
 *  same nodes the platform hands an assistive technology — so nothing composite
 *  is counted and every hit is a real view. */
function hostNodes(): any[] {
  const out: any[] = [];
  const visit = (n: any) => {
    if (!n || typeof n !== 'object') return;
    out.push(n);
    for (const c of n.children ?? []) visit(c);
  };
  visit((screen as any).root);
  return out;
}

/**
 * Every node a screen reader can OPERATE. React Native lowers a `Pressable` to a
 * host view carrying the Pressability responder handlers; `onStartShouldSetResponder`
 * is that signature and is present on exactly the touchable hosts, which is why
 * the predicate is written on it rather than on `onPress` (which never reaches
 * the host tree) or on `accessibilityRole` (which is the thing under test and
 * would make the sweep circular — an unlabelled control would simply not be
 * counted).
 */
function operableControls(): any[] {
  return hostNodes().filter((n) => typeof n.props?.onStartShouldSetResponder === 'function');
}

let reduceMotionSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  capturedStatusCallback = null;
  reduceMotionSpy = jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
});
afterEach(() => {
  reduceMotionSpy.mockRestore();
});

describe('§36 / W170 — video transport controls in the Wall accessibility tree', () => {
  it('mounts the REAL shared player inside the Wall item (guard against a vacuous pass)', async () => {
    await renderItem();
    // If this ever fails the assertions below are testing the poster fallback,
    // not the transport controls, and would pass while proving nothing.
    expect(await screen.findByTestId('mock-video')).toBeTruthy();
  });

  it('exposes play/pause and mute as labelled buttons the Wall does not hide', async () => {
    await renderItem();
    await screen.findByTestId('mock-video');

    // The transport controls SharedVideoPlayer owns, reached through the Wall's
    // own render — not through the shared component in isolation. The Wall
    // mounts a visible video with muted autoplay ON (§11), so the play/pause
    // control's initial announcement is "Pause video".
    const playPause = screen.getByLabelText('Pause video');
    const mute = screen.getByLabelText('Unmute');
    expect(playPause.props.accessibilityRole).toBe('button');
    expect(mute.props.accessibilityRole).toBe('button');

    // …and the Wall's own control on top of the player.
    const openViewer = screen.getByLabelText('Open video');
    expect(openViewer.props.accessibilityRole).toBe('button');

    // The Wall must not put the player behind an accessibility-hiding wrapper.
    // `getByLabelText` above already fails when a control leaves the tree; this
    // pins the specific prop that would do it silently at any ancestor.
    const hidden = hostNodes()
      .filter(
        (n) =>
          n.props?.importantForAccessibility === 'no-hide-descendants' ||
          n.props?.accessibilityElementsHidden === true,
      )
      .map((n) => String(n.props?.testID ?? n.type));
    expect(hidden).toEqual([]);
  });

  it('EVERY operable control in the video card announces itself (role + non-empty label)', async () => {
    await renderItem();
    await screen.findByTestId('mock-video');

    const controls = operableControls();
    // Guard against a vacuous sweep: the card has at least the three controls
    // above (tap-zone, mute, open-viewer).
    expect(controls.length).toBeGreaterThanOrEqual(3);

    const unlabelled = controls
      .filter(
        (c) =>
          typeof c.props.accessibilityLabel !== 'string' ||
          c.props.accessibilityLabel.trim() === '' ||
          typeof c.props.accessibilityRole !== 'string',
      )
      .map((c) => ({
        role: c.props.accessibilityRole ?? null,
        label: c.props.accessibilityLabel ?? null,
        testID: c.props.testID ?? null,
      }));
    expect(unlabelled).toEqual([]);
  });

  it('the labels are STATEFUL — they say what the control will do next', async () => {
    await renderItem();
    await screen.findByTestId('mock-video');

    // Autoplaying → "Pause video". Report playback stopped → "Play video", and
    // back again. A static label would pass a presence check and tell a
    // screen-reader user nothing about what pressing it does.
    expect(screen.getByLabelText('Pause video')).toBeTruthy();
    expect(screen.queryByLabelText('Play video')).toBeNull();
    await act(async () => {
      capturedStatusCallback?.({ isLoaded: true, isPlaying: false, didJustFinish: false });
    });
    expect(screen.getByLabelText('Play video')).toBeTruthy();
    expect(screen.queryByLabelText('Pause video')).toBeNull();
    await act(async () => {
      capturedStatusCallback?.({ isLoaded: true, isPlaying: true, didJustFinish: false });
    });
    expect(screen.getByLabelText('Pause video')).toBeTruthy();

    // Muted → "Unmute". Press it → "Mute", and the player is actually told.
    const mute = screen.getByLabelText('Unmute');
    await act(async () => {
      fireEvent.press(mute);
    });
    expect(mockSetStatusAsync).toHaveBeenCalledWith({ isMuted: false });
    expect(screen.getByLabelText('Mute')).toBeTruthy();
  });

  it('the reduced-motion fallback is itself an operable, labelled control (§36)', async () => {
    reduceMotionSpy.mockResolvedValue(true);
    await renderItem();

    // The inline player is deliberately never mounted under reduce motion, so
    // the poster IS the control — it must still be reachable and labelled.
    const poster = await screen.findByLabelText('Play video');
    expect(poster.props.accessibilityRole).toBe('button');
    expect(screen.queryByTestId('mock-video')).toBeNull();

    for (const c of operableControls()) {
      expect(typeof c.props.accessibilityLabel).toBe('string');
      expect(String(c.props.accessibilityLabel).trim()).not.toBe('');
      expect(typeof c.props.accessibilityRole).toBe('string');
    }
  });
});
