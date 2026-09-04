/**
 * Component test: a Live For You failure degrades gracefully (Wall spec §40 #7,
 * TABLE 5).
 *
 * When GET /wall/live errors, the live strip simply does not render and the
 * social feed is entirely unaffected — a safe social feed always remains.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

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

import * as wallApi from '../../services/wallApi.ts';
import { WallScreen } from '../WallScreen.tsx';

const mockFetchWall = wallApi.fetchWall as unknown as jest.Mock;
const mockFetchLive = wallApi.fetchLiveForYou as unknown as jest.Mock;

const NOW = new Date().toISOString();

beforeEach(() => {
  jest.clearAllMocks();
  // The live strip endpoint is DOWN.
  mockFetchLive.mockResolvedValue({ ok: false, error: 'boom' });
  // The feed endpoint is healthy.
  mockFetchWall.mockResolvedValue({
    ok: true,
    degraded: false,
    data: {
      mode: 'for_you',
      liveForYou: [],
      items: [
        {
          projectionId: 'p1',
          objectType: 'social_post',
          canonicalObjectId: 'c-p1',
          publishedAt: NOW,
          visibility: 'public',
          text: 'SOCIAL_FEED_STILL_WORKS',
          actions: [],
        },
      ],
      generatedAt: NOW,
    },
  });
});

describe('WallScreen live degradation', () => {
  it('keeps a working social feed when the live strip fails', async () => {
    await render(<WallScreen />);

    await waitFor(() => expect(screen.getByText('SOCIAL_FEED_STILL_WORKS')).toBeTruthy());
    // The live strip renders nothing on failure — the feed is unaffected.
    expect(screen.queryByTestId('wall-live-strip')).toBeNull();
  });
});
