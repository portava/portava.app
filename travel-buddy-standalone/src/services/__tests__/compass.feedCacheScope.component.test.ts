/**
 * The Compass feed cache replays a feed only into the section:city it was read
 * for (census-discovery §101, lane W11-X2 round 5; DV-83; register D-W11X2-34).
 *
 * The AsyncStorage entry is one per viewer. Before §101 it carried no scope, so
 * `useCompassFeed` seeded the For You tab with whatever section or city the
 * viewer last read — another city's recommendations, painted as this city's
 * until (and, if the read failed, after) this city's read settled.
 *
 *   S1  written under a scope, read under the same scope: the feed
 *   S2  read under another city's scope: nothing
 *   S3  read under another section's scope: nothing
 *   S4  an entry written before §101 (no scope) is never replayed into a scope
 *   C1  CONTROL: a caller that asks with no scope reads the entry as before
 *
 * Run with: npx jest src/services/__tests__/compass.feedCacheScope.component.test.ts
 */

// NOTE: exhaustive-by-design mock — the same stand-in compass.memoryService's
// suite uses: keeps the real module's SecureStoreAdapter → react-native chain out.
jest.mock('../../lib/supabase.ts', () => ({
  isSupabaseConfigured: true,
  supabase: {},
  authedClient: () => ({}),
}));

// NOTE: exhaustive-by-design mock — services/compass.ts reads AsyncStorage as
// `require(…).default`; the repo's jest mapper module has no `default`, so the
// cache path would be unreachable. An in-memory store stands in, as `default`.
jest.mock('@react-native-async-storage/async-storage', () => {
  const mem = new Map<string, string>();
  const store = {
    setItem: async (k: string, v: string) => { mem.set(k, v); },
    getItem: async (k: string) => mem.get(k) ?? null,
    removeItem: async (k: string) => { mem.delete(k); },
    clear: async () => { mem.clear(); },
  };
  return { __esModule: true, default: store };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCachedFeed, setCachedFeed } from '../compass.ts';

const FEED = { sections: [{ name: 'for_you', items: [] }], nextCursor: null, fallback: false, compassEnabled: true };

beforeEach(async () => { await AsyncStorage.clear(); });

describe('Compass feed cache — scoped to section:city (DV-83, §101)', () => {
  it('S1 written under a scope, read under the same scope: the feed', async () => {
    await setCachedFeed('viewer-1', FEED, 'for_you:lisbon');
    expect(await getCachedFeed('viewer-1', 'for_you:lisbon')).toEqual(FEED);
  });

  it('S2 read under another city\'s scope: nothing', async () => {
    await setCachedFeed('viewer-1', FEED, 'for_you:lisbon');
    expect(await getCachedFeed('viewer-1', 'for_you:porto')).toBeNull();
  });

  it('S3 read under another section\'s scope: nothing', async () => {
    await setCachedFeed('viewer-1', FEED, 'picks:lisbon');
    expect(await getCachedFeed('viewer-1', 'for_you:lisbon')).toBeNull();
  });

  it('S4 an entry written before §101 (no scope) is never replayed into a scope', async () => {
    await setCachedFeed('viewer-1', FEED);
    expect(await getCachedFeed('viewer-1', 'for_you:lisbon')).toBeNull();
  });

  it('C1 CONTROL a caller that asks with no scope reads the entry as before', async () => {
    await setCachedFeed('viewer-1', FEED, 'for_you:lisbon');
    expect(await getCachedFeed('viewer-1')).toEqual(FEED);
  });
});
