import AsyncStorage from '@react-native-async-storage/async-storage';
import * as cache from '../layoverPlanCache.ts';
import type { AbortReturnRoute } from '../../services/layover.ts';
import type { LayoverOfflineBundle } from '../../services/layover.ts';
import { buildRoutedMapData } from '../layoverRoutedMap.ts';

const route: AbortReturnRoute = {
  mode: 'drive', departAt: '2026-10-19T09:00:00.000Z', minutes: 23, conservativeMinutes: 39,
  hardReturnBy: '2026-10-19T11:00:00.000Z', leaveBy: '2026-10-19T10:21:00.000Z',
  expectedAirportReturnAt: '2026-10-19T09:39:00.000Z', canMeetDeadline: true,
  confidence: 'MEDIUM', expiresAt: '2026-10-19T09:05:00.000Z', independentRoutes: 2,
  conveyances: [{ mode: 'drive', minutes: 23, interruptibility: 'interruptible', endsAt: null }],
};
beforeEach(async () => { await AsyncStorage.clear(); });
test('L151 caches the actual abort return itinerary without renewing route or plan expiry', async () => {
  await AsyncStorage.setItem(cache.cachedPlanKey('s'), JSON.stringify({
    v: cache.CACHED_PLAN_VERSION, sessionId: 's', bundleVersion: 'v', certifiedAt: route.departAt,
    staleAfter: '2026-10-19T09:01:00.000Z', airport: { iataCode: 'TPE' }, stops: [],
  }));
  expect(typeof cache.cacheAbortReturnRoute).toBe('function');
  expect(await cache.cacheAbortReturnRoute('s', route)).toBe(true);
  const saved = await cache.readCachedPlan('s');
  expect(saved?.abortReturnRoute).toEqual(route);
  expect(saved?.staleAfter).toBe('2026-10-19T09:01:00.000Z');
  expect(await cache.cacheAbortReturnRoute('s', null)).toBe(true);
  expect((await cache.readCachedPlan('s'))?.abortReturnRoute).toBeNull();
});
test('a measured abort route survives without a selected plan; malformed routes remain absent', async () => {
  expect(typeof cache.cacheAbortReturnRoute).toBe('function');
  expect(await cache.cacheAbortReturnRoute('missing', route)).toBe(true);
  expect(await cache.readCachedAbortReturnRoute('missing')).toEqual(route);
  expect(await cache.readCachedPlan('missing')).toBeNull();
  await AsyncStorage.setItem(cache.cachedPlanKey('s'), JSON.stringify({
    v: cache.CACHED_PLAN_VERSION, sessionId: 's', certifiedAt: route.departAt, staleAfter: route.expiresAt,
    airport: { iataCode: 'TPE' }, abortReturnRoute: { ...route, conservativeMinutes: null },
  }));
  expect((await cache.readCachedPlan('s'))?.abortReturnRoute).toBeNull();
});
test('return deadline and snapshot survive plan writes; unlicensed routed geometry is excluded without renewing any bound', async () => {
  const snapshotId = `snap:${'a'.repeat(32)}`;
  const data = buildRoutedMapData(snapshotId, { basis: 'routed_union', centre: { lat: 25, lng: 121 }, certifiedInward: true, certifiedOutward: false, polygonInteriorCertified: false,
    outerBound: null, windowStartsAt: route.departAt, hardReturnBy: route.hardReturnBy, usableMinutes: 120, dwellFloorMinutes: 30, confidence: 'MEDIUM', expiresAt: route.expiresAt,
    members: [], excluded: [], sectors: [{ index: 0, fromDeg: 0, toDeg: 45, reachMetres: null, vertexKey: null, measured: false }], polygon: [{ lat: 25.1, lng: 121.1 }] }, []);
  const bundle = { certifiedAt: route.departAt, staleAfter: '2026-10-19T09:01:00.000Z', bundleVersion: 'v', airport: { iataCode: 'TPE' }, stops: [] } as unknown as LayoverOfflineBundle;
  await cache.cacheAbortReturnRoute('s', route);
  await cache.cacheCertifiedPlan('s', bundle, null, null, data);
  const saved = await cache.readCachedPlan('s');
  expect(saved?.routedMap).toEqual({ ...data, envelope: null }); expect(await AsyncStorage.getItem(cache.cachedPlanKey('s'))).not.toContain('121.1');
  expect(saved?.abortReturnRoute).toEqual(route);
  expect(saved?.staleAfter).toBe(bundle.staleAfter);
  await cache.cacheCertifiedPlan('s', bundle, null, null, null);
  expect((await cache.readCachedPlan('s'))?.routedMap).toBeNull();
  expect((await cache.readCachedPlan('s'))?.abortReturnRoute).toEqual(route);
});
