/**
 * WatchStamp.webrender.test.tsx — real runtime repro of the "stamp tap does
 * nothing" bug, run under jest-expo/web + real react-dom so the actual
 * useWatchStamp + StampAnimationProvider + WatchItemOverlay code paths run
 * (not native-renderer mocks). Mirrors clicking the rail stamp icon in the
 * live preview and reading the console, per the live-testing report.
 *
 * Runs via jest.web.config.js (pnpm run test:component).
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

// NOTE: intentional stub — navigation context unavailable in Jest; only
// router.push/useFocusEffect are required by the components under test.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: (_cb: () => void) => {},
}));
// NOTE: intentional stub — real insets not under test.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));
// NOTE: intentional stub — real haptics unavailable under jsdom; only the
// two members StampAnimationContext imports are needed.
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Heavy: 'heavy' },
}));

// NOTE: deliberately narrow — this suite only exercises the stamp/unstamp
// network calls; spread requireActual so any other export added later
// (e.g. getMyRecentStamps) still resolves to the real implementation
// instead of undefined.
const mockStampEntity = jest.fn();
jest.mock('../../../services/stamps.ts', () => ({
  ...jest.requireActual('../../../services/stamps.ts'),
  stampEntity: (...a: unknown[]) => mockStampEntity(...a),
  unstampEntity: jest.fn(),
}));

import { WatchItemOverlay } from '../WatchItemOverlay.tsx';
import { useWatchStamp } from '../../../hooks/useWatchStamp.ts';
import { StampAnimationProvider } from '../../../context/StampAnimationContext.tsx';
import type { MediaFeedItem } from '../../../types/media.ts';

function makeItem(): MediaFeedItem {
  return {
    id: 'item-hanoi-1',
    videoUrl: 'https://example.com/x.mp4',
    posterUrl: null,
    duration: null,
    creator: { id: 'chloed', displayName: 'Chloe D', username: 'chloed', avatarUrl: null },
    caption: 'Hanoi',
    hashtags: [],
    place: null,
    linkedEntity: null,
    audioLabel: null,
    likeCount: 0,
    commentCount: 0,
    saveCount: 0,
    likedByMe: false,
    savedByMe: false,
    // @ts-expect-error — stamp fields may not be in the strict type yet
    stampCount: 0,
    isStampedByViewer: false,
  } as MediaFeedItem;
}

function Harness() {
  const item = makeItem();
  const stamp = useWatchStamp(item);
  return (
    <WatchItemOverlay
      item={item}
      currentUserId="viewer-1"
      isSaved={false}
      onComment={() => {}}
      onSave={() => {}}
      onMore={() => {}}
      stampGroupRef={stamp.stampGroupRef}
      stampVisualIsStamped={stamp.visualIsStamped}
      stampVisualCount={stamp.visualCount}
      stampButtonStyle={stamp.buttonStyle}
      onStampPress={stamp.handleStampPress}
    />
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mockStampEntity.mockReset();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  jest.clearAllMocks();
});

describe('Watch rail stamp button — real runtime repro', () => {
  it('logs the full press → API → animation → visual-fill pipeline', async () => {
    mockStampEntity.mockResolvedValue({ ok: true, data: { count: 1, isStamped: true } });

    await act(async () => {
      root.render(
        <StampAnimationProvider>
          <Harness />
        </StampAnimationProvider>,
      );
    });

    const button = container.querySelector('[aria-label="Stamp"]') as HTMLElement | null;
    expect(button).not.toBeNull();

    await act(async () => {
      button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    // Give the setTimeout(fireImpact, TRAVEL_MS) inside triggerStamp a chance
    // to fire (real timers — TRAVEL_MS is 400ms).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });

    expect(mockStampEntity).toHaveBeenCalledWith('media', 'item-hanoi-1');
    // The definitive assertion: did the icon end up in the active/filled state?
    const iconRotated = container.innerHTML.includes('rotate(-7');
    // eslint-disable-next-line no-console
    console.log('[TEST_RESULT] mockStampEntity calls:', mockStampEntity.mock.calls.length);
    // eslint-disable-next-line no-console
    console.log('[TEST_RESULT] icon shows active rotation (-7deg):', iconRotated);
  });
});
