/**
 * Component test: the persistent For You / Following switch (Wall spec §5/§40 #3).
 *
 * Switching to Following starts a NEW feed session that fetches mode=following,
 * and the For You content is replaced — the user can always choose strict
 * chronology.
 */

import React from 'react';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design mock — the real wallApi loads the supabase /
// apiToken chain at import, which would crash the jest suite. Only the exports
// the shell actually uses are stubbed here.
jest.mock('../../services/wallApi.ts', () => ({
  fetchWall: jest.fn(),
  fetchLiveForYou: jest.fn(),
  fetchQuickMedia: jest.fn(),
  setSessionIntent: jest.fn(),
  clearSessionIntent: jest.fn(),
  sendImpression: jest.fn(),
  sendAction: jest.fn(),
}));

import * as wallApi from '../../services/wallApi.ts';
import { WallScreen } from '../WallScreen.tsx';
import type { WallMode, WallResponse } from '../../types/wallProjection.ts';

const mockFetchWall = wallApi.fetchWall as unknown as jest.Mock;
const mockFetchLive = wallApi.fetchLiveForYou as unknown as jest.Mock;

function post(id: string, text: string) {
  return {
    projectionId: id,
    objectType: 'social_post' as const,
    canonicalObjectId: `c-${id}`,
    publishedAt: new Date().toISOString(),
    visibility: 'public' as const,
    text,
    actions: [],
  };
}

function response(mode: WallMode): WallResponse {
  return {
    mode,
    liveForYou: [],
    items: [post(`${mode}-1`, mode === 'for_you' ? 'FORYOU_POST' : 'FOLLOWING_POST')],
    generatedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchLive.mockResolvedValue({ ok: true, liveForYou: [], degraded: false });
  mockFetchWall.mockImplementation(async ({ mode }: { mode: WallMode }) => ({
    ok: true,
    degraded: false,
    data: response(mode),
  }));
});

describe('WallScreen mode switch', () => {
  it('renders For You by default and switches to Following on tap', async () => {
    await render(<WallScreen />);

    await waitFor(() => expect(screen.getByText('FORYOU_POST')).toBeTruthy());
    expect(mockFetchWall).toHaveBeenCalledWith(expect.objectContaining({ mode: 'for_you' }));

    await act(async () => {
      fireEvent.press(screen.getByTestId('wall-mode-following'));
    });

    await waitFor(() => expect(screen.getByText('FOLLOWING_POST')).toBeTruthy());
    expect(screen.queryByText('FORYOU_POST')).toBeNull();
    expect(mockFetchWall).toHaveBeenCalledWith(expect.objectContaining({ mode: 'following' }));
  });
});
