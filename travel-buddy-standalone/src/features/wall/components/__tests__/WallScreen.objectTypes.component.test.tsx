/**
 * Component test: the feed renders each object type with its DISTINCT renderer
 * (Wall spec §6/§7/§40 #4) — a Postcard is not a Post with a badge.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design mock — the real wallApi loads the supabase /
// apiToken chain at import, which would crash the jest suite.
jest.mock('../../services/wallApi.ts', () => ({
  fetchWall: jest.fn(),
  fetchLiveForYou: jest.fn(),
  setSessionIntent: jest.fn(),
  clearSessionIntent: jest.fn(),
  sendImpression: jest.fn(),
  sendAction: jest.fn(),
}));

import * as wallApi from '../../services/wallApi.ts';
import { WallScreen } from '../WallScreen.tsx';
import type { WallProjection, WallResponse } from '../../types/wallProjection.ts';

const mockFetchWall = wallApi.fetchWall as unknown as jest.Mock;
const mockFetchLive = wallApi.fetchLiveForYou as unknown as jest.Mock;

const NOW = new Date().toISOString();
const base = (id: string) => ({
  projectionId: id,
  canonicalObjectId: `c-${id}`,
  publishedAt: NOW,
  visibility: 'public' as const,
  actions: [],
});

const items: WallProjection[] = [
  { ...base('p1'), objectType: 'social_post', text: 'A normal post' },
  { ...base('v1'), objectType: 'video', inlinePlayback: true, media: [{ mediaId: 'm1', kind: 'video' }] },
  { ...base('c1'), objectType: 'postcard', storyPresentation: true, place: { placeId: 'pl1', name: 'Da Nang' } },
  { ...base('sm1'), objectType: 'shared_moment', participants: [{ userId: 'u1', displayName: 'Maya' }] },
  { ...base('d1'), objectType: 'discovery', discoveryReason: 'Followed by people you know' },
];

function response(): WallResponse {
  return { mode: 'for_you', liveForYou: [], items, generatedAt: NOW };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchLive.mockResolvedValue({ ok: true, liveForYou: [], degraded: false });
  mockFetchWall.mockResolvedValue({ ok: true, degraded: false, data: response() });
});

describe('WallScreen distinct object types', () => {
  it('dispatches each object type to its own renderer', async () => {
    await render(<WallScreen />);

    await waitFor(() => expect(screen.getByTestId('wall-item-social_post')).toBeTruthy());
    expect(screen.getByTestId('wall-item-video')).toBeTruthy();
    expect(screen.getByTestId('wall-item-postcard')).toBeTruthy();
    expect(screen.getByTestId('wall-item-shared_moment')).toBeTruthy();
    expect(screen.getByTestId('wall-item-discovery')).toBeTruthy();
  });
});
