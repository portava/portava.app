/**
 * MediaContextSheet (§7), the viewer's ••• that opens it, the §14 Map opener,
 * and the Media Timeline screen — rendered (census-media §19: MD314 · MD92 ·
 * MD26).
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { MediaContextSheet } from '../components/MediaContextSheet.tsx';
import { MediaPerspectiveViewerScreen } from '../screens/MediaPerspectiveViewerScreen.tsx';
import { MediaTimelineScreen } from '../screens/MediaTimelineScreen.tsx';
import { openClusterPerspectives } from '../services/perspectiveOpeners.ts';
import { getPerspectiveViewerContext, clearPerspectiveViewerContext } from '../state/perspectiveViewerContext.ts';
import type { MediaProjection } from '../types/media.ts';

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const SafeArea = ({ children }: { children: React.ReactNode }) => (
  <SafeAreaProvider initialMetrics={METRICS}>{children}</SafeAreaProvider>
);

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: (href: unknown) => mockPush(href), back: () => {}, replace: () => {} },
}));

const mockContextRefs = jest.fn();
const mockPlaceView = jest.fn();
const mockTimeline = jest.fn();
jest.mock('../services/mediaProjection.ts', () => ({
  ...jest.requireActual('../services/mediaProjection.ts'),
  fetchMediaContextRefs: (...a: unknown[]) => mockContextRefs(...a),
  fetchPlaceView: (...a: unknown[]) => mockPlaceView(...a),
  fetchTimeline: (...a: unknown[]) => mockTimeline(...a),
}));
// NOTE: intentionally exhaustive — imagery is not under test.
jest.mock('../../../components/CachedImage.tsx', () => {
  const { View } = require('react-native');
  return { CachedImage: () => <View /> };
});
// NOTE: intentionally exhaustive — stamp controls are outside this suite.
jest.mock('../../../components/stamps/StampButton.tsx', () => ({ StampButton: () => null }));
// NOTE: intentionally exhaustive — the action rail makes its own network call and is not under test.
jest.mock('../components/MediaActionRail.tsx', () => ({ MediaActionRail: () => null }));

const PLACE = '11111111-1111-1111-1111-111111111111';

function media(over: Partial<MediaProjection> = {}): MediaProjection {
  return {
    id: 'm1',
    mediaType: 'image',
    thumbnailUrl: 'https://cdn.example.test/m1.jpg',
    observationClass: 'observed',
    freshness: 'fresh',
    capturedAt: '2026-09-03T21:40:00Z',
    contributor: { id: 'u1', displayName: 'Maya', username: 'maya', verified: true },
    place: { id: PLACE, name: 'An Thuong' },
    ...over,
  };
}

beforeEach(() => {
  mockPush.mockReset();
  mockContextRefs.mockReset();
  mockPlaceView.mockReset();
  mockTimeline.mockReset();
  clearPerspectiveViewerContext();
});

describe('MediaContextSheet (§7)', () => {
  it('shows the server-resolved graph — including the Shared Moment edge — and links each edge to its home', async () => {
    mockContextRefs.mockResolvedValue({
      ok: true,
      data: [
        { kind: 'place', id: PLACE, label: 'An Thuong' },
        { kind: 'trip', id: 't1', label: 'Vietnam' },
        { kind: 'shared_moment', id: 'sm1', label: 'Sunset crew' },
      ],
    });
    const onNavigate = jest.fn();
    const onClose = jest.fn();
    await render(
      <SafeArea>
        <MediaContextSheet visible media={media()} onClose={onClose} onNavigate={onNavigate} />
      </SafeArea>,
    );
    await waitFor(() => expect(screen.getByTestId('media-context-edge-shared_moment')).toBeTruthy());
    expect(mockContextRefs).toHaveBeenCalledWith('m1', expect.anything());
    for (const k of ['person', 'place', 'trip', 'shared_moment', 'time']) {
      expect(screen.getByTestId(`media-context-edge-${k}`)).toBeTruthy();
    }
    expect(screen.queryByTestId('media-context-edge-event')).toBeNull();
    await fireEvent.press(screen.getByTestId('media-context-edge-shared_moment'));
    expect(onNavigate).toHaveBeenCalledWith('/shared-moments/sm1');
    await fireEvent.press(screen.getByTestId('media-context-where-taken'));
    expect(onNavigate).toHaveBeenLastCalledWith('/media-search?mediaId=m1');
  });

  it('draws no edge the server did not send, and says so when the refs could not be read', async () => {
    mockContextRefs.mockResolvedValue({ ok: false, data: null, errorKind: 'server', message: 'HTTP 503' });
    await render(
      <SafeArea>
        <MediaContextSheet visible media={media()} onClose={() => {}} />
      </SafeArea>,
    );
    await waitFor(() => expect(screen.getByTestId('media-context-unreadable')).toBeTruthy());
    expect(screen.queryByTestId('media-context-edge-trip')).toBeNull();
    expect(screen.queryByTestId('media-context-edge-shared_moment')).toBeNull();
    expect(screen.getByTestId('media-context-edge-place')).toBeTruthy(); // the projection's own place
  });
});

describe('the contextual viewer\'s ••• opens the §7 sheet', () => {
  it('pressing ••• shows "What this is part of" for the media on screen', async () => {
    mockContextRefs.mockResolvedValue({ ok: true, data: [] });
    await render(
      <SafeArea>
        <MediaPerspectiveViewerScreen
          input={{ kind: 'place', entityId: PLACE, entityLabel: 'An Thuong', groups: [], media: [media()] }}
          initialMediaId="m1"
          onClose={() => {}}
          onNavigate={() => {}}
        />
      </SafeArea>,
    );
    expect(screen.queryByText('What this is part of')).toBeNull();
    await fireEvent.press(screen.getByTestId('perspective-viewer-context'));
    await waitFor(() => expect(screen.getByText('What this is part of')).toBeTruthy());
    expect(mockContextRefs).toHaveBeenCalledWith('m1', expect.anything());
  });
});

describe('§14 Map → current geographic cluster (openClusterPerspectives)', () => {
  it('reads the cluster\'s place through the gated place view and stages kind `map`', async () => {
    const { mapPlaceCurrentView } = jest.requireActual('../services/mediaProjection.ts');
    mockPlaceView.mockResolvedValue({
      ok: true,
      data: mapPlaceCurrentView({
        place: { id: PLACE, name: 'An Thuong' },
        perspectives: { totalPerspectives: 1, groups: [{ key: 'nightlife', label: 'Nightlife', perspectiveCount: 1, media: [{ id: 'c1', mediaType: 'image', observationClass: 'observed', placeId: PLACE }] }] },
      }),
    });
    const opened = await openClusterPerspectives({ placeId: PLACE, label: 'An Thuong', perspectiveCount: 1, freshness: 'fresh' });
    expect(mockPlaceView).toHaveBeenCalledWith(PLACE);
    expect(opened).toBe(true);
    const staged = getPerspectiveViewerContext();
    expect(staged?.input.kind).toBe('map');
    expect(staged?.input.entityId).toBe(PLACE);
    expect(mockPush).toHaveBeenCalledWith(`/media-perspective/${staged?.initialMediaId}`);
  });

  it('a cluster whose place view cannot be read opens NOTHING (no empty viewer)', async () => {
    mockPlaceView.mockResolvedValue({ ok: false, data: null, errorKind: 'server', message: 'x' });
    const opened = await openClusterPerspectives({ placeId: PLACE, label: 'An Thuong', perspectiveCount: 1, freshness: 'fresh' });
    expect(opened).toBe(false);
    expect(mockPush).not.toHaveBeenCalled();
    expect(getPerspectiveViewerContext()).toBeNull();
  });
});

describe('MediaTimelineScreen (§4 Media Timeline / Time Rail)', () => {
  it('asks for the PLACE-scoped timeline and shows the rail plus the observed Earlier perspectives', async () => {
    const { mapTimeline } = jest.requireActual('../services/mediaProjection.ts');
    mockTimeline.mockResolvedValue({
      ok: true,
      data: mapTimeline({
        bands: {
          earlier: {
            items: [{ renderClass: 'observed', itemKind: 'media', media: { id: 'e1', mediaType: 'image', thumbnailUrl: 't', observationClass: 'observed', capturedAt: '2026-09-25T10:00:00Z' } }],
          },
        },
      }),
    });
    const onOpenMedia = jest.fn();
    await render(<MediaTimelineScreen placeId={PLACE} label="An Thuong" onOpenMedia={onOpenMedia} />);
    await waitFor(() => expect(screen.getByTestId('media-timeline-screen')).toBeTruthy());
    expect(mockTimeline).toHaveBeenCalledWith(expect.objectContaining({ placeId: PLACE }));
    expect(screen.getByText('An Thuong · over time')).toBeTruthy();
    expect(screen.getByText('Earlier perspectives')).toBeTruthy();
    await fireEvent.press(screen.getAllByLabelText('Perspective')[0]!);
    expect(onOpenMedia).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }));
  });

  it('a label-only place (no canonical UUID) makes no request and renders the empty rail', async () => {
    await render(<MediaTimelineScreen placeId="not-a-uuid" />);
    await waitFor(() => expect(screen.getByTestId('media-timeline-screen')).toBeTruthy());
    expect(mockTimeline).not.toHaveBeenCalled();
  });
});
