/**
 * census-discovery §122 (DV-83 round 23, lane W11-X2; sweep SW31, the class of §119.16 B39): the home tab's For You
 * feed never draws the previous city's posts over a failed read for the city now on screen.
 *
 * usePulseFeed kept `items` on a failed reload, whatever city they were read for, and the home tab draws `items` above
 * its error footer: after a move to city B whose read failed, city A's posts stood under B's heading with "couldn't
 * load" below them. The hook now clears its items, place cards and session when a reload for a NEW city or position
 * fails; a failed refresh of the same one keeps them (the footer says it failed), and a new read that answers replaces
 * them as before.
 *
 *   PF0 CONTROL: Lisbon answers, then Porto answers → Porto's posts
 *   PF1 Lisbon answers, then Porto's read FAILS → no Lisbon post, the error set
 *   PF2 CONTROL: Lisbon answers, then a refresh of Lisbon FAILS → Lisbon's posts stay, the error set
 *   PF3 Lisbon answers, then Porto's read REJECTS (the token refresh throws) → no Lisbon post, the error set
 */
import { renderHook, act, waitFor } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — the block list is not under test; nobody is blocked. One stable value, as the
// provider gives, so the hook's callbacks keep their identity between renders.
const mockBlocked = { blockedIds: new Set<string>(), blockerIds: new Set<string>(), isLoading: false };
jest.mock('../../context/BlockedIdsContext.tsx', () => ({ useBlockedIds: () => mockBlocked }));
jest.mock('../../services/pulse.ts', () => ({ ...jest.requireActual('../../services/pulse.ts'), getPulseData: jest.fn() }));

import { usePulseFeed } from '../usePulseFeed.ts';
import { getPulseData } from '../../services/pulse.ts';

const post = (id: string, city: string) => ({ id, authorId: 'u2', content: `${city} sunset`, createdAt: '2026-09-30T18:00:00.000Z', mediaUrls: [], spanTags: [], spanHashtags: [], locationCity: city, savedByMe: false });
const ok = (city: string) => Promise.resolve({ ok: true, data: { posts: [post(`p-${city}`, city)], total: 1, tab: 'all', prompts: [], placeCards: [], sessionId: `s-${city}` } });
const FAIL = () => Promise.resolve({ ok: false, error: "Couldn't load the feed", errorKind: 'http' });
const settle = async () => { await act(async () => {}); await act(async () => {}); };

async function run(second: () => Promise<unknown>, sameCity: boolean) {
  let n = 0;
  (getPulseData as jest.Mock).mockImplementation(() => (++n === 1 ? ok('Lisbon') : second()));
  const { result, rerender } = await renderHook((p: { city: string }) => usePulseFeed({ city: p.city }), { initialProps: { city: 'Lisbon' } });
  await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['p-Lisbon']));
  if (sameCity) { await act(async () => { result.current.reload(); }); } else { await act(async () => { rerender({ city: 'Porto' }); }); }
  await settle();
  return result;
}

describe('census-discovery §122 (SW31): the For You feed over a failed read for a new city', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  it("PF0 CONTROL: Porto answers → Porto's posts", async () => {
    const r = await run(() => ok('Porto'), false);
    expect(r.current.items.map((i) => i.id)).toEqual(['p-Porto']);
    expect(r.current.error).toBeNull();
  });
  it('PF1 Porto FAILS → no Lisbon post, the error set', async () => {
    const r = await run(FAIL, false);
    expect(r.current.items).toEqual([]);
    expect(r.current.sessionId).toBeNull();
    expect(r.current.error).not.toBeNull();
  });
  it("PF2 CONTROL: a refresh of Lisbon FAILS → Lisbon's posts stay, the error set", async () => {
    const r = await run(FAIL, true);
    expect(r.current.items.map((i) => i.id)).toEqual(['p-Lisbon']);
    expect(r.current.error).not.toBeNull();
  });
  it('PF3 Porto REJECTS → no Lisbon post, the error set', async () => {
    const r = await run(() => Promise.reject(new Error('token refresh failed')), false);
    expect(r.current.items).toEqual([]);
    expect(r.current.error).not.toBeNull();
  });
});
