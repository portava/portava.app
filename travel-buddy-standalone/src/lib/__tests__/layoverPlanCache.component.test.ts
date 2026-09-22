/**
 * layoverPlanCache — census §16 L151 and §20 L233, the CLIENT half.
 *
 * ── WHAT THIS PINS ───────────────────────────────────────────────────────────
 * `layoverDeadlineCache` says in its own header what it deliberately does NOT
 * cache: *"Only the deadline and its certification instants. Not the plan, not
 * the map, not the envelope … §16 gives each of those its own row (L151-L155)
 * and each is a separate decision about what may be shown from a cache."*
 *
 * This is two of those decisions, made explicitly:
 *   L151  the AIRPORT and the certified AREA (the envelope's two radii). Not a
 *         route — there is no routed provider, and a cache cannot invent one.
 *   L233  the PLAN, so a traveller who lost signal after leaving still has the
 *         stops they were going to, captioned last-certified.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * The failure this file is built against is a cache that RENEWS the bound it
 * stores — writing a fresh `staleAfter` at write time turns an hour-old plan
 * into a current one, which is the single thing §16 exists to prevent. So
 * `staleAfter` is asserted byte-for-byte against what was handed in, and every
 * rejection path (no bundle, another session's record, an unknown version,
 * unparseable bytes) is asserted to answer `null` rather than a partial record.
 */
import assert from 'node:assert/strict';

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { LayoverOfflineBundle, LayoverSafeEnvelope } from '../../services/layover.ts';
import {
  CACHED_PLAN_VERSION,
  cacheCertifiedPlan,
  cachedPlanKey,
  readCachedPlan,
} from '../layoverPlanCache.ts';

/** The server's own bundle shape (LayoverDegradedService.buildOfflineBundle). */
function bundle(over: Partial<LayoverOfflineBundle> = {}): LayoverOfflineBundle {
  return {
    bundleVersion: '2026.09.08-1',
    sessionId: 'sess-1',
    certifiedAt: '2026-09-22T09:00:00.000Z',
    staleAfter: '2026-09-22T09:15:00.000Z',
    certification: {} as LayoverOfflineBundle['certification'],
    returnDeadline: {
      hardReturnTime: '2026-09-22T13:00:00.000Z',
      hardReturnLocal: '16:00',
      returnState: 'NORMAL',
      bufferMinutes: 170,
      returnReminderAt: null,
    },
    airport: {
      iataCode: 'IST',
      name: 'Istanbul Airport',
      city: 'Istanbul',
      country: 'Türkiye',
      timezone: 'Europe/Istanbul',
      lat: 41.2753,
      lng: 28.7519,
      terminalInfo: null,
    },
    mapGeometry: { available: false, value: null, reason: 'no_envelope_geometry' },
    route: { available: false, value: null, reason: 'no_routing_provider' },
    flightStatus: { available: false, value: null, reason: 'no_flight_feed' },
    crewMeetingPoint: { available: false, value: null, reason: 'no_crew_storage' },
    translationPhrases: { available: false, value: null, reason: 'no_phrase_catalogue' },
    stops: [
      { title: 'Blue Mosque', durationMin: 60, travelMin: 45, insideAirport: false },
      { title: 'Lounge', durationMin: 30, travelMin: 0, insideAirport: true },
    ],
    ...over,
  } as LayoverOfflineBundle;
}

const ENVELOPE: LayoverSafeEnvelope = {
  centre: { lat: 41.2753, lng: 28.7519 },
  radiusMetres: 42_000,
  usableMinutes: 180,
  maxOneWayMinutes: 60,
  basis: 'straight_line_lower_bound',
  certifiedOutward: true,
  certifiedInward: false,
  confidence: 'LOW',
  uncertaintyBudgetMinutes: 20,
  plannedMaxOneWayMinutes: 45,
  plannedRadiusMetres: 31_000,
};

beforeEach(async () => {
  await AsyncStorage.clear();
});

// Run under jest (not the node:test runner) because the module under test
// writes through AsyncStorage, whose native module is null outside jest-expo —
// jest.config.js maps it to the official in-memory mock. `assert/strict` is
// kept for the assertions themselves so the failure messages name the field.

test('a written plan reads back with the server bound VERBATIM', async () => {
  const b = bundle();
  assert.equal(await cacheCertifiedPlan('sess-1', b, ENVELOPE), true);

  const rec = await readCachedPlan('sess-1');
  assert.ok(rec);
  // THE LOAD-BEARING ASSERTION: not extended, not renewed, not recomputed.
  assert.equal(rec.staleAfter, b.staleAfter);
  assert.equal(rec.certifiedAt, b.certifiedAt);
  assert.equal(rec.bundleVersion, b.bundleVersion);
  assert.equal(rec.airport.iataCode, 'IST');
  assert.equal(rec.airport.timezone, 'Europe/Istanbul');
  assert.deepEqual(rec.stops.map((s) => s.title), ['Blue Mosque', 'Lounge']);
  assert.equal(rec.stops[1]?.insideAirport, true);
  // L151's AREA half: the certified radii, both of them, and nothing derived.
  assert.equal(rec.envelope?.radiusMetres, 42_000);
  assert.equal(rec.envelope?.plannedRadiusMetres, 31_000);
  assert.equal(rec.envelope?.usableMinutes, 180);
});

test('a plan with NO stops is a real answer and is stored as one', async () => {
  assert.equal(await cacheCertifiedPlan('sess-1', bundle({ stops: [] }), null), true);
  const rec = await readCachedPlan('sess-1');
  assert.ok(rec);
  assert.deepEqual(rec.stops, []);
  // No envelope was published for this airport; the absence is stored as an
  // absence and never as a zero-radius disc, which would block everything.
  assert.equal(rec.envelope, null);
});

test('no bundle writes NOTHING and leaves an existing record standing', async () => {
  await cacheCertifiedPlan('sess-1', bundle(), ENVELOPE);
  assert.equal(await cacheCertifiedPlan('sess-1', null, ENVELOPE), false);
  assert.equal(await cacheCertifiedPlan('sess-1', undefined, ENVELOPE), false);

  const rec = await readCachedPlan('sess-1');
  // A response that said nothing about the plan is not a reason to take the
  // traveller's last one away.
  assert.ok(rec);
  assert.equal(rec.stops.length, 2);
});

test('another session’s record is never served', async () => {
  await cacheCertifiedPlan('sess-1', bundle(), ENVELOPE);
  const raw = await AsyncStorage.getItem(cachedPlanKey('sess-1'));
  assert.ok(raw);
  await AsyncStorage.setItem(cachedPlanKey('sess-2'), raw);
  assert.equal(await readCachedPlan('sess-2'), null);
});

test('an unknown stored version, and junk bytes, both read as nothing cached', async () => {
  await AsyncStorage.setItem(
    cachedPlanKey('sess-1'),
    JSON.stringify({ v: CACHED_PLAN_VERSION + 1, sessionId: 'sess-1' }),
  );
  assert.equal(await readCachedPlan('sess-1'), null);

  await AsyncStorage.setItem(cachedPlanKey('sess-1'), '{not json');
  assert.equal(await readCachedPlan('sess-1'), null);
});

test('a bundle without certification instants is refused rather than half-stored', async () => {
  assert.equal(
    await cacheCertifiedPlan('sess-1', bundle({ certifiedAt: '' }), ENVELOPE),
    false,
  );
  assert.equal(await readCachedPlan('sess-1'), null);
});
