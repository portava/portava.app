/**
 * census-layover L150 — "persist latest certified value + snapshot timestamp".
 *
 * The server closed its half: every bundle has carried `certifiedAt` and
 * `staleAfter` since the degraded-mode pass. The CLIENT half was never built —
 * there was no AsyncStorage write anywhere in the layover client, so a
 * traveller who lost signal lost the one number §16 says must survive
 * everything else going dark.
 *
 * ── THE CACHE STORES, IT DOES NOT DECIDE ─────────────────────────────────────
 * Every field written here is the SERVER's, copied verbatim. In particular
 * `staleAfter` is stored exactly as received and is never extended, recomputed
 * or refreshed at write time — a cache that quietly renewed the bound would
 * make an hour-old deadline read as current, which is the single failure this
 * requirement exists to prevent. Case 7 pins that, from both sides of the
 * boundary, THROUGH the cache.
 *
 * `cachedAt` is recorded for support and is NEVER used to judge freshness:
 * `bundleFreshness` compares device-now against the SERVER's `staleAfter`, and
 * measuring age from the write instead would make the badge fire late on a
 * bundle that was already old when it was stored.
 *
 * ── A FAILED READ IS NOT AN ANSWER ───────────────────────────────────────────
 * Cases 4, 5, 6 and 8: corrupt JSON, a version this build does not understand,
 * a record belonging to a different session, and an AsyncStorage that throws
 * all answer `null` — never a partial record, and never a fabricated one. The
 * caller renders `null` as "we have nothing cached", which is true; a
 * half-populated deadline object would be a time with no provenance.
 *
 * ── NO FIXED DATES ───────────────────────────────────────────────────────────
 * Every instant is built from a fixture constant and compared against an
 * explicit `nowMs`. Nothing reads the real clock.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  CACHED_DEADLINE_VERSION,
  cacheCertifiedDeadline,
  cachedDeadlineKey,
  readCachedDeadline,
} from '../layoverDeadlineCache.ts';
import { describeDeadline } from '../layoverReturnFacts.ts';
import type { LayoverOfflineBundle } from '../../../services/layover.ts';

const CERTIFIED_AT = '2026-09-08T10:00:00.000Z';
const CERTIFIED_MS = Date.parse(CERTIFIED_AT);
/** OFFLINE_BUNDLE_TTL_MIN = 15 on the server. */
const STALE_AFTER = '2026-09-08T10:15:00.000Z';
const STALE_AFTER_MS = Date.parse(STALE_AFTER);
const HARD_RETURN = '2026-09-08T13:40:00.000Z';

const BUNDLE: LayoverOfflineBundle = {
  bundleVersion: '2026.09.08-1',
  sessionId: 'sess-1',
  certifiedAt: CERTIFIED_AT,
  staleAfter: STALE_AFTER,
  certification: {
    engineVersion: '2026.09.02-3',
    feasibilityVersion: '2026.09.05-1',
    inputHash: 'a1b2c3d4e5f60718',
    computedAt: CERTIFIED_AT,
    verdict: 'tight',
    confidence: 'LOW',
    bufferPercentile: 'p90',
  },
  returnDeadline: {
    hardReturnTime: HARD_RETURN,
    hardReturnLocal: '20:40',
    returnState: 'RETURN_SOON',
    bufferMinutes: 95,
    returnReminderAt: null,
  },
  airport: {
    iataCode: 'BKK', name: 'Suvarnabhumi', city: 'Bangkok', country: 'Thailand',
    timezone: 'Asia/Bangkok', lat: 13.68, lng: 100.74, terminalInfo: null,
  },
  mapGeometry: { available: false, value: null, reason: 'no_envelope_geometry' },
  route: { available: false, value: null, reason: 'no_routing_provider' },
  flightStatus: { available: false, value: null, reason: 'no_flight_feed' },
  crewMeetingPoint: { available: false, value: null, reason: 'no_crew_storage' },
  translationPhrases: { available: false, value: null, reason: 'no_phrase_catalogue' },
  stops: [],
};

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.restoreAllMocks();
});

test('1. the certified deadline and its snapshot timestamps survive a write/read round trip', async () => {
  expect(await cacheCertifiedDeadline('sess-1', BUNDLE)).toBe(true);
  const rec = await readCachedDeadline('sess-1');

  expect(rec).not.toBeNull();
  expect(rec!.hardReturnTime).toBe(HARD_RETURN);
  expect(rec!.hardReturnLocal).toBe('20:40');
  expect(rec!.returnState).toBe('RETURN_SOON');
  expect(rec!.bufferMinutes).toBe(95);
  // The SNAPSHOT TIMESTAMPS — the half census L150 names explicitly.
  expect(rec!.certifiedAt).toBe(CERTIFIED_AT);
  expect(rec!.staleAfter).toBe(STALE_AFTER);
  expect(rec!.bundleVersion).toBe('2026.09.08-1');
});

test('2. nothing is written for an absent bundle, and a good record is not clobbered by one', async () => {
  await cacheCertifiedDeadline('sess-1', BUNDLE);
  // A later overview that arrived without a bundle must not erase the deadline
  // the traveller is relying on. An absent bundle is not a new answer.
  expect(await cacheCertifiedDeadline('sess-1', null)).toBe(false);

  const rec = await readCachedDeadline('sess-1');
  expect(rec).not.toBeNull();
  expect(rec!.hardReturnTime).toBe(HARD_RETURN);
});

test('3. a bundle missing its deadline is refused rather than stored half-built', async () => {
  const broken = { ...BUNDLE, returnDeadline: undefined } as unknown as LayoverOfflineBundle;
  expect(await cacheCertifiedDeadline('sess-1', broken)).toBe(false);
  expect(await readCachedDeadline('sess-1')).toBeNull();
});

test('4. a record stored under ANOTHER session is never served for this one', async () => {
  await cacheCertifiedDeadline('sess-1', BUNDLE);
  expect(await readCachedDeadline('sess-2')).toBeNull();

  // Belt and braces: even a record written under this session's KEY but
  // carrying another session's id is refused. The deadline is per-layover, and
  // showing one layover's return time on another is worse than showing none.
  await AsyncStorage.setItem(
    cachedDeadlineKey('sess-2'),
    JSON.stringify({ v: CACHED_DEADLINE_VERSION, sessionId: 'sess-9', certifiedAt: CERTIFIED_AT,
      staleAfter: STALE_AFTER, bundleVersion: 'x', hardReturnTime: HARD_RETURN,
      hardReturnLocal: null, returnState: 'NORMAL', bufferMinutes: 0, cachedAt: CERTIFIED_AT }),
  );
  expect(await readCachedDeadline('sess-2')).toBeNull();
});

test('5. a record from a version this build does not understand is refused, not guessed at', async () => {
  await AsyncStorage.setItem(
    cachedDeadlineKey('sess-1'),
    JSON.stringify({ v: CACHED_DEADLINE_VERSION + 1, sessionId: 'sess-1', hardReturnTime: HARD_RETURN }),
  );
  expect(await readCachedDeadline('sess-1')).toBeNull();
});

test('6. unparseable stored bytes answer null — never a partial record', async () => {
  await AsyncStorage.setItem(cachedDeadlineKey('sess-1'), '{not json');
  expect(await readCachedDeadline('sess-1')).toBeNull();
});

test('7. the cache stores the SERVER\'s staleness bound and does not extend it', async () => {
  await cacheCertifiedDeadline('sess-1', BUNDLE);
  const rec = await readCachedDeadline('sess-1');
  expect(rec!.staleAfter).toBe(STALE_AFTER);

  // AND the bound still fires THROUGH the cache, from both sides. This is the
  // assertion that stops a future "make the cached card render" change from
  // being paid for by moving the bound: a cached deadline one millisecond
  // before `staleAfter` is live, and AT it, it is not.
  const asBundle = {
    certifiedAt: rec!.certifiedAt,
    staleAfter: rec!.staleAfter,
    returnDeadline: {
      hardReturnTime: rec!.hardReturnTime,
      hardReturnLocal: rec!.hardReturnLocal,
      returnState: rec!.returnState,
      bufferMinutes: rec!.bufferMinutes,
      returnReminderAt: null,
    },
  };
  expect(describeDeadline(asBundle, HARD_RETURN, STALE_AFTER_MS - 1).standing).toBe('live');
  expect(describeDeadline(asBundle, HARD_RETURN, STALE_AFTER_MS).standing).toBe('stale');
  // And an hour later it is still not claimed live — a cached deadline is the
  // LAST CERTIFIED one, never a current one.
  const late = describeDeadline(asBundle, HARD_RETURN, CERTIFIED_MS + 60 * 60_000);
  expect(late.standing).toBe('stale');
  expect(late.stalenessNotice).toMatch(/Last certified 60 min ago/);
});

test('8. an AsyncStorage that throws answers null on read and false on write — it never fabricates', async () => {
  jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('storage unavailable'));
  expect(await readCachedDeadline('sess-1')).toBeNull();

  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('storage full'));
  expect(await cacheCertifiedDeadline('sess-1', BUNDLE)).toBe(false);
});
