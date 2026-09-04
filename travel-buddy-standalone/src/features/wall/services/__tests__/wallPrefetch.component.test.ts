/**
 * wallPrefetch — the Wall's cache / prefetch contract (Wall spec §31/§37/§40).
 *
 * Proves:
 *   • the first-page cache round-trips, is capped, and is keyed per mode;
 *   • the TWO horizons: within TTL → fresh (stale=false); past TTL but within
 *     the max age → served with stale=true; past the max age → dropped AND
 *     evicted so an old page can never masquerade as the feed;
 *   • a malformed / wrong-version / wrong-mode blob is discarded, not half-read;
 *   • media prefetch warms only the next N objects, signs private-bucket refs
 *     through the injected hydrate seam, warms a video's poster not its payload,
 *     skips still-processing media, de-dups, and is fail-soft.
 */

import {
  FIRST_PAGE_MAX_AGE_MS,
  FIRST_PAGE_MAX_ITEMS,
  FIRST_PAGE_TTL_MS,
  WALL_PREFETCH_VERSION,
  formatCacheAge,
  prefetchWallMedia,
  readFirstPageCache,
  writeFirstPageCache,
  type StorageLike,
} from '../wallPrefetch.ts';
import type { WallProjection } from '../../types/wallProjection.ts';

function memStorage(seed: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    async getItem(k) {
      return map.has(k) ? (map.get(k) as string) : null;
    },
    async setItem(k, v) {
      map.set(k, v);
    },
    async removeItem(k) {
      map.delete(k);
    },
  };
}

function proj(id: string, over: Partial<WallProjection> = {}): WallProjection {
  return {
    projectionId: id,
    objectType: 'social_post',
    canonicalObjectId: `post-${id}`,
    publishedAt: '2026-09-04T00:00:00.000Z',
    visibility: 'public',
    actions: [],
    ...over,
  } as WallProjection;
}

const KEY = `wall:firstpage:v${WALL_PREFETCH_VERSION}:for_you`;

describe('first-page cache round-trip', () => {
  it('writes and reads back the page, fresh within the TTL', async () => {
    const storage = memStorage();
    const now = 1_000_000;
    await writeFirstPageCache('for_you', [proj('a'), proj('b')], { storage, now });

    const read = await readFirstPageCache('for_you', { storage, now: now + 1000 });
    expect(read).not.toBeNull();
    expect(read!.items.map((i) => i.projectionId)).toEqual(['a', 'b']);
    expect(read!.cachedAt).toBe(now);
    expect(read!.stale).toBe(false);
  });

  it('caps the persisted page at FIRST_PAGE_MAX_ITEMS', async () => {
    const storage = memStorage();
    const many = Array.from({ length: FIRST_PAGE_MAX_ITEMS + 5 }, (_, i) => proj(`p${i}`));
    await writeFirstPageCache('for_you', many, { storage, now: 1 });
    const read = await readFirstPageCache('for_you', { storage, now: 2 });
    expect(read!.items.length).toBe(FIRST_PAGE_MAX_ITEMS);
  });

  it('is keyed per mode — following does not read for_you', async () => {
    const storage = memStorage();
    await writeFirstPageCache('for_you', [proj('a')], { storage, now: 1 });
    expect(await readFirstPageCache('following', { storage, now: 2 })).toBeNull();
  });

  it('never persists an empty page', async () => {
    const storage = memStorage();
    await writeFirstPageCache('for_you', [], { storage, now: 1 });
    expect(storage.map.has(KEY)).toBe(false);
  });
});

describe('cache TTL horizons', () => {
  it('marks a page past the fresh TTL as stale but still serves it', async () => {
    const storage = memStorage();
    const now = 10_000_000;
    await writeFirstPageCache('for_you', [proj('a')], { storage, now });
    const read = await readFirstPageCache('for_you', {
      storage,
      now: now + FIRST_PAGE_TTL_MS + 1,
    });
    expect(read).not.toBeNull();
    expect(read!.stale).toBe(true);
    expect(read!.items.map((i) => i.projectionId)).toEqual(['a']);
  });

  it('drops AND evicts a page past the max age', async () => {
    const storage = memStorage();
    const now = 10_000_000;
    await writeFirstPageCache('for_you', [proj('a')], { storage, now });
    expect(storage.map.has(KEY)).toBe(true);
    const read = await readFirstPageCache('for_you', {
      storage,
      now: now + FIRST_PAGE_MAX_AGE_MS + 1,
    });
    expect(read).toBeNull();
    expect(storage.map.has(KEY)).toBe(false);
  });
});

describe('cache integrity', () => {
  it('discards a malformed blob and evicts it', async () => {
    const storage = memStorage({ [KEY]: 'not json{' });
    expect(await readFirstPageCache('for_you', { storage, now: 1 })).toBeNull();
    expect(storage.map.has(KEY)).toBe(false);
  });

  it('discards a wrong-version blob', async () => {
    const storage = memStorage({
      [KEY]: JSON.stringify({ v: WALL_PREFETCH_VERSION + 1, mode: 'for_you', items: [proj('a')], cachedAt: 1 }),
    });
    expect(await readFirstPageCache('for_you', { storage, now: 2 })).toBeNull();
    expect(storage.map.has(KEY)).toBe(false);
  });

  it('discards a blob whose stored mode disagrees with the key', async () => {
    const storage = memStorage({
      [KEY]: JSON.stringify({ v: WALL_PREFETCH_VERSION, mode: 'following', items: [proj('a')], cachedAt: 1 }),
    });
    expect(await readFirstPageCache('for_you', { storage, now: 2 })).toBeNull();
  });
});

describe('prefetchWallMedia', () => {
  const hydrate = jest.fn();
  const prefetch = jest.fn();

  beforeEach(() => {
    hydrate.mockReset();
    prefetch.mockReset();
    prefetch.mockResolvedValue(true);
  });

  it('signs the next N images through hydrate and warms only the signed URLs', async () => {
    const items = [
      proj('a', { media: [{ mediaId: 'm1', kind: 'image', url: 'post-media/a/1.jpg' }] }),
      proj('b', { media: [{ mediaId: 'm2', kind: 'image', url: 'post-media/b/2.jpg' }] }),
      proj('c', { media: [{ mediaId: 'm3', kind: 'image', url: 'post-media/c/3.jpg' }] }),
    ];
    hydrate.mockResolvedValue({
      'post-media/a/1.jpg': 'https://signed/a',
      'post-media/b/2.jpg': 'https://signed/b',
    });

    const warmed = await prefetchWallMedia(items, { count: 2, hydrate, prefetch });

    // Only the first 2 objects' refs are hydrated (§31 "next small number").
    expect(hydrate).toHaveBeenCalledWith(['post-media/a/1.jpg', 'post-media/b/2.jpg']);
    expect(prefetch).toHaveBeenCalledWith(['https://signed/a', 'https://signed/b']);
    expect(warmed).toEqual(['https://signed/a', 'https://signed/b']);
  });

  it('warms a video poster, not its payload, and skips processing media', async () => {
    const items = [
      proj('v', {
        media: [{ mediaId: 'mv', kind: 'video', url: 'post-media/v/clip.mp4', thumbnailUrl: 'post-media/v/poster.jpg' }],
      }),
      proj('p', { media: [{ mediaId: 'mp', kind: 'image', url: 'post-media/p/pending.jpg', processing: true }] }),
    ];
    hydrate.mockResolvedValue({ 'post-media/v/poster.jpg': 'https://signed/poster' });

    await prefetchWallMedia(items, { count: 4, hydrate, prefetch });

    expect(hydrate).toHaveBeenCalledWith(['post-media/v/poster.jpg']);
    expect(prefetch).toHaveBeenCalledWith(['https://signed/poster']);
  });

  it('de-dups a ref shared across objects', async () => {
    const shared = 'post-media/shared.jpg';
    const items = [
      proj('a', { media: [{ mediaId: 'm1', kind: 'image', url: shared }] }),
      proj('b', { media: [{ mediaId: 'm2', kind: 'image', url: shared }] }),
    ];
    hydrate.mockResolvedValue({ [shared]: 'https://signed/shared' });
    await prefetchWallMedia(items, { count: 4, hydrate, prefetch });
    expect(hydrate).toHaveBeenCalledWith([shared]);
  });

  it('does nothing when there is no media and never calls prefetch', async () => {
    await prefetchWallMedia([proj('a')], { count: 4, hydrate, prefetch });
    expect(hydrate).not.toHaveBeenCalled();
    expect(prefetch).not.toHaveBeenCalled();
  });

  it('is fail-soft: a hydrate rejection resolves to [] without throwing', async () => {
    const items = [proj('a', { media: [{ mediaId: 'm1', kind: 'image', url: 'post-media/a/1.jpg' }] })];
    hydrate.mockRejectedValue(new Error('offline'));
    await expect(prefetchWallMedia(items, { count: 4, hydrate, prefetch })).resolves.toEqual([]);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it('drops refs the signer could not sign (null) and warms the rest', async () => {
    const items = [
      proj('a', { media: [{ mediaId: 'm1', kind: 'image', url: 'post-media/a/1.jpg' }] }),
      proj('b', { media: [{ mediaId: 'm2', kind: 'image', url: 'post-media/b/2.jpg' }] }),
    ];
    hydrate.mockResolvedValue({ 'post-media/a/1.jpg': null, 'post-media/b/2.jpg': 'https://signed/b' });
    const warmed = await prefetchWallMedia(items, { count: 4, hydrate, prefetch });
    expect(warmed).toEqual(['https://signed/b']);
    expect(prefetch).toHaveBeenCalledWith(['https://signed/b']);
  });
});

describe('formatCacheAge', () => {
  it('renders coarse relative ages', () => {
    expect(formatCacheAge(5_000)).toBe('just now');
    expect(formatCacheAge(90_000)).toBe('1m ago');
    expect(formatCacheAge(2 * 60 * 60 * 1000)).toBe('2h ago');
    expect(formatCacheAge(3 * 24 * 60 * 60 * 1000)).toBe('3d ago');
  });
});
