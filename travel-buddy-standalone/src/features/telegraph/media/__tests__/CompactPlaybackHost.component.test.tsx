/**
 * CompactPlaybackHost — Telegraph §6.3 "Picture-in-picture or compact playback
 * can continue while the user scrolls" (census-telegraph T62).
 *
 * WHAT THIS PINS, against the real bubble, the real source hook and the real
 * shared player (only expo-av's native view is a stand-in, counting mounts):
 *   1. Tapping a thread video opens it full screen in the ROOT host, playing.
 *   2. Minimize docks it — the SAME player instance (one mount, no unmount, no
 *      seek, no reload) — and the thread underneath stays usable.
 *   3. The list scrolling the bubble out of its window (the bubble unmounts)
 *      leaves the docked player mounted and playing.
 *   4. Expand brings the same instance back full screen.
 *   5. Fail-closed stops (owner question Q-PB1's default): route change,
 *      unsend/delete/hide reaching the thread, realtime unsend naming it,
 *      block (lists and realtime), leaving (source loses access, own
 *      member.left), sign-out, the thread unmounting, a refused signature,
 *      playback ending, Stop, Android back.
 *   6. A video no open conversation holds never plays.
 *
 * NOTE: named `.component.test.tsx` so the jest `test:component` pattern runs it.
 */
import React from 'react';
import { Alert, BackHandler, FlatList, Text, View } from 'react-native';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { MessageMediaBubble } from '../../../../components/MessageMediaBubble.tsx';
import { CompactPlaybackHost } from '../CompactPlaybackHost.tsx';
import { useCompactPlaybackSource } from '../useCompactPlaybackSource.ts';
import {
  _resetCompactPlaybackForTests,
  getCompactPlayback,
  lastPlaybackStopReason,
} from '../compactPlaybackStore.ts';

// ── expo-av: the native view, counting mounts ──────────────────────────────
const mockVideo = { mounts: 0, unmounts: 0, lastProps: null as any };
const mockPlayAsync = jest.fn().mockResolvedValue(undefined);
const mockPauseAsync = jest.fn().mockResolvedValue(undefined);
const mockSetStatusAsync = jest.fn().mockResolvedValue(undefined);
jest.mock('expo-av', () => {
  const R = require('react');
  const { View: V } = require('react-native');
  const Video = R.forwardRef((props: any, ref: any) => {
    mockVideo.lastProps = props;
    R.useEffect(() => {
      mockVideo.mounts += 1;
      return () => { mockVideo.unmounts += 1; };
    }, []);
    R.useImperativeHandle(ref, () => ({
      playAsync: mockPlayAsync,
      pauseAsync: mockPauseAsync,
      setStatusAsync: mockSetStatusAsync,
    }));
    return <V testID="native-video" />;
  });
  Video.displayName = 'Video';
  return { Video, ResizeMode: { COVER: 'cover', CONTAIN: 'contain' } };
});

// A reference signs to a recognisable URL; `mockRefused` makes one come back
// refused (null), as the sign endpoint does. The result is memoised per input,
// like the real hook's state: a fresh object per render would loop any consumer
// whose effect depends on it (the poster).
const mockRefused = new Set<string>();
const mockHydrated = new Map<string, { resolved: Record<string, string | null>; loading: boolean }>();
// NOTE: intentional stub — `services/mediaUrl.ts` reaches lib/supabase, which
// builds a client at import time.
jest.mock('../../../../services/mediaUrl.ts', () => ({
  PRIVATE_BUCKETS: ['post-media', 'profile-media'],
  hydrateMediaUrls: jest.fn(async () => ({})),
  isPrivateMediaRef: () => true,
  useHydratedMedia: (urls: (string | null | undefined)[]) => {
    const list = urls.filter(Boolean) as string[];
    const k = `${list.join('\u0000')}|${[...mockRefused].join(',')}`;
    let v = mockHydrated.get(k);
    if (!v) {
      v = {
        resolved: Object.fromEntries(list.map((u) => [u, mockRefused.has(u) ? null : `https://signed.example/${u}`])),
        loading: false,
      };
      mockHydrated.set(k, v);
    }
    return v;
  },
}));

let mockUserId: string | null = 'me-1';
// NOTE: intentionally exhaustive — SessionContext boots the Supabase client;
// the host reads only the signed-in account.
jest.mock('../../../../context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: mockUserId }),
}));

let mockBlocked = new Set<string>();
let mockBlocker = new Set<string>();
// NOTE: intentionally exhaustive — the provider loads lists over the network;
// the host reads only the two sets.
jest.mock('../../../../context/BlockedIdsContext.tsx', () => ({
  useBlockedIds: () => ({ blockedIds: mockBlocked, blockerIds: mockBlocker }),
}));

const mockRealtime: Array<(e: unknown) => void> = [];
// NOTE: intentionally exhaustive — the realtime service opens a stream on use.
jest.mock('../../../../services/telegraphRealtimeService.ts', () => ({
  telegraphRealtime: {
    subscribe: (l: (e: unknown) => void) => {
      mockRealtime.push(l);
      return () => {
        const i = mockRealtime.indexOf(l);
        if (i >= 0) mockRealtime.splice(i, 1);
      };
    },
  },
}));

let mockPath = '/messages/t-1';
let mockParams: Record<string, string> = {};
// NOTE: intentionally exhaustive — the host reads only the route identity.
jest.mock('expo-router', () => ({
  usePathname: () => mockPath,
  useGlobalSearchParams: () => mockParams,
  useLocalSearchParams: () => ({}),
  router: { push: () => {}, replace: () => {}, back: () => {} },
}));

// ── A thread screen: the real source hook + the real bubble in a FlatList ──
type Msg = {
  id: string; senderId: string; deleted: boolean; msgType: string;
  mediaType: 'video' | 'image' | null; mediaUrl: string | null; mediaThumbnailUrl: string | null; body: string | null;
};
const REF = 'post-media/u-2/clip.mp4';
const VIDEO = (over: Partial<Msg> = {}): Msg => ({
  id: 'm-1', senderId: 'u-2', deleted: false, msgType: 'media', mediaType: 'video',
  mediaUrl: REF, mediaThumbnailUrl: 'post-media/u-2/clip.jpg', body: null, ...over,
});
const TEXT = (id: string): Msg => ({
  id, senderId: 'u-2', deleted: false, msgType: 'text', mediaType: null, mediaUrl: null, mediaThumbnailUrl: null, body: `text ${id}`,
});

function Thread({ messages, shown, live = true }: { messages: Msg[]; shown: string[]; live?: boolean }) {
  useCompactPlaybackSource('t-1', messages, live);
  return (
    <FlatList
      testID="thread-list"
      data={messages.filter((m) => shown.includes(m.id))}
      keyExtractor={(m) => m.id}
      renderItem={({ item }) =>
        item.msgType === 'media' && item.mediaUrl ? (
          <MessageMediaBubble
            mediaType="video"
            mediaUrl={item.mediaUrl}
            thumbnailUrl={item.mediaThumbnailUrl}
            mine={false}
            createdAt="2026-10-14T10:00:00Z"
          />
        ) : (
          <Text>{item.body ?? 'This message was deleted.'}</Text>
        )
      }
    />
  );
}

const INSETS = { top: 0, bottom: 0, left: 0, right: 0 };
function App({ messages = [TEXT('m-0'), VIDEO()], shown = ['m-0', 'm-1'], live = true, thread = true }: {
  messages?: Msg[]; shown?: string[]; live?: boolean; thread?: boolean;
}) {
  return (
    <SafeAreaInsetsContext.Provider value={INSETS}>
      <View style={{ flex: 1 }}>
        {thread ? <Thread messages={messages} shown={shown} live={live} /> : null}
        <CompactPlaybackHost />
      </View>
    </SafeAreaInsetsContext.Provider>
  );
}

async function openVideo() {
  const view = await render(<App />);
  await fireEvent.press(screen.getByLabelText('Play video'));
  return view;
}

function emit(evt: unknown) {
  for (const l of [...mockRealtime]) l(evt);
}

beforeEach(() => {
  _resetCompactPlaybackForTests();
  mockVideo.mounts = 0;
  mockVideo.unmounts = 0;
  mockVideo.lastProps = null;
  mockRefused.clear();
  mockHydrated.clear();
  mockUserId = 'me-1';
  mockBlocked = new Set();
  mockBlocker = new Set();
  mockRealtime.length = 0;
  mockPath = '/messages/t-1';
  mockParams = {};
  jest.clearAllMocks();
});

afterEach(async () => {
  await act(async () => {});
  cleanup();
  jest.restoreAllMocks();
});

describe('T62 — one playback, outside the list', () => {
  it('opens the tapped video full screen in the root host, signed and playing', async () => {
    await openVideo();
    expect(screen.getByTestId('compact-playback-expanded')).toBeTruthy();
    expect(mockVideo.mounts).toBe(1);
    expect(mockVideo.lastProps.source).toEqual({ uri: `https://signed.example/${REF}` });
    expect(mockVideo.lastProps.shouldPlay).toBe(true);
    expect(screen.getByLabelText('Minimize video')).toBeTruthy();
    expect(screen.getByLabelText('Stop video')).toBeTruthy();
  });

  it('minimize docks the SAME player: one mount, no unmount, no seek, no reload', async () => {
    await openVideo();
    const sourceBefore = mockVideo.lastProps.source;
    await fireEvent.press(screen.getByLabelText('Minimize video'));
    expect(screen.getByTestId('compact-playback-docked')).toBeTruthy();
    expect(screen.queryByTestId('compact-playback-expanded') === null).toBe(true);
    expect(mockVideo.mounts).toBe(1);
    expect(mockVideo.unmounts).toBe(0);
    // The same source by value (SharedVideoPlayer builds the object per render,
    // as it always has; the native view reloads only on a different URI).
    expect(mockVideo.lastProps.source).toEqual(sourceBefore);
    expect(mockSetStatusAsync).not.toHaveBeenCalledWith(expect.objectContaining({ positionMillis: expect.anything() }));
    expect(mockPauseAsync).not.toHaveBeenCalled();
    // The thread is still there and still usable underneath.
    expect(screen.getByTestId('thread-list')).toBeTruthy();
    expect(screen.getByText('text m-0')).toBeTruthy();
  });

  it('keeps playing while the list scrolls the bubble out of its window (the bubble unmounts)', async () => {
    const view = await openVideo();
    await fireEvent.press(screen.getByLabelText('Minimize video'));
    // Virtualised away: the bubble is gone, the message is still in the thread.
    await act(async () => { await view.rerender(<App shown={['m-0']} />); });
    expect(screen.queryByLabelText('Play video') === null).toBe(true);
    expect(screen.getByTestId('compact-playback-docked')).toBeTruthy();
    expect(mockVideo.mounts).toBe(1);
    expect(mockVideo.unmounts).toBe(0);
    expect(mockVideo.lastProps.shouldPlay).toBe(true);
    expect(getCompactPlayback()?.mediaRef).toBe(REF);
  });

  it('expand brings the same instance back full screen', async () => {
    await openVideo();
    await fireEvent.press(screen.getByLabelText('Minimize video'));
    await fireEvent.press(screen.getByLabelText('Expand video'));
    expect(screen.getByTestId('compact-playback-expanded')).toBeTruthy();
    expect(mockVideo.mounts).toBe(1);
    expect(mockVideo.unmounts).toBe(0);
  });

  it('a video no open conversation holds never plays', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    // A thread is open, but it does not hold this video as a live message.
    await render(
      <SafeAreaInsetsContext.Provider value={INSETS}>
        <Thread messages={[TEXT('m-0'), VIDEO({ deleted: true })]} shown={['m-0']} />
        <MessageMediaBubble mediaType="video" mediaUrl={REF} mine={false} createdAt="2026-10-14T10:00:00Z" />
        <CompactPlaybackHost />
      </SafeAreaInsetsContext.Provider>,
    );
    await fireEvent.press(screen.getByLabelText('Play video'));
    expect(getCompactPlayback()).toBeNull();
    expect(mockVideo.mounts).toBe(0);
    expect(alert).toHaveBeenCalledWith('Video unavailable', expect.any(String));
  });
});

describe('T62 — fail-closed stops (Q-PB1 default: the opening conversation only)', () => {
  async function docked() {
    const view = await openVideo();
    await fireEvent.press(screen.getByLabelText('Minimize video'));
    expect(screen.getByTestId('compact-playback-docked')).toBeTruthy();
    return view;
  }
  // Booleans, not toBeNull() on an element: a failing toBeNull() makes jest
  // pretty-print the whole host tree, which exhausts the worker's heap.
  function expectStopped(reason: string) {
    expect(lastPlaybackStopReason()).toBe(reason);
    expect(screen.queryByTestId('compact-playback-host') === null).toBe(true);
    expect(mockVideo.unmounts).toBe(1);
  }

  it('leaving the conversation\'s route', async () => {
    const view = await docked();
    mockPath = '/messages';
    await act(async () => { await view.rerender(<App />); });
    expectStopped('route');
  });

  it('the same path with another conversation\'s params', async () => {
    mockPath = '/trip/chat'; mockParams = { id: 'trip-A' };
    const view = await docked();
    mockParams = { id: 'trip-B' };
    await act(async () => { await view.rerender(<App />); });
    expectStopped('route');
  });

  it('an unsend or delete reaching the thread (the message becomes a tombstone)', async () => {
    const view = await docked();
    await act(async () => {
      await view.rerender(<App messages={[TEXT('m-0'), VIDEO({ deleted: true, mediaUrl: null, mediaType: null })]} shown={['m-0']} />);
    });
    expectStopped('message_gone');
  });

  it('a hide reaching the thread (the message leaves it)', async () => {
    const view = await docked();
    await act(async () => { await view.rerender(<App messages={[TEXT('m-0')]} shown={['m-0']} />); });
    expectStopped('message_gone');
  });

  it('a realtime unsend naming the message, before the thread re-reads', async () => {
    await docked();
    await act(async () => { emit({ type: 'message.unsent', threadId: 't-1', payload: { messageId: 'm-0' } }); });
    expect(screen.getByTestId('compact-playback-docked')).toBeTruthy();
    await act(async () => { emit({ type: 'message.unsent', threadId: 't-1', payload: { messageId: 'm-1' } }); });
    expectStopped('message_gone');
  });

  it('a realtime delete naming the message', async () => {
    await docked();
    await act(async () => { emit({ type: 'message.deleted', threadId: 't-1', payload: { messageId: 'm-1' } }); });
    expectStopped('message_gone');
  });

  it('a block with the sender, as the block lists know it', async () => {
    const view = await docked();
    mockBlocked = new Set(['u-2']);
    await act(async () => { await view.rerender(<App />); });
    expectStopped('blocked');
  });

  it('being blocked by the sender, as the block lists know it', async () => {
    const view = await docked();
    mockBlocker = new Set(['u-2']);
    await act(async () => { await view.rerender(<App />); });
    expectStopped('blocked');
  });

  it('a block made on this account (realtime user.blocked)', async () => {
    await docked();
    await act(async () => { emit({ type: 'user.blocked', payload: { blockedId: 'u-2' } }); });
    expectStopped('blocked');
  });

  it('the stream revoked (e.g. this viewer was blocked)', async () => {
    await docked();
    await act(async () => { emit({ type: 'access.revoked' }); });
    expectStopped('access_revoked');
  });

  it('leaving: the thread loses access', async () => {
    const view = await docked();
    await act(async () => { await view.rerender(<App live={false} />); });
    expectStopped('source_closed');
  });

  it('leaving: this viewer\'s own member.left; another member leaving does not stop it', async () => {
    await docked();
    await act(async () => { emit({ type: 'member.left', threadId: 't-1', payload: { userId: 'u-3' } }); });
    expect(screen.getByTestId('compact-playback-docked')).toBeTruthy();
    await act(async () => { emit({ type: 'member.left', threadId: 't-1', payload: { userId: 'me-1' } }); });
    expectStopped('left');
  });

  it('the conversation screen unmounting', async () => {
    const view = await docked();
    await act(async () => { await view.rerender(<App thread={false} />); });
    expectStopped('source_closed');
  });

  it('signing out', async () => {
    const view = await docked();
    mockUserId = null;
    await act(async () => { await view.rerender(<App />); });
    expectStopped('signed_out');
  });

  it('the media no longer signing for this viewer', async () => {
    const view = await docked();
    mockRefused.add(REF);
    await act(async () => { await view.rerender(<App />); });
    expectStopped('media_error');
  });

  it('playback ending', async () => {
    await docked();
    await act(async () => { mockVideo.lastProps.onPlaybackStatusUpdate({ isLoaded: true, isPlaying: false, didJustFinish: true }); });
    expectStopped('ended');
  });

  it('Stop, docked', async () => {
    await docked();
    await fireEvent.press(screen.getByLabelText('Stop video'));
    expectStopped('user');
  });

  it('Stop, full screen', async () => {
    await openVideo();
    await fireEvent.press(screen.getByLabelText('Stop video'));
    expectStopped('user');
  });

  it('Android back while full screen', async () => {
    const handlers: Array<() => boolean> = [];
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation(((_e: string, h: () => boolean) => {
      handlers.push(h);
      return { remove: () => { const i = handlers.indexOf(h); if (i >= 0) handlers.splice(i, 1); } };
    }) as never);
    await openVideo();
    expect(handlers).toHaveLength(1);
    let consumed = false;
    await act(async () => { consumed = handlers[0]!(); });
    expect(consumed).toBe(true);
    expect(lastPlaybackStopReason()).toBe('user');
    expect(screen.queryByTestId('compact-playback-host') === null).toBe(true);
  });
});
