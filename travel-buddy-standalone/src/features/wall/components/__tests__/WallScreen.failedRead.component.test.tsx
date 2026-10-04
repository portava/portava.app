/**
 * census-wall §19 — a Wall that could not be read does not say "Nothing here
 * yet".
 *
 * Two routes led to the same lie:
 *   1. GET /wall failed outright (offline, 5xx) on first open with no saved
 *      page: the hook kept `error`, nothing rendered it, and the empty list
 *      showed the calm "Nothing here yet — when there is something to see, it
 *      will show up here" with a success tick.
 *   2. GET /wall answered 200 with `degraded: [...]` (§34: a lane's read
 *      FAILED): the client dropped `degraded`, so an outage of the post spine
 *      rendered exactly like a quiet feed, and a page missing whole lanes was
 *      presented as complete.
 *
 * Both now say what happened. The live strip's lane is not the feed's: an
 * empty feed whose only failure was the strip is still honestly empty.
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
  revalidateCachedObjects: jest.fn(async () => ({ ok: false, error: 'Network error' })),
}));

import * as wallApi from '../../services/wallApi.ts';
import { clearFirstPageCache } from '../../services/wallPrefetch.ts';
import { WallScreen } from '../WallScreen.tsx';

const mockFetchWall = wallApi.fetchWall as unknown as jest.Mock;
const mockFetchLive = wallApi.fetchLiveForYou as unknown as jest.Mock;
const mockFetchQuick = wallApi.fetchQuickMedia as unknown as jest.Mock;

const NOW = new Date().toISOString();

const ONE_POST = {
  projectionId: 'p1',
  objectType: 'social_post',
  canonicalObjectId: 'c-p1',
  publishedAt: NOW,
  visibility: 'public',
  text: 'A_POST_THAT_DID_LOAD',
  actions: [],
};

function page(items: unknown[], degraded?: string[]) {
  return {
    ok: true,
    degraded: false,
    data: { mode: 'for_you', liveForYou: [], items, generatedAt: NOW, ...(degraded ? { degraded } : {}) },
  };
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockFetchLive.mockResolvedValue({ ok: true, liveForYou: [], degraded: false });
  mockFetchQuick.mockResolvedValue({ ok: true, items: [], degraded: false });
  await clearFirstPageCache('for_you');
});

describe('WallScreen — a failed read is not an empty Wall', () => {
  it('CONTROL: an honestly empty answer shows the calm empty state', async () => {
    mockFetchWall.mockResolvedValue(page([]));
    await render(<WallScreen />);
    await waitFor(() => expect(screen.getByTestId('wall-caught-up-empty')).toBeTruthy());
    expect(screen.queryByTestId('wall-caught-up-unavailable')).toBeNull();
  });

  it('a request that FAILED, with no saved page, says it could not load — not "Nothing here yet"', async () => {
    mockFetchWall.mockResolvedValue({ ok: false, error: 'Network error' });
    await render(<WallScreen />);
    await waitFor(() => expect(screen.getByTestId('wall-caught-up-unavailable')).toBeTruthy());
    expect(screen.queryByTestId('wall-caught-up-empty')).toBeNull();
    expect(screen.queryByText('Nothing here yet')).toBeNull();
  });

  it('a 200 whose post spine FAILED (degraded) says it could not load', async () => {
    mockFetchWall.mockResolvedValue(page([], ['spine']));
    await render(<WallScreen />);
    await waitFor(() => expect(screen.getByTestId('wall-caught-up-unavailable')).toBeTruthy());
    expect(screen.queryByTestId('wall-caught-up-empty')).toBeNull();
  });

  it('a page that loaded but is MISSING a lane says so above the posts it has', async () => {
    mockFetchWall.mockResolvedValue(page([ONE_POST], ['postcards']));
    await render(<WallScreen />);
    await waitFor(() => expect(screen.getByText('A_POST_THAT_DID_LOAD')).toBeTruthy());
    expect(screen.getByTestId('wall-partial-banner')).toBeTruthy();
  });

  it('CONTROL: a complete page carries no partial notice', async () => {
    mockFetchWall.mockResolvedValue(page([ONE_POST]));
    await render(<WallScreen />);
    await waitFor(() => expect(screen.getByText('A_POST_THAT_DID_LOAD')).toBeTruthy());
    expect(screen.queryByTestId('wall-partial-banner')).toBeNull();
  });

  it("only the live strip's lane failed: the feed itself is complete and honestly empty", async () => {
    mockFetchWall.mockResolvedValue(page([], ['live']));
    await render(<WallScreen />);
    await waitFor(() => expect(screen.getByTestId('wall-caught-up-empty')).toBeTruthy());
    expect(screen.queryByTestId('wall-caught-up-unavailable')).toBeNull();
  });
});
