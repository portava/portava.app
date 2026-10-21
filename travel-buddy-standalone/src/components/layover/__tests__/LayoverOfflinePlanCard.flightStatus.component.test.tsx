/**
 * census-layover L153 — §16 "Flight/gate: cache last confirmed values with stale
 * indicator", the CLIENT half: the bundle's `flightStatus` (the onward flight's
 * last RECORDED observation, LayoverDegradedService/LayoverDepartureFlight) is
 * kept by `layoverPlanCache` VERBATIM and drawn by the offline plan card with
 * who recorded it, when, and a stale line once the server's `staleAfter` passes.
 *
 * The REAL cache over jest's AsyncStorage mock and the REAL card.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 *   - the stale bound renewed at write time (an hour-old gate read back as fresh);
 *   - a value without its source or instant cached as an answer;
 *   - the server's "no" (`no_flight_observation`, `flight_unreadable`) dropped or
 *     reworded into a gate;
 *   - anything new drawn while the feature is off (`no_flight_feed`) or for a record
 *     written before the field existed.
 */
import assert from 'node:assert/strict';
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, screen } from '@testing-library/react-native';

import type { LayoverOfflineBundle, LayoverOfflineFlightStatus } from '../../../services/layover.ts';
import { cacheCertifiedPlan, readCachedPlan, cachedPlanKey, type CachedLayoverPlan } from '../../../lib/layoverPlanCache.ts';
import { LayoverOfflinePlanCard } from '../LayoverOfflinePlanCard.tsx';

const OBSERVED = '2026-09-22T08:20:00.000Z';
const STALE_AFTER = '2026-09-22T08:35:00.000Z';

const FLIGHT: LayoverOfflineFlightStatus = {
  designator: 'TK1', departureAirport: 'IST',
  scheduledDepartureAt: '2026-09-22T15:00:00.000Z', estimatedDepartureAt: '2026-09-22T15:40:00.000Z',
  terminal: 'I', gate: 'F4', status: 'delayed', source: 'traveller', observedAt: OBSERVED, staleAfter: STALE_AFTER,
};

function bundle(flightStatus: unknown): LayoverOfflineBundle {
  return {
    bundleVersion: '2026.09.08-1', sessionId: 'sess-1',
    certifiedAt: '2026-09-22T09:00:00.000Z', staleAfter: '2026-09-22T09:15:00.000Z',
    certification: {} as LayoverOfflineBundle['certification'],
    returnDeadline: { hardReturnTime: '2026-09-22T13:00:00.000Z', hardReturnLocal: '16:00', returnState: 'NORMAL', bufferMinutes: 170, returnReminderAt: null },
    airport: { iataCode: 'IST', name: 'Istanbul Airport', city: 'Istanbul', country: 'Türkiye', timezone: 'UTC', lat: 41.2753, lng: 28.7519, terminalInfo: null },
    mapGeometry: { available: false, value: null, reason: 'no_envelope_geometry' },
    route: { available: false, value: null, reason: 'no_routing_provider' },
    flightStatus,
    crewMeetingPoint: { available: false, value: null, reason: 'not_in_crew' },
    translationPhrases: { available: false, value: null, reason: 'plan_stays_airside' },
    stops: [],
  } as LayoverOfflineBundle;
}

beforeEach(async () => { await AsyncStorage.clear(); });

async function cachedWith(flightStatus: unknown): Promise<CachedLayoverPlan> {
  assert.equal(await cacheCertifiedPlan('sess-1', bundle(flightStatus), null), true);
  const rec = await readCachedPlan('sess-1');
  assert.ok(rec);
  return rec;
}

describe('L153 — the cache keeps the recorded flight VERBATIM', () => {
  it('an observed flight reads back field for field, the stale bound NOT renewed', async () => {
    const rec = await cachedWith({ available: true, value: FLIGHT, reason: null });
    assert.deepEqual(rec.flightStatus, { available: true, value: FLIGHT, reason: null });
  });

  it('a value missing its source, its instant or its bound is no answer', async () => {
    for (const broken of [{ ...FLIGHT, source: '' }, { ...FLIGHT, observedAt: 'yesterday' }, { ...FLIGHT, staleAfter: undefined }]) {
      const rec = await cachedWith({ available: true, value: broken, reason: null });
      assert.deepEqual(rec.flightStatus, { available: false, value: null, reason: null }, JSON.stringify(broken));
    }
  });

  it("the server's no is kept as said", async () => {
    for (const reason of ['no_flight_observation', 'flight_unreadable', 'not_linked_to_a_trip_flight', 'no_flight_feed']) {
      const rec = await cachedWith({ available: false, value: null, reason });
      assert.deepEqual(rec.flightStatus, { available: false, value: null, reason });
    }
  });

  it('a record written before the field existed reads as no answer (null)', async () => {
    await cachedWith({ available: false, value: null, reason: 'no_flight_feed' });
    const raw = JSON.parse((await AsyncStorage.getItem(cachedPlanKey('sess-1')))!);
    delete raw.flightStatus;
    await AsyncStorage.setItem(cachedPlanKey('sess-1'), JSON.stringify(raw));
    assert.equal((await readCachedPlan('sess-1'))?.flightStatus, null);
  });
});

describe('L153 — the offline card draws it, and says when it is old', () => {
  const plan = (flightStatus: CachedLayoverPlan['flightStatus']): CachedLayoverPlan => ({
    sessionId: 'sess-1', bundleVersion: '2026.09.08-1',
    certifiedAt: '2026-09-22T09:00:00.000Z', staleAfter: '2026-09-22T09:15:00.000Z',
    airport: { iataCode: 'IST', name: 'Istanbul Airport', city: 'Istanbul', timezone: 'UTC', lat: 41.2753, lng: 28.7519 },
    stops: [], envelope: null, schedule: null, crewMeetingPoint: null, translationPhrases: null,
    cachedAt: '2026-09-22T09:00:01.000Z', flightStatus,
  });

  it('within the bound: gate, terminal, status with the stated departure, and who recorded it when — no stale line', async () => {
    await render(<LayoverOfflinePlanCard nowMs={Date.parse('2026-09-22T08:30:00.000Z')} plan={plan({ available: true, value: FLIGHT, reason: null })} />);
    expect(screen.getByTestId('layover-cached-plan-flight-0').props.children).toBe('TK1: gate F4, terminal I.');
    expect(String(screen.getByTestId('layover-cached-plan-flight-1').props.children)).toMatch(/^Status: delayed — departs (15:40|0?3:40\s?PM)\.$/);
    expect(String(screen.getByTestId('layover-cached-plan-flight-2').props.children)).toMatch(/^Recorded by you at (08:20|8:20)/);
    expect(screen.queryByTestId('layover-cached-plan-flight-stale')).toBeNull();
  });

  it('past the bound: the stale line says how old, from the OBSERVATION', async () => {
    await render(<LayoverOfflinePlanCard nowMs={Date.parse('2026-09-22T09:20:00.000Z')} plan={plan({ available: true, value: FLIGHT, reason: null })} />);
    expect(screen.getByTestId('layover-cached-plan-flight-stale').props.children).toBe('Recorded 60 min ago — gates and times change; check the departure board.');
  });

  it('a feed observation says the feed recorded it', async () => {
    await render(<LayoverOfflinePlanCard nowMs={Date.parse('2026-09-22T08:30:00.000Z')} plan={plan({ available: true, value: { ...FLIGHT, source: 'feed' }, reason: null })} />);
    expect(String(screen.getByTestId('layover-cached-plan-flight-2').props.children)).toMatch(/^Recorded by the flight-status feed at/);
  });

  it('an unrecorded gate is said as not recorded, never left blank', async () => {
    await render(<LayoverOfflinePlanCard nowMs={Date.parse('2026-09-22T08:30:00.000Z')} plan={plan({ available: true, value: { ...FLIGHT, gate: null, terminal: null }, reason: null })} />);
    expect(screen.getByTestId('layover-cached-plan-flight-0').props.children).toBe('TK1: gate not recorded, terminal not recorded.');
  });

  it("nothing observed: says so, and draws no gate", async () => {
    await render(<LayoverOfflinePlanCard nowMs={Date.parse('2026-09-22T08:30:00.000Z')} plan={plan({ available: false, value: null, reason: 'no_flight_observation' })} />);
    expect(String(screen.getByTestId('layover-cached-plan-flight-none').props.children)).toMatch(/No update has been recorded for your flight/);
    expect(screen.queryByTestId('layover-cached-plan-flight')).toBeNull();
  });

  it('a failed read is said as a failed read', async () => {
    await render(<LayoverOfflinePlanCard nowMs={Date.parse('2026-09-22T08:30:00.000Z')} plan={plan({ available: false, value: null, reason: 'flight_unreadable' })} />);
    expect(String(screen.getByTestId('layover-cached-plan-flight-none').props.children)).toMatch(/could not be read/);
  });

  it('feature off (`no_flight_feed`) and an old record: nothing new is drawn', async () => {
    await render(<LayoverOfflinePlanCard nowMs={Date.parse('2026-09-22T08:30:00.000Z')} plan={plan({ available: false, value: null, reason: 'no_flight_feed' })} />);
    expect(screen.queryByTestId('layover-cached-plan-flight-none')).toBeNull();
    expect(screen.queryByTestId('layover-cached-plan-flight')).toBeNull();
    await render(<LayoverOfflinePlanCard nowMs={Date.parse('2026-09-22T08:30:00.000Z')} plan={plan(undefined)} />);
    expect(screen.queryByTestId('layover-cached-plan-flight-none')).toBeNull();
    expect(screen.queryByTestId('layover-cached-plan-flight')).toBeNull();
    expect(screen.getByTestId('layover-cached-plan')).toBeTruthy();
  });
});
