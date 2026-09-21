/**
 * §37 — "Moderation takedowns propagate to cached Wall projections" — the CLIENT
 * half, and §31 "revalidate eligibility".
 *
 * The server has always dropped a taken-down object on every request. The cached
 * page did not: `wallPrefetch` persists whole projections for up to 24 h and the
 * feed re-displays them when a live fetch fails, so the offline page was the one
 * path on which a taken-down object could still paint.
 *
 * WHAT IS AND IS NOT CLAIMED. Nothing can propagate to a device with no network.
 * What `revalidateFirstPageCache` guarantees is that the cache is CORRECTED at
 * the first moment the device can reach the server, and that the correction is
 * PERSISTED — so a takedown that lands during an offline stretch is honoured
 * before the page is painted again. The three outcomes are kept strictly
 * distinct and each is asserted here:
 *
 *   server answered, some ids missing → those are dropped and the page rewritten
 *   server answered with nothing      → a real verdict; the page is EVICTED
 *   server not reached                → NOT a verdict; the page is untouched
 *
 * NO CLIENT-SIDE ELIGIBILITY. There is no moderation predicate on this side to
 * drift out of step with the server's — the client sends ids and keeps what
 * comes back (spec §37 "server-side eligibility is authoritative"; Sensing S6
 * "no client truth duplication"). The tests below never construct an "eligible"
 * projection; they only ever vary the SERVER's answer.
 *
 * MUTATION PROOF (each verified: revert → RED, restore → GREEN)
 *   • return the cached items unchanged when `result.ok` is true → the drop,
 *     evict and persistence tests RED.
 *   • treat `{ ok: false }` as an empty allowlist (fail closed on unreachable)
 *     → the offline-untouched test RED.
 *   • pass `now` instead of `cached.cachedAt` to the rewrite → the
 *     "revalidation is not a refresh" test RED.
 */

import {
  FIRST_PAGE_TTL_MS,
  readFirstPageCache,
  revalidateFirstPageCache,
  writeFirstPageCache,
  type StorageLike,
} from '../wallPrefetch.ts';
import type { WallProjection } from '../../types/wallProjection.ts';

function memStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
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

function proj(id: string): WallProjection {
  return {
    projectionId: `wall_social_post_${id}`,
    objectType: 'social_post',
    canonicalObjectId: id,
    publishedAt: '2026-09-04T00:00:00.000Z',
    visibility: 'public',
    actions: [],
  } as WallProjection;
}

/** A server that answers with exactly this allowlist. */
const answers = (ids: string[]) => async () => ({ ok: true as const, eligibleObjectIds: ids });
/** A server that could not be reached at all. */
const unreachable = async () => ({ ok: false as const, error: 'Network error' });

it('drops the ids the server no longer admits, and keeps the rest', async () => {
  const storage = memStorage();
  await writeFirstPageCache('for_you', [proj('a'), proj('b'), proj('c')], { storage });

  const survivors = await revalidateFirstPageCache('for_you', {
    storage,
    revalidate: answers(['a', 'c']) as never,
  });

  expect(survivors?.map((i) => i.canonicalObjectId)).toEqual(['a', 'c']);
});

it('PERSISTS the correction — the next offline paint never sees the taken-down object', async () => {
  const storage = memStorage();
  await writeFirstPageCache('for_you', [proj('a'), proj('taken-down')], { storage });

  await revalidateFirstPageCache('for_you', { storage, revalidate: answers(['a']) as never });

  const reread = await readFirstPageCache('for_you', { storage });
  expect(reread?.items.map((i) => i.canonicalObjectId)).toEqual(['a']);
});

it('a revalidation is NOT a refresh — the saved-at time survives, so the stale label survives', async () => {
  const storage = memStorage();
  const cachedAt = Date.now() - (FIRST_PAGE_TTL_MS + 60_000); // already past the fresh TTL
  await writeFirstPageCache('for_you', [proj('a'), proj('b')], { storage, now: cachedAt });

  await revalidateFirstPageCache('for_you', { storage, revalidate: answers(['a']) as never });

  const reread = await readFirstPageCache('for_you', { storage });
  expect(reread?.cachedAt).toBe(cachedAt);
  expect(reread?.stale).toBe(true);
});

it('an empty answer from a REACHED server is a real verdict — the page is evicted', async () => {
  const storage = memStorage();
  await writeFirstPageCache('for_you', [proj('a')], { storage });

  const survivors = await revalidateFirstPageCache('for_you', {
    storage,
    revalidate: answers([]) as never,
  });

  expect(survivors).toEqual([]);
  expect(await readFirstPageCache('for_you', { storage })).toBeNull();
});

it('an UNREACHABLE server is not a verdict — the cached page is left exactly as it was', async () => {
  const storage = memStorage();
  await writeFirstPageCache('for_you', [proj('a'), proj('b')], { storage });

  const survivors = await revalidateFirstPageCache('for_you', {
    storage,
    revalidate: unreachable as never,
  });

  expect(survivors).toBeNull();
  const reread = await readFirstPageCache('for_you', { storage });
  expect(reread?.items.map((i) => i.canonicalObjectId)).toEqual(['a', 'b']);
});

it('an unchanged page is left alone (no needless rewrite)', async () => {
  const storage = memStorage();
  await writeFirstPageCache('for_you', [proj('a'), proj('b')], { storage });
  const before = storage.map.get([...storage.map.keys()][0]);

  const survivors = await revalidateFirstPageCache('for_you', {
    storage,
    revalidate: answers(['a', 'b']) as never,
  });

  expect(survivors?.map((i) => i.canonicalObjectId)).toEqual(['a', 'b']);
  expect(storage.map.get([...storage.map.keys()][0])).toBe(before);
});

it('no cache means nothing to revalidate, and no request is made', async () => {
  const storage = memStorage();
  let called = 0;
  const spy = async () => {
    called += 1;
    return { ok: true as const, eligibleObjectIds: [] };
  };
  expect(await revalidateFirstPageCache('for_you', { storage, revalidate: spy as never })).toBeNull();
  expect(called).toBe(0);
});

it('sends the CANONICAL object ids — the id the server gates on, not the projection id', async () => {
  const storage = memStorage();
  await writeFirstPageCache('for_you', [proj('a')], { storage });
  let sent: string[] = [];
  const capture = async (ids: string[]) => {
    sent = ids;
    return { ok: true as const, eligibleObjectIds: ids };
  };
  await revalidateFirstPageCache('for_you', { storage, revalidate: capture as never });
  expect(sent).toEqual(['a']);
  expect(sent).not.toContain('wall_social_post_a');
});

it('is keyed per mode — revalidating For You never touches the Following page', async () => {
  const storage = memStorage();
  await writeFirstPageCache('for_you', [proj('a')], { storage });
  await writeFirstPageCache('following', [proj('b')], { storage });

  await revalidateFirstPageCache('for_you', { storage, revalidate: answers([]) as never });

  expect(await readFirstPageCache('for_you', { storage })).toBeNull();
  const following = await readFirstPageCache('following', { storage });
  expect(following?.items.map((i) => i.canonicalObjectId)).toEqual(['b']);
});
