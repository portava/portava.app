/**
 * useJourneys / useTravelIdentity — viewer-target plumbing (§2 viewer nav).
 *
 * The two data hooks now accept an optional target user id so a VIEWER can open
 * another traveler's standalone surface (the server does the per-viewer privacy
 * projection). These tests pin the one behaviour that matters here: WHOSE id is
 * requested — the explicit target when given, the session user otherwise, and a
 * blank/whitespace target falls back to the session user rather than fetching "".
 */
import { renderHook, waitFor } from '@testing-library/react-native';

const mockSessionUserId = { current: 'owner-1' as string | null };
jest.mock('../../../context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: mockSessionUserId.current }),
}));

const mockGetJourneys = jest.fn(async (userId: string) => ({
  ok: true as const,
  data: { journeys: { userId, totalJourneys: 0, years: [], featured: null }, restricted: false },
}));
const mockGetTravelIdentity = jest.fn(async (_userId: string) => ({
  ok: true as const,
  data: { dimensions: [], traits: [] },
}));
jest.mock('../../../services/passportProjection.ts', () => ({
  getPassportJourneys: (id: string) => mockGetJourneys(id),
  getTravelIdentity: (id: string) => mockGetTravelIdentity(id),
}));

import { useJourneys } from '../useJourneys.ts';
import { useTravelIdentity } from '../useTravelIdentity.ts';

beforeEach(() => {
  mockSessionUserId.current = 'owner-1';
  mockGetJourneys.mockClear();
  mockGetTravelIdentity.mockClear();
});

describe('useJourneys target plumbing', () => {
  it('requests the explicit target user when one is supplied (viewer nav)', async () => {
    await renderHook(() => useJourneys('them-42'));
    await waitFor(() => expect(mockGetJourneys).toHaveBeenCalled());
    expect(mockGetJourneys).toHaveBeenCalledWith('them-42');
  });

  it('falls back to the session user when the target is null (owner view)', async () => {
    await renderHook(() => useJourneys(null));
    await waitFor(() => expect(mockGetJourneys).toHaveBeenCalled());
    expect(mockGetJourneys).toHaveBeenCalledWith('owner-1');
  });

  it('treats a blank target as absent — never fetches an empty id', async () => {
    await renderHook(() => useJourneys('   '));
    await waitFor(() => expect(mockGetJourneys).toHaveBeenCalled());
    expect(mockGetJourneys).toHaveBeenCalledWith('owner-1');
  });
});

describe('useTravelIdentity target plumbing', () => {
  it('requests the explicit target user when one is supplied (viewer nav)', async () => {
    await renderHook(() => useTravelIdentity('them-42'));
    await waitFor(() => expect(mockGetTravelIdentity).toHaveBeenCalled());
    expect(mockGetTravelIdentity).toHaveBeenCalledWith('them-42');
  });

  it('falls back to the session user when the target is omitted (owner view)', async () => {
    await renderHook(() => useTravelIdentity());
    await waitFor(() => expect(mockGetTravelIdentity).toHaveBeenCalled());
    expect(mockGetTravelIdentity).toHaveBeenCalledWith('owner-1');
  });
});
