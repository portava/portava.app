/**
 * Component test: the Stories / Quick Media row renders REAL data from
 * GET /wall/quick-media (Wall spec §18/§24).
 *
 *   • items fold into one ring per PERSON, newest first;
 *   • an item whose 24-h window has passed is dropped (no stale rings);
 *   • opening a ring lands in the canonical media viewer for that person's
 *     newest post — the projection is never the object;
 *   • an empty / degraded / failed source renders no row and leaves the feed
 *     untouched (spec §40 #7).
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';

// NOTE: exhaustive-by-design mock — the real wallApi loads the supabase /
// apiToken chain at import, which would crash the jest suite.
jest.mock('../../services/wallApi.ts', () => ({
  fetchWall: jest.fn(),
  fetchLiveForYou: jest.fn(),
  fetchQuickMedia: jest.fn(),
  setSessionIntent: jest.fn(),
  clearSessionIntent: jest.fn(),
  sendImpression: jest.fn(),
  sendAction: jest.fn(),
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: (href: unknown) => mockPush(href), replace: jest.fn(), back: jest.fn() },
}));

import * as wallApi from '../../services/wallApi.ts';
import { WallScreen } from '../WallScreen.tsx';
import { foldQuickMedia } from '../../hooks/useQuickMedia.ts';
import type { QuickMediaItem, WallResponse } from '../../types/wallProjection.ts';

const mockFetchWall = wallApi.fetchWall as unknown as jest.Mock;
const mockFetchLive = wallApi.fetchLiveForYou as unknown as jest.Mock;
const mockFetchQuick = wallApi.fetchQuickMedia as unknown as jest.Mock;

const NOW = Date.now();
const iso = (deltaMs: number) => new Date(NOW + deltaMs).toISOString();
const H = 60 * 60 * 1000;

function item(over: Partial<QuickMediaItem> & { id: string; ownerUserId: string; postId: string }): QuickMediaItem {
  return {
    actor: { userId: over.ownerUserId, displayName: over.ownerUserId === 'aya' ? 'Aya' : 'Bo' },
    media: { mediaId: over.id, kind: 'image', url: `post-media/${over.ownerUserId}/${over.id}.jpg` },
    createdAt: iso(-2 * H),
    expiresAt: iso(22 * H),
    ...over,
  };
}

const items: QuickMediaItem[] = [
  item({ id: 'a-old', ownerUserId: 'aya', postId: 'post-aya-old', createdAt: iso(-5 * H), expiresAt: iso(19 * H) }),
  item({ id: 'a-new', ownerUserId: 'aya', postId: 'post-aya-new', createdAt: iso(-1 * H), expiresAt: iso(23 * H) }),
  item({ id: 'b-1', ownerUserId: 'bo', postId: 'post-bo', createdAt: iso(-3 * H), expiresAt: iso(21 * H) }),
  // Expired an hour ago — must not render, whatever the server sent.
  item({ id: 'b-expired', ownerUserId: 'cy', postId: 'post-cy', createdAt: iso(-25 * H), expiresAt: iso(-1 * H) }),
];

function feed(): WallResponse {
  return { mode: 'for_you', liveForYou: [], items: [], generatedAt: iso(0) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchLive.mockResolvedValue({ ok: true, liveForYou: [], degraded: false });
  mockFetchWall.mockResolvedValue({ ok: true, degraded: false, data: feed() });
});

describe('foldQuickMedia', () => {
  it('folds to one entry per person, newest first, counting items and dropping expired ones', () => {
    const folded = foldQuickMedia(items, NOW);
    expect(folded.entries.map((e) => e.id)).toEqual(['aya', 'bo']);
    expect(folded.entries[0]).toMatchObject({ label: 'Aya', postId: 'post-aya-new', mediaCount: 2 });
    expect(folded.entries[1]).toMatchObject({ label: 'Bo', postId: 'post-bo', mediaCount: 1 });
    expect(folded.items.map((i) => i.id)).toEqual(['a-new', 'b-1', 'a-old']);
  });
});

describe('WallScreen quick media row', () => {
  it('renders one ring per followed person from the real data source', async () => {
    mockFetchQuick.mockResolvedValue({ ok: true, degraded: false, items });
    await render(<WallScreen />);

    await waitFor(() => expect(screen.getByTestId('wall-quick-media')).toBeTruthy());
    expect(mockFetchQuick).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('wall-quick-media-aya')).toBeTruthy();
    expect(screen.getByTestId('wall-quick-media-bo')).toBeTruthy();
    expect(screen.queryByTestId('wall-quick-media-cy')).toBeNull();
    expect(screen.getByLabelText('Aya, 2 new')).toBeTruthy();
    expect(screen.getByLabelText('Bo')).toBeTruthy();
  });

  it("opens a ring into the canonical media viewer for that person's newest post", async () => {
    mockFetchQuick.mockResolvedValue({ ok: true, degraded: false, items });
    await render(<WallScreen />);
    await waitFor(() => expect(screen.getByTestId('wall-quick-media-aya')).toBeTruthy());

    fireEvent.press(screen.getByTestId('wall-quick-media-aya'));
    expect(mockPush).toHaveBeenCalledWith('/media-viewer/post-aya-new');
  });

  it.each([
    ['degraded (Wall disabled / signed out)', { ok: true, degraded: true, items: [] }],
    ['a transport failure', { ok: false, error: 'Network error' }],
    ['a missing result', undefined],
  ])('renders no row on %s — and the feed still renders', async (_label, result) => {
    mockFetchQuick.mockResolvedValue(result);
    await render(<WallScreen />);
    await waitFor(() => expect(mockFetchQuick).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('wall-feed')).toBeTruthy());
    expect(screen.queryByTestId('wall-quick-media')).toBeNull();
  });

  it('honours an explicit override without calling the source', async () => {
    mockFetchQuick.mockResolvedValue({ ok: true, degraded: false, items });
    await render(<WallScreen quickMedia={[{ id: 'me', label: 'You', isSelf: true }]} />);
    await waitFor(() => expect(screen.getByTestId('wall-quick-media-me')).toBeTruthy());
    expect(mockFetchQuick).not.toHaveBeenCalled();
  });
});
